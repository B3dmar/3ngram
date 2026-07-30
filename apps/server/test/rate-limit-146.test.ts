// SPDX-License-Identifier: Apache-2.0
// Per-key /api/* rate limiting and progressive-delay failure tracker.
//
// (a) Per-key limiter wiring: rateLimiter option on RestRouterOptions is
//     invoked for /api/v1 requests before apiOrSessionAuth (the cheap-first-gate
//     rule). Tested by mounting restRouter directly (avoids the full app context).
// (b) req.apiKeyId is set by apiKeyAuth from a valid `3ng_<prefix>_<secret>` key.
// (c) Progressive delay: calling recordExchangeFailure N times increments the
//     Redis-backed counter (INCR + EXPIRE), shared across instances.
// (d) Successful exchange clears the counter via clearExchangeFailures.
//
// The failure tracker is exercised against an injected ioredis-mock client
// (setExchangeFailureRedis) so the Redis path is covered with NO real Redis,
// matching the rate-limiter's "no real Redis in CI" contract.
import type { Server } from 'node:http'
import { contentDigest, runWithContext } from '@3ngram/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { Redis } from 'ioredis'
import RedisMock from 'ioredis-mock'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiKeyIdKey, createRateLimiter } from '../src/middleware/rate-limit.js'

// ---------------------------------------------------------------------------
// (b) req.apiKeyId is set by apiKeyAuth from a valid key
// Mocks @3ngram/core/auth for the api-key middleware tests only.
// ---------------------------------------------------------------------------

const authenticateApiKey = vi.fn<(key: string) => Promise<string | undefined>>()
const touchApiKeyLastUsed = vi.fn<(userId: string, key: string) => Promise<void>>()
vi.mock('@3ngram/core/auth', () => ({ authenticateApiKey, touchApiKeyLastUsed }))

const { apiKeyAuth } = await import('../src/middleware/api-key.js')

// Top-level import of the progressive-delay tracker exports so they are
// available across all describe blocks without a nested await.
const {
  recordExchangeFailure,
  clearExchangeFailures,
  applyProgressiveDelay,
  setExchangeFailureRedis,
  _exchangeFailures,
} = await import('../src/routes/oauth-token.js')

// The Redis key prefix the tracker uses; the tests inspect the mock directly.
const FAILURE_KEY_PREFIX = 'oauth:exchange-failure:'
const failureKey = (clientId: string): string => `${FAILURE_KEY_PREFIX}${contentDigest(clientId)}`

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; body: unknown }
}

const reqWith = (apiKey?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'x-api-key' ? apiKey : undefined),
  }) as unknown as Request

async function runApiKeyAuth(req: Request, res: Response): Promise<ReturnType<typeof vi.fn>> {
  const next = vi.fn()
  runWithContext({ requestId: 'test', surface: 'rest' }, () => {
    apiKeyAuth(req, res, next as unknown as NextFunction)
  })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return next
}

afterEach(() => {
  vi.clearAllMocks()
  // Detach any injected failure-tracker Redis client left by a test so a stray
  // module-level binding cannot leak into another describe block.
  setExchangeFailureRedis(undefined)
})

// ---------------------------------------------------------------------------
// (b) req.apiKeyId binding
// ---------------------------------------------------------------------------

describe('apiKeyAuth — req.apiKeyId binding (Part A, #146)', () => {
  it('sets req.apiKeyId to the prefix segment for a valid 3ng_<prefix>_<secret> key', async () => {
    authenticateApiKey.mockResolvedValue('11111111-1111-1111-1111-111111111111')
    touchApiKeyLastUsed.mockResolvedValue()
    const req = reqWith('3ng_mypfx_somesecret')
    await runApiKeyAuth(req, mockRes())
    expect(req.apiKeyId).toBe('mypfx')
  })

  it('sets req.apiKeyId to the prefix segment for a key with a multi-segment secret', async () => {
    authenticateApiKey.mockResolvedValue('22222222-2222-2222-2222-222222222222')
    touchApiKeyLastUsed.mockResolvedValue()
    const req = reqWith('3ng_abc_secret_extra')
    await runApiKeyAuth(req, mockRes())
    expect(req.apiKeyId).toBe('abc')
  })

  it('leaves req.apiKeyId undefined for a malformed key (fewer than 3 segments)', async () => {
    authenticateApiKey.mockResolvedValue('33333333-3333-3333-3333-333333333333')
    touchApiKeyLastUsed.mockResolvedValue()
    const req = reqWith('3ng_nosecretsegment')
    const next = await runApiKeyAuth(req, mockRes())
    // The route still proceeds — userId is bound, apiKeyId is not.
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.userId).toBe('33333333-3333-3333-3333-333333333333')
    expect(req.apiKeyId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// (a) rateLimiter on RestRouterOptions is invoked for /api/v1 requests.
// Mounts restRouter directly on a minimal express app to test the ordering
// contract: rateLimiter fires BEFORE apiOrSessionAuth.
// ---------------------------------------------------------------------------

describe('/api/v1 per-key rate limiter wiring (Part A, #146)', () => {
  let server: Server
  let baseUrl: string
  const apiKeyLimiterCalls = vi.fn()

  // Default: auth returns undefined (unknown key) → 401. Individual tests can
  // override to a resolved userId to reach the downstream route handler.
  beforeEach(() => {
    authenticateApiKey.mockResolvedValue(undefined)
    touchApiKeyLastUsed.mockResolvedValue(undefined)
  })

  beforeAll(async () => {
    const { restRouter } = await import('../src/rest/router.js')
    const { requestContext } = await import('../src/middleware/request-context.js')

    // Per-key limiter: 1 req/60s so the second call is throttled.
    // Uses apiKeyIdKey which reads the raw X-API-Key header prefix so the
    // bucket fires before auth (the cheap-first-gate contract).
    const inner = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'test:api:key146',
      keyResolver: apiKeyIdKey,
    })
    const rateLimiter = (
      req: Parameters<typeof inner>[0],
      res: Parameters<typeof inner>[1],
      next: Parameters<typeof inner>[2],
    ): void => {
      apiKeyLimiterCalls()
      inner(req, res, next)
    }

    const app = express()
    app.use(requestContext)
    app.use(express.json())
    app.use(restRouter({ gateway: undefined, rateLimiter }))
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: 'internal_error' })
    })

    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err === undefined ? resolve() : reject(err)))
    })
  })

  it('invokes the rateLimiter middleware for /api/v1 requests', async () => {
    // The request will 401 (no valid api key) — that is fine. We only assert
    // the limiter ran, which proves the mounting order is correct.
    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { 'x-api-key': '3ng_test_secret' },
    })
    // Auth gate: 401 or 503 depending on mock state — not a 500.
    expect(res.status).not.toBe(500)
    expect(apiKeyLimiterCalls).toHaveBeenCalled()
  })

  it('429s the second /api/v1 request when the per-key bucket is exhausted', async () => {
    // Set req.apiKeyId so the limiter can key on it.
    // The api-key mock resolves the same prefix so both requests share a bucket.
    authenticateApiKey.mockResolvedValue('44444444-4444-4444-4444-444444444444')
    touchApiKeyLastUsed.mockResolvedValue()
    const headers = { 'x-api-key': '3ng_bucket_secret' }
    const first = await fetch(`${baseUrl}/api/v1/me`, { headers })
    // First request hits the limiter (1 point) — passes through to auth (401).
    expect(first.status).not.toBe(429)
    const second = await fetch(`${baseUrl}/api/v1/me`, { headers })
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await second.json()).toEqual({ error: 'rate_limited' })
  })
})

// ---------------------------------------------------------------------------
// (c) + (d) Progressive delay failure tracker (Part B; Redis-backed)
//
// The tracker now keeps its counter in Redis (INCR + EXPIRE keyed
// `oauth:exchange-failure:{client_id}`) so the failure budget is shared across
// Railway replicas. Every test injects a fresh ioredis-mock client via
// setExchangeFailureRedis and inspects the mock's keyspace directly — no real
// Redis is required (mirroring rate-limit.ts's "no real Redis in CI" contract).
// ---------------------------------------------------------------------------

describe('progressive-delay failure tracker (Part B, #146; Redis-backed #246)', () => {
  // The reset TTL the tracker stamps on every recorded failure (15 minutes).
  const RESET_TTL_SECONDS = 900
  let redis: Redis

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis
    setExchangeFailureRedis(redis)
  })

  it('recordExchangeFailure INCRs the Redis counter for each call', async () => {
    await recordExchangeFailure('cl_test')
    expect(await redis.get(failureKey('cl_test'))).toBe('1')
    await recordExchangeFailure('cl_test')
    expect(await redis.get(failureKey('cl_test'))).toBe('2')
    await recordExchangeFailure('cl_test')
    expect(await redis.get(failureKey('cl_test'))).toBe('3')
  })

  it('recordExchangeFailure stamps the reset TTL on the counter (replaces the FIFO cap)', async () => {
    // The TTL is what bounds memory across attacker-enumerated client_ids now
    // that the per-process 10k FIFO cap is gone: Redis reclaims idle keys on
    // expiry. Asserting the TTL is set is the load-bearing eviction guarantee.
    await recordExchangeFailure('cl_ttl')
    expect(await redis.ttl(failureKey('cl_ttl'))).toBe(RESET_TTL_SECONDS)
    // A subsequent failure refreshes the window (sliding reset).
    await recordExchangeFailure('cl_ttl')
    expect(await redis.ttl(failureKey('cl_ttl'))).toBe(RESET_TTL_SECONDS)
  })

  it('sets BOTH the counter and a TTL atomically in one recorded failure (#279 P2)', async () => {
    // The INCR + EXPIRE run in a single MULTI/EXEC, so a recorded failure leaves
    // the key with BOTH its incremented count AND a positive TTL — never a
    // TTL-less key that would defeat the bounded-growth guarantee. A single call
    // is enough to observe both effects together.
    await recordExchangeFailure('cl_atomic')
    expect(await redis.get(failureKey('cl_atomic'))).toBe('1')
    expect(await redis.ttl(failureKey('cl_atomic'))).toBeGreaterThan(0)
  })

  it('issues INCR+EXPIRE through a single MULTI/EXEC pipeline (#279 P2)', async () => {
    // Spy on multi() to prove the two commands are queued on ONE transaction and
    // committed by a single exec() — the atomic shape that keeps the EXPIRE from
    // ever being dropped between two separate round-trips.
    const incr = vi.fn().mockReturnThis()
    const expire = vi.fn().mockReturnThis()
    const exec = vi.fn().mockResolvedValue([
      [null, 1],
      [null, 1],
    ])
    const pipeline = { incr, expire, exec }
    const multi = vi.fn().mockReturnValue(pipeline)
    setExchangeFailureRedis({ multi } as unknown as Redis)

    await recordExchangeFailure('cl_pipeline')

    expect(multi).toHaveBeenCalledTimes(1)
    expect(incr).toHaveBeenCalledWith(failureKey('cl_pipeline'))
    expect(expire).toHaveBeenCalledWith(failureKey('cl_pipeline'), RESET_TTL_SECONDS)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('fails open (swallows) when a MULTI/EXEC command reports an error (#279 P2)', async () => {
    // A per-command error in the exec() result must be treated as a record
    // failure: swallowed, never thrown, so the token endpoint stays up.
    const exec = vi.fn().mockResolvedValue([
      [null, 1],
      [new Error('EXPIRE failed'), null],
    ])
    const pipeline = {
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec,
    }
    setExchangeFailureRedis({ multi: vi.fn().mockReturnValue(pipeline) } as unknown as Redis)
    await expect(recordExchangeFailure('cl_exec_err')).resolves.toBeUndefined()
  })

  it('the counter expires after the reset TTL, forgiving an idle client', async () => {
    // Drive the mock's TTL clock forward to prove the key is reclaimed: a client
    // that stops failing for the window recovers with no successful exchange.
    vi.useFakeTimers()
    try {
      await recordExchangeFailure('cl_expire')
      expect(await redis.get(failureKey('cl_expire'))).toBe('1')
      vi.advanceTimersByTime((RESET_TTL_SECONDS + 1) * 1000)
      expect(await redis.get(failureKey('cl_expire'))).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clearExchangeFailures deletes the counter so subsequent reads return null', async () => {
    await recordExchangeFailure('cl_clear')
    await recordExchangeFailure('cl_clear')
    expect(await redis.get(failureKey('cl_clear'))).toBe('2')
    await clearExchangeFailures('cl_clear')
    expect(await redis.get(failureKey('cl_clear'))).toBeNull()
  })

  it('applyProgressiveDelay returns immediately when count is below DELAY_THRESHOLD', async () => {
    // No failures recorded — count is 0, below threshold of 3.
    const start = Date.now()
    await applyProgressiveDelay('cl_fresh')
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('applyProgressiveDelay returns immediately with 2 failures (still below threshold)', async () => {
    await recordExchangeFailure('cl_two')
    await recordExchangeFailure('cl_two')
    const start = Date.now()
    await applyProgressiveDelay('cl_two')
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('applyProgressiveDelay delays after DELAY_THRESHOLD failures are reached', async () => {
    // Record against the mock with REAL timers (the mock's promise resolution
    // does not need timer advancement), then switch to fake timers to assert the
    // setTimeout-based backoff without waiting a real second.
    await recordExchangeFailure('cl_delay')
    await recordExchangeFailure('cl_delay')
    await recordExchangeFailure('cl_delay') // count = 3 = DELAY_THRESHOLD
    vi.useFakeTimers()
    try {
      // At count=3: ms = min(1000 * 2^(3-3), 8000) = 1000ms
      let resolved = false
      const p = applyProgressiveDelay('cl_delay').then(() => {
        resolved = true
      })
      // Let the awaited Redis GET settle (microtasks) before asserting the timer
      // is still pending.
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      await p
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counters are independent per clientId', async () => {
    await recordExchangeFailure('cl_a')
    await recordExchangeFailure('cl_b')
    await recordExchangeFailure('cl_b')
    expect(await redis.get(failureKey('cl_a'))).toBe('1')
    expect(await redis.get(failureKey('cl_b'))).toBe('2')
    await clearExchangeFailures('cl_a')
    expect(await redis.get(failureKey('cl_a'))).toBeNull()
    expect(await redis.get(failureKey('cl_b'))).toBe('2')
  })

  it('shares the failure budget across instances via the same Redis keyspace (#246)', async () => {
    // Simulate two replicas: each gets its own tracker binding but the SAME
    // backing store. Failures recorded "on replica A" must be visible to the
    // delay decision "on replica B" — the cross-replica budget the migration buys.
    const replicaA = redis
    const replicaB = redis // same keyspace, distinct logical instance
    setExchangeFailureRedis(replicaA)
    await recordExchangeFailure('cl_shared')
    await recordExchangeFailure('cl_shared')
    setExchangeFailureRedis(replicaB)
    await recordExchangeFailure('cl_shared') // count now 3 across both
    expect(await replicaB.get(failureKey('cl_shared'))).toBe('3')
  })

  it('fails open when the Redis client errors (delay lapses, never throws)', async () => {
    // A store outage must not take down the token endpoint: record/clear swallow
    // the error and applyProgressiveDelay treats it as no recorded failures.
    const failing = {
      // recordExchangeFailure now goes through MULTI/EXEC: a rejected exec()
      // (connection drop) must be swallowed exactly like the old single-command
      // rejection — the protective control fails open, never throwing.
      multi: vi.fn().mockReturnValue({
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }),
      del: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as Redis
    setExchangeFailureRedis(failing)
    await expect(recordExchangeFailure('cl_down')).resolves.toBeUndefined()
    await expect(clearExchangeFailures('cl_down')).resolves.toBeUndefined()
    const start = Date.now()
    await applyProgressiveDelay('cl_down')
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('falls back to a per-process counter when no Redis client is injected', async () => {
    // Single-instance / CI parity: with no client the tracker uses the in-process
    // Map and the same INCR/clear/delay semantics still hold.
    setExchangeFailureRedis(undefined)
    await recordExchangeFailure('cl_mem')
    await recordExchangeFailure('cl_mem')
    await recordExchangeFailure('cl_mem')
    vi.useFakeTimers()
    try {
      let resolved = false
      const p = applyProgressiveDelay('cl_mem').then(() => {
        resolved = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      await p
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
    await clearExchangeFailures('cl_mem')
    const start = Date.now()
    await applyProgressiveDelay('cl_mem')
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('caps the in-process Map fallback at EXCHANGE_FAILURES_MAX with FIFO eviction', async () => {
    // No-Redis DoS bound: the Map has no TTL, so an attacker enumerating
    // schema-valid client_ids must not grow it without bound. At the 10k cap a
    // new client_id evicts the oldest insertion; the Map size stays pinned.
    setExchangeFailureRedis(undefined)
    _exchangeFailures.clear()
    const max = 10_000
    for (let i = 0; i < max; i++) {
      await recordExchangeFailure(`cl_cap_${i}`)
    }
    expect(_exchangeFailures.size).toBe(max)
    expect(_exchangeFailures.has(contentDigest('cl_cap_0'))).toBe(true)
    // One more distinct client_id evicts the oldest (cl_cap_0) and stays at cap.
    await recordExchangeFailure('cl_cap_overflow')
    expect(_exchangeFailures.size).toBe(max)
    expect(_exchangeFailures.has(contentDigest('cl_cap_0'))).toBe(false)
    expect(_exchangeFailures.has(contentDigest('cl_cap_overflow'))).toBe(true)
    // An EXISTING client_id only increments — no eviction, no size change.
    await recordExchangeFailure('cl_cap_overflow')
    expect(_exchangeFailures.size).toBe(max)
    expect(_exchangeFailures.get(contentDigest('cl_cap_overflow'))).toBe(2)
    _exchangeFailures.clear()
  })
})
