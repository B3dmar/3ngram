// SPDX-License-Identifier: Apache-2.0
// POST /auth/signup + /auth/verify-email wiring for public self-serve signup.
// Core and the mailer are mocked: this suite proves the transport contract only
// (feature gate, neutral 202 response, verification-link construction, and no
// account-enumeration timing oracle). Token hashing and DB atomicity live in the
// core/db tests.
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RateLimiterMiddleware } from '../src/middleware/rate-limit.js'

const passThrough: RateLimiterMiddleware = (_req, _res, next) => next()

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

const requestSignup = vi.fn(
  async (_email: string, _password: string, _clientProofHash: string, _ttl: number) =>
    undefined as string | undefined,
)
const verifyEmail = vi.fn(async (_token: string, _clientProof: string, _ttlHours: number) => ({
  userId: '0190b000-0000-7000-8000-0000000000aa',
  token: 'session-token',
  expiresAt: new Date('2026-01-01T01:00:00.000Z'),
}))
const resendEmailVerification = vi.fn(
  async (_email: string, _clientProofHash: string, _ttl: number) => undefined as string | undefined,
)

vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  return {
    ...actual,
    requestSignup: (email: string, password: string, clientProofHash: string, ttl: number) =>
      requestSignup(email, password, clientProofHash, ttl),
    verifyEmail: (token: string, clientProof: string, ttlHours: number) =>
      verifyEmail(token, clientProof, ttlHours),
    resendEmailVerification: (email: string, clientProofHash: string, ttl: number) =>
      resendEmailVerification(email, clientProofHash, ttl),
  }
})

const { InvalidEmailVerificationTokenError } = await import('@3ngram/core/auth')

interface Harness {
  server: Server
  baseUrl: string
}

async function startApp(): Promise<Harness> {
  resetEnvCache()
  const { createApp } = await import('../src/app.js')
  const server = createApp({
    apiKeyLimiter: passThrough,
    authLimiter: passThrough,
    signupLimiter: passThrough,
    resendVerificationLimiter: passThrough,
    verifyEmailLimiter: passThrough,
    forgotPasswordLimiter: passThrough,
    resetPasswordLimiter: passThrough,
    mcpLimiter: passThrough,
    oauthLimiter: passThrough,
    registerLimiter: passThrough,
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
const CLIENT_PROOF = 'signup-client-proof'
const CLIENT_PROOF_HASH = 'a'.repeat(64)
let current: Harness | undefined

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AUTH_SIGNUP_ENABLED = 'true'
  process.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES = '45'
  process.env.SESSION_TTL_HOURS = '12'
  process.env.SMTP_HOST = 'smtp.3ngram.test'
  process.env.SMTP_FROM = 'no-reply@3ngram.test'
  process.env.WEB_APP_URL = 'https://app.3ngram.test/'
})

afterEach(async () => {
  if (current !== undefined) {
    await stopApp(current)
    current = undefined
  }
  delete process.env.AUTH_SIGNUP_ENABLED
  delete process.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES
  delete process.env.SESSION_TTL_HOURS
  delete process.env.SMTP_HOST
  delete process.env.SMTP_FROM
  delete process.env.WEB_APP_URL
  delete process.env.PASSWORD_BREACH_CHECK_ENABLED
  vi.restoreAllMocks() // un-stub global fetch even if a test threw before mockRestore
  resetEnvCache()
})

/**
 * Intercept ONLY the HIBP range call so the real breach check sees a controlled
 * corpus body; every other request (the harness's own HTTP calls to the test
 * server) passes through to the real fetch. Returns the spy for mockRestore.
 */
function stubPwnedRange(body: string): ReturnType<typeof vi.spyOn> {
  const realFetch = globalThis.fetch.bind(globalThis)
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsed = new URL(url)
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'api.pwnedpasswords.com' &&
      parsed.pathname.startsWith('/range/')
    ) {
      return Promise.resolve(new Response(body, { status: 200 }))
    }
    return realFetch(input, init)
  })
}

/** Upper-hex SHA-1 suffix (chars 5..) HIBP keys a hit under for `password`. */
function pwnedSuffix(password: string): string {
  return createHash('sha1').update(password).digest('hex').toUpperCase().slice(5)
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function signup(body: unknown): Promise<{ status: number; json: unknown }> {
  if (current === undefined) throw new Error('expected app harness')
  const res = await fetch(`${current.baseUrl}/auth/signup`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

async function verify(body: unknown): Promise<{ status: number; json: unknown }> {
  if (current === undefined) throw new Error('expected app harness')
  const res = await fetch(`${current.baseUrl}/auth/verify-email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

async function resend(body: unknown): Promise<{ status: number; json: unknown }> {
  if (current === undefined) throw new Error('expected app harness')
  const res = await fetch(`${current.baseUrl}/auth/resend-verification`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

describe('POST /auth/signup', () => {
  it('returns 403 when public signup is disabled', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    current = await startApp()

    const res = await signup({
      email: 'user@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(403)
    expect(res.json).toEqual({ error: 'signup_disabled' })
    expect(requestSignup).not.toHaveBeenCalled()
    expect(sendVerificationEmail).not.toHaveBeenCalled()
  })

  it('returns neutral 202 and sends a verification link when core mints a token', async () => {
    requestSignup.mockResolvedValueOnce('plaintext-token-abc')
    current = await startApp()

    const res = await signup({
      email: 'real@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(202)
    expect(res.json).toEqual({ status: 'verification_sent' })
    expect(requestSignup).toHaveBeenCalledWith(
      'real@example.test',
      'signup-password-123',
      CLIENT_PROOF_HASH,
      45,
    )
    await flushMicrotasks()
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      'real@example.test',
      'https://app.3ngram.test/verify-email?token=plaintext-token-abc',
    )
  })

  it('returns the same 202 body and sends no email when core returns no token', async () => {
    requestSignup.mockResolvedValueOnce(undefined)
    current = await startApp()

    const res = await signup({
      email: 'verified@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(202)
    expect(res.json).toEqual({ status: 'verification_sent' })
    await flushMicrotasks()
    expect(sendVerificationEmail).not.toHaveBeenCalled()
  })

  it('still answers 202 when the mailer rejects', async () => {
    requestSignup.mockResolvedValueOnce('plaintext-token-abc')
    sendVerificationEmail.mockRejectedValueOnce(new Error('MTA exploded'))
    current = await startApp()

    const res = await signup({
      email: 'real@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(202)
    expect(res.json).toEqual({ status: 'verification_sent' })
    await flushMicrotasks()
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1)
  })

  it('responds 202 before the signup mint settles', async () => {
    let releaseMint: () => void = () => {}
    const mintBarrier = new Promise<void>((resolve) => {
      releaseMint = resolve
    })
    requestSignup.mockImplementationOnce(async () => {
      await mintBarrier
      return 'plaintext-token-abc'
    })
    current = await startApp()

    const res = await signup({
      email: 'real@example.test',
      password: 'signup-password-123',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(202)
    expect(res.json).toEqual({ status: 'verification_sent' })
    expect(sendVerificationEmail).not.toHaveBeenCalled()

    releaseMint()
    await flushMicrotasks()
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      'real@example.test',
      'https://app.3ngram.test/verify-email?token=plaintext-token-abc',
    )
  })

  it('returns 400 invalid_request for malformed credentials', async () => {
    current = await startApp()

    const res = await signup({ email: 'not-an-email', password: 'short' })

    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'invalid_request' })
    expect(requestSignup).not.toHaveBeenCalled()
  })

  it('returns 400 password_breached and never mints when the breach check rejects', async () => {
    process.env.PASSWORD_BREACH_CHECK_ENABLED = 'true'
    const password = 'breached-password-123'
    const fetchSpy = stubPwnedRange(
      `${pwnedSuffix(password)}:42\r\n0000000000000000000000000000000000A:1`,
    )
    current = await startApp()

    const res = await signup({
      email: 'new@example.test',
      password,
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'password_breached' })
    await flushMicrotasks()
    expect(requestSignup).not.toHaveBeenCalled()
    expect(sendVerificationEmail).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('proceeds to the neutral 202 when the breach check is enabled but the password is clean', async () => {
    process.env.PASSWORD_BREACH_CHECK_ENABLED = 'true'
    requestSignup.mockResolvedValueOnce('plaintext-token-abc')
    // A range body that does NOT contain the password's suffix → not breached.
    const fetchSpy = stubPwnedRange('0000000000000000000000000000000000A:1')
    current = await startApp()

    const res = await signup({
      email: 'clean@example.test',
      password: 'a-fresh-uncompromised-passphrase',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(202)
    expect(res.json).toEqual({ status: 'verification_sent' })
    await flushMicrotasks()
    expect(requestSignup).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })
})

describe('POST /auth/verify-email', () => {
  it('returns a login-shaped session grant after core verifies the token', async () => {
    current = await startApp()

    const res = await verify({ token: 'plaintext-token-abc', clientProof: CLIENT_PROOF })

    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      token: 'session-token',
      expiresAt: '2026-01-01T01:00:00.000Z',
    })
    expect(verifyEmail).toHaveBeenCalledWith('plaintext-token-abc', CLIENT_PROOF, 12)
  })

  it('maps invalid or consumed tokens to a uniform 401', async () => {
    verifyEmail.mockRejectedValueOnce(new InvalidEmailVerificationTokenError())
    current = await startApp()

    const res = await verify({ token: 'bad-token', clientProof: CLIENT_PROOF })

    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: 'invalid_token' })
  })

  it('returns 400 for a missing token or proof', async () => {
    current = await startApp()

    const missingToken = await verify({ clientProof: CLIENT_PROOF })
    const missingProof = await verify({ token: 'plaintext-token-abc' })

    expect(missingToken.status).toBe(400)
    expect(missingToken.json).toEqual({ error: 'invalid_request' })
    expect(missingProof.status).toBe(400)
    expect(missingProof.json).toEqual({ error: 'invalid_request' })
    expect(verifyEmail).not.toHaveBeenCalled()
  })
})

describe('POST /auth/resend-verification', () => {
  it('returns 403 when public signup is disabled', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    current = await startApp()

    const res = await resend({ email: 'user@example.test', clientProofHash: CLIENT_PROOF_HASH })

    expect(res.status).toBe(403)
    expect(res.json).toEqual({ error: 'signup_disabled' })
    expect(resendEmailVerification).not.toHaveBeenCalled()
  })

  it('returns 400 invalid_request for a malformed body', async () => {
    current = await startApp()

    const res = await resend({ email: 'not-an-email', clientProofHash: 'too-short' })

    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'invalid_request' })
    expect(resendEmailVerification).not.toHaveBeenCalled()
  })

  it('returns neutral 202 and sends a fresh link when core mints a token', async () => {
    resendEmailVerification.mockResolvedValueOnce('fresh-token-xyz')
    current = await startApp()

    const res = await resend({
      email: 'unverified@example.test',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(202)
    expect(res.json).toEqual({ status: 'verification_sent' })
    expect(resendEmailVerification).toHaveBeenCalledWith(
      'unverified@example.test',
      CLIENT_PROOF_HASH,
      45,
    )
    await flushMicrotasks()
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      'unverified@example.test',
      'https://app.3ngram.test/verify-email?token=fresh-token-xyz',
    )
  })

  it('returns the same neutral 202 and sends nothing for an unknown or verified email', async () => {
    resendEmailVerification.mockResolvedValueOnce(undefined)
    current = await startApp()

    const res = await resend({
      email: 'verified@example.test',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(202)
    expect(res.json).toEqual({ status: 'verification_sent' })
    await flushMicrotasks()
    expect(sendVerificationEmail).not.toHaveBeenCalled()
  })

  it('responds 202 before the resend mint settles (no enumeration timing oracle)', async () => {
    let releaseMint: () => void = () => {}
    const mintBarrier = new Promise<void>((resolve) => {
      releaseMint = resolve
    })
    resendEmailVerification.mockImplementationOnce(async () => {
      await mintBarrier
      return 'fresh-token-xyz'
    })
    current = await startApp()

    const res = await resend({
      email: 'unverified@example.test',
      clientProofHash: CLIENT_PROOF_HASH,
    })

    expect(res.status).toBe(202)
    expect(sendVerificationEmail).not.toHaveBeenCalled()

    releaseMint()
    await flushMicrotasks()
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1)
  })
})
