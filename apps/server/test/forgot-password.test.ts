// SPDX-License-Identifier: Apache-2.0
// POST /auth/forgot-password SMTP-delivery wiring. Part A
// (the reset-token core flow + the route's uniform-200/no-enumeration contract)
// is proven by packages/core/test/reset-tokens.test.ts and
// apps/server/test/integration/password-reset.int.test.ts. THIS suite proves the
// part-B delta only: when core mints a token (account exists) the route builds a
// reset link from WEB_APP_URL (the dashboard origin that serves /reset-password,
// NOT the API's BASE_URL) + the plaintext token and hands it to the mailer; when
// no account matches the mailer is never called; and a flaky mailer can never turn
// the route into a 500 (which would enumerate accounts). The mailer and
// core are mocked — NO real Redis (passThrough limiter), NO real DB, NO real SMTP.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RateLimiterMiddleware } from '../src/middleware/rate-limit.js'

const passThrough: RateLimiterMiddleware = (_req, _res, next) => next()

// Mock the SMTP mailer: the route must call sendResetEmail with the built link
// only on the account-exists path, and tolerate its rejection.
const sendResetEmail = vi.fn(async () => ({ delivered: true as const, messageId: '<id@test>' }))
const sendVerificationEmail = vi.fn(async () => ({
  delivered: true as const,
  messageId: '<id@test>',
}))
vi.mock('../src/mailer.js', () => ({
  sendResetEmail: (...args: unknown[]) => sendResetEmail(...(args as [string, string])),
  sendVerificationEmail: (...args: unknown[]) =>
    sendVerificationEmail(...(args as [string, string])),
}))

// Mock core's token mint so we control account-exists vs account-missing without
// a DB. The route turns the returned plaintext token into the reset link.
const requestPasswordReset = vi.fn(
  async (_email: string, _ttl: number) => undefined as string | undefined,
)
vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  return {
    ...actual,
    requestPasswordReset: (email: string, ttl: number) => requestPasswordReset(email, ttl),
  }
})

interface Harness {
  server: Server
  baseUrl: string
}

async function startApp(): Promise<Harness> {
  resetEnvCache()
  const { createApp } = await import('../src/app.js')
  const server = createApp({
    authLimiter: passThrough,
    signupLimiter: passThrough,
    resendVerificationLimiter: passThrough,
    verifyEmailLimiter: passThrough,
    forgotPasswordLimiter: passThrough,
    resetPasswordLimiter: passThrough,
    mcpLimiter: passThrough,
    registerLimiter: passThrough,
    oauthLimiter: passThrough,
    apiKeyLimiter: passThrough,
  }).listen(0)
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
let current: Harness | undefined

beforeEach(() => {
  vi.clearAllMocks()
  // The reset link uses the WEB app origin (the dashboard that serves
  // /reset-password), NOT the API's BASE_URL — see buildResetLink.
  process.env.WEB_APP_URL = 'https://app.3ngram.test'
})

afterEach(async () => {
  if (current !== undefined) {
    await stopApp(current)
    current = undefined
  }
  delete process.env.WEB_APP_URL
  resetEnvCache()
})

/** Wait a tick so the route's fire-and-forget delivery runs after the 200. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('POST /auth/forgot-password — SMTP delivery wiring (#267 part B)', () => {
  it('sends the reset link via the mailer when core mints a token (account exists)', async () => {
    requestPasswordReset.mockResolvedValueOnce('plaintext-token-abc')
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'real@example.test' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    await flushMicrotasks()
    expect(sendResetEmail).toHaveBeenCalledWith(
      'real@example.test',
      'https://app.3ngram.test/reset-password?token=plaintext-token-abc',
    )
  })

  it('never calls the mailer when no account matches (core returns undefined)', async () => {
    requestPasswordReset.mockResolvedValueOnce(undefined)
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'nobody@example.test' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    await flushMicrotasks()
    expect(sendResetEmail).not.toHaveBeenCalled()
  })

  it('returns the SAME 200 body whether or not an account exists (no enumeration)', async () => {
    requestPasswordReset.mockResolvedValueOnce('plaintext-token-abc')
    current = await startApp()
    const known = await fetch(`${current.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'real@example.test' }),
    })
    const knownBody = await known.json()
    requestPasswordReset.mockResolvedValueOnce(undefined)
    const unknown = await fetch(`${current.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'nobody@example.test' }),
    })
    expect(unknown.status).toBe(known.status)
    expect(await unknown.json()).toEqual(knownBody)
  })

  it('still answers 200 when the mailer rejects (no 500 enumeration oracle)', async () => {
    requestPasswordReset.mockResolvedValueOnce('plaintext-token-abc')
    sendResetEmail.mockRejectedValueOnce(new Error('MTA exploded'))
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'real@example.test' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    await flushMicrotasks()
    expect(sendResetEmail).toHaveBeenCalledTimes(1)
  })

  it('skips delivery when WEB_APP_URL is unset (no dashboard origin to link to)', async () => {
    delete process.env.WEB_APP_URL
    requestPasswordReset.mockResolvedValueOnce('plaintext-token-abc')
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'real@example.test' }),
    })
    expect(res.status).toBe(200)
    await flushMicrotasks()
    expect(sendResetEmail).not.toHaveBeenCalled()
  })

  it('responds 200 BEFORE the mint settles (no timing-oracle on account existence)', async () => {
    // The mint+insert is the remaining enumeration leak: a KNOWN account does
    // extra unique-index work an UNKNOWN account never reaches. In prod the route
    // must respond FIRST and run the whole mint chain fire-and-forget, so the HTTP
    // latency cannot distinguish known from unknown. Gate the mock on a barrier we
    // only release AFTER the response is read: if the route awaited the mint, the
    // fetch would never resolve (deadlock) and this test would time out.
    let releaseMint: () => void = () => {}
    const mintBarrier = new Promise<void>((resolve) => {
      releaseMint = resolve
    })
    requestPasswordReset.mockImplementationOnce(async () => {
      await mintBarrier
      return 'plaintext-token-abc'
    })
    current = await startApp()

    const res = await fetch(`${current.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'real@example.test' }),
    })
    // The 200 came back with the mint still pending — proof it is off the response
    // path. The mailer has NOT been called yet (delivery runs after the mint).
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(sendResetEmail).not.toHaveBeenCalled()

    // Now let the deferred mint complete; delivery then fires off the critical path.
    releaseMint()
    await flushMicrotasks()
    expect(sendResetEmail).toHaveBeenCalledWith(
      'real@example.test',
      'https://app.3ngram.test/reset-password?token=plaintext-token-abc',
    )
  })

  it('returns 400 invalid_request for a malformed email (the only non-200)', async () => {
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'not-an-email' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_request' })
    expect(requestPasswordReset).not.toHaveBeenCalled()
  })
})
