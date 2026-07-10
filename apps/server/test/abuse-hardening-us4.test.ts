// SPDX-License-Identifier: Apache-2.0
// The public auth surface resists enumeration and
// abuse now that it is public.
//
// Enumeration + timing uniformity: a REGISTERED and an UNREGISTERED email
// are indistinguishable at /auth/signup and /auth/forgot-password in status,
// body, AND latency. The routes respond the neutral 2xx FIRST and run all
// account-dependent work (the mint + send) fire-and-forget OFF the response
// path, so a known account cannot respond measurably slower than an unknown one.
// Core is mocked so "registered" vs "unregistered" is the mint returning a token
// vs undefined — the exact discriminator an enumeration attacker would probe.
//
// Per-endpoint thresholds: each public endpoint is guarded by its
// OWN per-IP bucket carrying the threshold (signup 5/min, resend 3/min,
// verify-email 10/min, forgot-password 3/min, reset-password 5/min) and returns
// the generic { error: 'rate_limited' } 429 once exhausted. This drives the REAL
// createRateLimiter (in-memory, no Redis) the app factory wires by default — it
// does NOT inject pass-through limiters — so it proves the wiring AND the numbers.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the mailer so no real SMTP is touched; the fire-and-forget delivery is a
// no-op here (these cases care about the response contract, not delivery).
const sendResetEmail = vi.fn(async () => ({ delivered: true as const, messageId: '<id@test>' }))
const sendVerificationEmail = vi.fn(async () => ({
  delivered: true as const,
  messageId: '<verify@test>',
}))
vi.mock('../src/mailer.js', () => ({
  sendResetEmail: (...args: unknown[]) => sendResetEmail(...(args as [string, string])),
  sendVerificationEmail: (...args: unknown[]) =>
    sendVerificationEmail(...(args as [string, string])),
}))

// Mock core's mints: "registered" ⇒ returns a token, "unregistered" ⇒ undefined.
const requestSignup = vi.fn(
  async (_e: string, _p: string, _h: string, _t: number) => undefined as string | undefined,
)
const requestPasswordReset = vi.fn(
  async (_e: string, _t: number) => undefined as string | undefined,
)
vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  return {
    ...actual,
    requestSignup: (e: string, p: string, h: string, t: number) => requestSignup(e, p, h, t),
    requestPasswordReset: (e: string, t: number) => requestPasswordReset(e, t),
  }
})

interface Harness {
  server: Server
  baseUrl: string
}

// Build the app with the FACTORY-DEFAULT limiters (no pass-through override) so
// the real per-endpoint buckets are exercised. With no `redis`, createRateLimiter
// falls back to RateLimiterMemory — no real Redis required (CI parity).
async function startApp(): Promise<Harness> {
  resetEnvCache()
  const { createApp } = await import('../src/app.js')
  const server = createApp({}).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function stopApp(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
}

const JSON_HEADERS = { 'content-type': 'application/json' }
const CLIENT_PROOF_HASH = 'a'.repeat(64)
let current: Harness | undefined

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AUTH_SIGNUP_ENABLED = 'true'
  process.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES = '1440'
  process.env.RESET_TOKEN_TTL_MINUTES = '60'
  process.env.SESSION_TTL_HOURS = '12'
  process.env.SMTP_HOST = 'smtp.3ngram.test'
  process.env.SMTP_FROM = 'no-reply@3ngram.test'
  process.env.WEB_APP_URL = 'https://app.3ngram.test'
})

afterEach(async () => {
  if (current !== undefined) {
    await stopApp(current)
    current = undefined
  }
  delete process.env.AUTH_SIGNUP_ENABLED
  delete process.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES
  delete process.env.RESET_TOKEN_TTL_MINUTES
  delete process.env.SESSION_TTL_HOURS
  delete process.env.SMTP_HOST
  delete process.env.SMTP_FROM
  delete process.env.WEB_APP_URL
  vi.restoreAllMocks()
  resetEnvCache()
})

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  if (current === undefined) throw new Error('expected app harness')
  const res = await fetch(`${current.baseUrl}${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

// ---------------------------------------------------------------------------
// Enumeration + timing uniformity
// ---------------------------------------------------------------------------

describe('T026 [US4] /auth/signup is enumeration- and timing-uniform', () => {
  it('returns an identical status + body for a registered vs unregistered email', async () => {
    current = await startApp()

    // "Unregistered" ⇒ the new-account path mints a token.
    requestSignup.mockResolvedValueOnce('fresh-token')
    const unregistered = await post('/auth/signup', {
      email: 'new@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    // "Registered + verified" ⇒ the duplicate path mints NOTHING (undefined).
    requestSignup.mockResolvedValueOnce(undefined)
    const registered = await post('/auth/signup', {
      email: 'existing@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(registered.status).toBe(unregistered.status)
    expect(registered.status).toBe(202)
    expect(registered.json).toEqual(unregistered.json)
    expect(registered.json).toEqual({ status: 'verification_sent' })
  })

  it('responds with the SAME latency whether the account exists (mint is off the response path)', async () => {
    current = await startApp()

    // A registered account would do extra mint+insert work; gate that work behind
    // a barrier. If the route AWAITED the mint, the fetch would block on it and
    // the latency would diverge. Because the route responds 202 FIRST, the
    // registered request returns before the barrier is released — proving timing
    // cannot distinguish the two. An unregistered email mints nothing.
    let releaseMint: () => void = () => {}
    const mintBarrier = new Promise<void>((resolve) => {
      releaseMint = resolve
    })
    requestSignup.mockImplementationOnce(async () => {
      await mintBarrier
      return 'fresh-token'
    })

    const registered = await post('/auth/signup', {
      email: 'existing@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })
    // The 202 came back with the mint still pending — delivery has not run.
    expect(registered.status).toBe(202)
    expect(sendVerificationEmail).not.toHaveBeenCalled()

    releaseMint()
    await flushMicrotasks()
  })
})

describe('T026 [US4] /auth/forgot-password is enumeration- and timing-uniform', () => {
  it('returns an identical status + body for a registered vs unregistered email', async () => {
    current = await startApp()

    requestPasswordReset.mockResolvedValueOnce('reset-token')
    const registered = await post('/auth/forgot-password', { email: 'real@example.test' })

    requestPasswordReset.mockResolvedValueOnce(undefined)
    const unregistered = await post('/auth/forgot-password', { email: 'nobody@example.test' })

    expect(registered.status).toBe(unregistered.status)
    expect(registered.status).toBe(200)
    expect(registered.json).toEqual(unregistered.json)
    expect(registered.json).toEqual({ status: 'ok' })
  })

  it('responds 200 with the mint off the response path (no timing oracle)', async () => {
    current = await startApp()

    let releaseMint: () => void = () => {}
    const mintBarrier = new Promise<void>((resolve) => {
      releaseMint = resolve
    })
    requestPasswordReset.mockImplementationOnce(async () => {
      await mintBarrier
      return 'reset-token'
    })

    const registered = await post('/auth/forgot-password', { email: 'real@example.test' })
    expect(registered.status).toBe(200)
    expect(sendResetEmail).not.toHaveBeenCalled()

    releaseMint()
    await flushMicrotasks()
  })
})

// ---------------------------------------------------------------------------
// Per-endpoint thresholds, generic throttle response
// ---------------------------------------------------------------------------

const CASES: ReadonlyArray<{
  name: string
  path: string
  limit: number
  body: () => unknown
}> = [
  {
    name: 'signup',
    path: '/auth/signup',
    limit: 5,
    body: () => ({
      email: `signup-${Math.random()}@example.test`,
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    }),
  },
  {
    name: 'resend-verification',
    path: '/auth/resend-verification',
    limit: 3,
    body: () => ({
      email: `resend-${Math.random()}@example.test`,
      clientProofHash: CLIENT_PROOF_HASH,
    }),
  },
  {
    name: 'verify-email',
    path: '/auth/verify-email',
    limit: 10,
    body: () => ({ token: 'some-token', clientProof: 'some-proof' }),
  },
  {
    name: 'forgot-password',
    path: '/auth/forgot-password',
    limit: 3,
    body: () => ({ email: `forgot-${Math.random()}@example.test` }),
  },
  {
    name: 'reset-password',
    path: '/auth/reset-password',
    limit: 5,
    body: () => ({ token: 'some-token', newPassword: 'a-brand-new-password' }),
  },
]

describe('T028 [US4] FR-017 per-endpoint rate limits return a generic 429', () => {
  for (const c of CASES) {
    it(`throttles /auth/${c.name} after ${c.limit} requests from one IP`, async () => {
      current = await startApp()

      // The first `limit` requests are NOT throttled (they may 2xx/4xx on their
      // own merits — we only assert they are not 429).
      for (let i = 0; i < c.limit; i += 1) {
        const res = await post(c.path, c.body())
        expect(res.status, `request ${i + 1} of ${c.name} should not be throttled`).not.toBe(429)
      }

      // The (limit + 1)-th request from the same IP is throttled with the generic
      // response — no endpoint-specific detail leaks through the throttle.
      const throttled = await post(c.path, c.body())
      expect(throttled.status).toBe(429)
      expect(throttled.json).toEqual({ error: 'rate_limited' })
    })
  }

  it('keeps each endpoint bucket independent (a separate endpoint is not throttled)', async () => {
    current = await startApp()

    // Exhaust forgot-password (3/min) ...
    for (let i = 0; i < 4; i += 1) {
      await post('/auth/forgot-password', { email: `iso-${i}@example.test` })
    }
    // ... then signup (its own 5/min bucket) is still open on the first request.
    const signup = await post('/auth/signup', {
      email: 'iso-signup@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })
    expect(signup.status).not.toBe(429)
  })
})
