// SPDX-License-Identifier: Apache-2.0
// createRateLimiter — the reusable limiter factory. Drives
// the in-memory store (RateLimiterMemory) by injecting NO redis client, so the
// suite proves the per-user / per-IP / 429+Retry-After / fail-open contract with
// NO real Redis (CI parity). A fake limiter (injected via the redis seam) covers
// the store-failure fail-open path deterministically.
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRateLimiter,
  ipKey,
  type RateLimiterMiddleware,
  userIdKey,
} from '../src/middleware/rate-limit.js'

const storeFailureAdd = vi.fn()
vi.mock('@3ngram/config', () => ({
  log: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
  rateLimitStoreFailure: { add: (...args: unknown[]) => storeFailureAdd(...args) },
}))

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value
      return this
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as unknown as Response & {
    statusCode: number
    body: unknown
    headers: Record<string, string>
  }
}

const reqWith = (props: Partial<Request>): Request => props as Request

/** Run the middleware and resolve after the limiter's async consume settles. */
async function invoke(
  middleware: RateLimiterMiddleware,
  req: Request,
): Promise<{ res: ReturnType<typeof mockRes>; next: ReturnType<typeof vi.fn> }> {
  const res = mockRes()
  const next = vi.fn()
  middleware(req, res, next as unknown as NextFunction)
  // consume() settles on a microtask chain; a macrotask turn drains it fully
  // (the store-failure path rejects a level deeper than a few microtasks).
  await new Promise((resolve) => setImmediate(resolve))
  return { res, next }
}

afterEach(() => vi.clearAllMocks())

describe('createRateLimiter — per-user bucket', () => {
  it('allows up to `points` requests then 429s the next with Retry-After', async () => {
    const limiter = createRateLimiter({
      points: 2,
      duration: 60,
      keyPrefix: 'mcp:user',
      keyResolver: userIdKey,
    })
    const req = reqWith({ userId: 'user-a' })

    const first = await invoke(limiter, req)
    const second = await invoke(limiter, req)
    expect(first.next).toHaveBeenCalledTimes(1)
    expect(second.next).toHaveBeenCalledTimes(1)
    expect(first.res.statusCode).toBe(0)
    expect(second.res.statusCode).toBe(0)

    const third = await invoke(limiter, req)
    expect(third.next).not.toHaveBeenCalled()
    expect(third.res.statusCode).toBe(429)
    expect(third.res.body).toEqual({ error: 'rate_limited' })
    expect(Number(third.res.headers['Retry-After'])).toBeGreaterThan(0)
  })

  it('keys per principal: a second user has an INDEPENDENT bucket', async () => {
    const limiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'mcp:user',
      keyResolver: userIdKey,
    })
    // user-a exhausts its single point...
    await invoke(limiter, reqWith({ userId: 'user-a' }))
    const aOverLimit = await invoke(limiter, reqWith({ userId: 'user-a' }))
    expect(aOverLimit.res.statusCode).toBe(429)
    // ...user-b is untouched.
    const bFirst = await invoke(limiter, reqWith({ userId: 'user-b' }))
    expect(bFirst.next).toHaveBeenCalledTimes(1)
    expect(bFirst.res.statusCode).toBe(0)
  })

  it('does NOT limit a request with no resolvable key (identity not yet bound)', async () => {
    const limiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'mcp:user',
      keyResolver: userIdKey,
    })
    const { res, next } = await invoke(limiter, reqWith({ userId: undefined }))
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(0)
  })
})

describe('createRateLimiter — per-IP bucket', () => {
  it('keys on req.ip and 429s after the limit', async () => {
    const limiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'auth:ip',
      keyResolver: ipKey,
    })
    const req = reqWith({ ip: '203.0.113.7' })
    const first = await invoke(limiter, req)
    expect(first.next).toHaveBeenCalledTimes(1)
    const second = await invoke(limiter, req)
    expect(second.res.statusCode).toBe(429)
    // A different IP is independent.
    const other = await invoke(limiter, reqWith({ ip: '203.0.113.8' }))
    expect(other.next).toHaveBeenCalledTimes(1)
  })

  it('independent keyPrefix buckets do not collide for the same raw key', async () => {
    const userLimiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'mcp:user',
      keyResolver: () => 'shared-id',
    })
    const ipLimiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'auth:ip',
      keyResolver: () => 'shared-id',
    })
    // Exhausting one prefix's bucket leaves the other prefix's bucket intact.
    await invoke(userLimiter, reqWith({}))
    const userOver = await invoke(userLimiter, reqWith({}))
    expect(userOver.res.statusCode).toBe(429)
    const ipFresh = await invoke(ipLimiter, reqWith({}))
    expect(ipFresh.next).toHaveBeenCalledTimes(1)
  })
})

describe('createRateLimiter — store failure (Redis-down)', () => {
  // A fake ioredis client that is NEVER ready: RateLimiterRedis gates every
  // consume on `client.status === 'ready'` and otherwise rejects with a
  // non-RateLimiterRes Error ('Redis connection is not ready') — the same shape a
  // real Redis-down outage produces, which the middleware must discriminate from
  // a real over-limit (the latter carries msBeforeNext).
  function failingRedis() {
    return {
      status: 'connecting',
      defineCommand: () => undefined,
    } as unknown as import('ioredis').Redis
  }

  it('FAILS OPEN by default: a store error calls next() (availability over protection)', async () => {
    const limiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'mcp:user',
      keyResolver: userIdKey,
      redis: failingRedis(),
    })
    const { res, next } = await invoke(limiter, reqWith({ userId: 'user-a' }))
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(0)
  })

  it('EMITS the store-failure metric on a store error so a fail-open outage is observable', async () => {
    const limiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'auth:ip',
      keyResolver: ipKey,
      redis: failingRedis(),
    })
    const { next } = await invoke(limiter, reqWith({ ip: '203.0.113.7' }))
    // fail-open still lets the request through...
    expect(next).toHaveBeenCalledTimes(1)
    // ...AND the counter fired with the route-class label (no secrets, no key).
    expect(storeFailureAdd).toHaveBeenCalledTimes(1)
    expect(storeFailureAdd).toHaveBeenCalledWith(1, { key_prefix: 'auth:ip', fail_open: true })
  })

  it('does NOT emit the metric on a real over-limit rejection (only on store failure)', async () => {
    const limiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'auth:ip',
      keyResolver: ipKey,
    })
    const req = reqWith({ ip: '203.0.113.9' })
    await invoke(limiter, req)
    const over = await invoke(limiter, req)
    expect(over.res.statusCode).toBe(429)
    expect(storeFailureAdd).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED when failOpen:false: a store error yields 503, not a pass', async () => {
    const limiter = createRateLimiter({
      points: 1,
      duration: 60,
      keyPrefix: 'mcp:user',
      keyResolver: userIdKey,
      redis: failingRedis(),
      failOpen: false,
    })
    const { res, next } = await invoke(limiter, reqWith({ userId: 'user-a' }))
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'service_unavailable' })
    // The outage is still observable even when failing closed.
    expect(storeFailureAdd).toHaveBeenCalledWith(1, { key_prefix: 'mcp:user', fail_open: false })
  })
})
