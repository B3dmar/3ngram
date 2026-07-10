// SPDX-License-Identifier: Apache-2.0
// Forgotten-password reset end-to-end against the in-process app
// and the REAL runtime role (createUser, the consume resolver, and the rotate +
// revoke-all all run as app_user). Asserts the security-critical contract:
//   - POST /auth/forgot-password ALWAYS returns 200 with the SAME shape for a
//     known and an unknown email (no account enumeration); only the dev-echo
//     flag surfaces a token, and only for a known account.
//   - POST /auth/reset-password consumes the token single-use (replay -> 401),
//     honours expiry (-> 401), 400s a schema-invalid body, and on success (204)
//     revokes EVERY live session the user holds.
// The dev-echo flag is the seam that lets the test obtain the plaintext token
// without an email channel; it is refused outside NODE_ENV=development by the
// env layer (vitest runs with NODE_ENV=test by default, so this suite sets it).
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { authenticateToken, createUser } from '@3ngram/core/auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { createTestApp } from '../test-app.js'

const PASSWORD = 'password-reset-initial-secret'
const NEW_PASSWORD = 'password-reset-rotated-secret'

let server: Server
let baseUrl: string
let email: string
const createdEmails: string[] = []

async function provision(prefix: string, password = PASSWORD): Promise<string> {
  const addr = `${prefix}-${crypto.randomUUID()}@test.local`
  await createUser(addr, password)
  createdEmails.push(addr)
  return addr
}

async function login(addr: string, password: string): Promise<{ status: number; token?: string }> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: addr, password }),
  })
  const json = (await res.json().catch(() => undefined)) as { token?: string } | undefined
  return { status: res.status, token: json?.token }
}

async function forgot(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  }
}

async function reset(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}/auth/reset-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

/** Mint a reset token for `addr` via the public endpoint, returning the dev-echo plaintext. */
async function mintToken(addr: string): Promise<string> {
  const { json } = await forgot({ email: addr })
  const token = json.resetToken
  if (typeof token !== 'string') throw new Error('expected a dev-echo reset token')
  return token
}

beforeAll(async () => {
  // The dev-echo seam (env guard refuses it outside development) — set BEFORE the
  // app boots so loadEnv() memoizes with the flag on.
  process.env.NODE_ENV = 'development'
  process.env.AUTH_RESET_TOKEN_DEV_ECHO = 'true'
  process.env.RESET_TOKEN_TTL_MINUTES = '60'
  resetEnvCache()

  email = await provision('srv-reset')
  server = createTestApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [createdEmails])
  process.env.NODE_ENV = 'test'
  delete process.env.AUTH_RESET_TOKEN_DEV_ECHO
  resetEnvCache()
  await closePools()
})

describe('POST /auth/forgot-password (no account enumeration)', () => {
  it('400 only for a syntactically invalid email', async () => {
    const { status, json } = await forgot({ email: 'not-an-email' })
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid_request' })
  })

  it('returns the SAME 200 shape for a KNOWN and an UNKNOWN account', async () => {
    const unknown = await forgot({ email: `nobody-${crypto.randomUUID()}@test.local` })
    expect(unknown.status).toBe(200)
    // Unknown account: status ok, NO token (nothing was minted).
    expect(unknown.json).toEqual({ status: 'ok' })

    const known = await forgot({ email })
    expect(known.status).toBe(200)
    expect(known.json.status).toBe('ok')
    // The ONLY difference is the dev-echo token for a real account — in prod
    // (flag off) both responses are byte-identical, so the endpoint never leaks
    // which emails are registered.
    expect(typeof known.json.resetToken).toBe('string')
  })
})

describe('POST /auth/reset-password', () => {
  it('400 for a schema-invalid body (newPassword below the 12-char floor)', async () => {
    const token = await mintToken(email)
    const { status, json } = await reset({ token, newPassword: 'short' })
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid_request' })
  })

  it('401 for an unknown token (uniform invalid_token, no enumeration)', async () => {
    const { status, json } = await reset({
      token: 'totally-unknown-token',
      newPassword: NEW_PASSWORD,
    })
    expect(status).toBe(401)
    expect(json).toEqual({ error: 'invalid_token' })
  })

  it('is single-use: a consumed token cannot be replayed', async () => {
    const replayEmail = await provision('srv-reset-replay')
    const token = await mintToken(replayEmail)

    const first = await reset({ token, newPassword: NEW_PASSWORD })
    expect(first.status).toBe(204)

    // Replay of the SAME token now fails — the consume resolver burned it.
    const second = await reset({ token, newPassword: 'another-new-password-x' })
    expect(second.status).toBe(401)
    expect(second.json).toEqual({ error: 'invalid_token' })
  })

  it('honours expiry: an expired token is rejected', async () => {
    const expiredEmail = await provision('srv-reset-expired')
    const token = await mintToken(expiredEmail)
    // Force the just-minted token past its TTL via the owner connection.
    await ownerPool.query(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'
       WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [expiredEmail],
    )
    const { status, json } = await reset({ token, newPassword: NEW_PASSWORD })
    expect(status).toBe(401)
    expect(json).toEqual({ error: 'invalid_token' })
  })

  it('204 sets the new password: the new one logs in, the old one no longer does', async () => {
    const rotateEmail = await provision('srv-reset-rotate')
    const token = await mintToken(rotateEmail)

    const res = await reset({ token, newPassword: NEW_PASSWORD })
    expect(res.status).toBe(204)

    const withNew = await login(rotateEmail, NEW_PASSWORD)
    expect(withNew.status).toBe(200)
    const withOld = await login(rotateEmail, PASSWORD)
    expect(withOld.status).toBe(401)
  })

  it('revokes EVERY live session the user holds (a reset is a security event)', async () => {
    const multiEmail = await provision('srv-reset-multi')
    // Two live sessions (two devices) before the reset.
    const a = await login(multiEmail, PASSWORD)
    const b = await login(multiEmail, PASSWORD)
    if (a.token === undefined || b.token === undefined) throw new Error('expected session tokens')
    expect(await authenticateToken(a.token)).toBeDefined()
    expect(await authenticateToken(b.token)).toBeDefined()

    const token = await mintToken(multiEmail)
    const res = await reset({ token, newPassword: NEW_PASSWORD })
    expect(res.status).toBe(204)

    // Unlike change-password (which keeps the current session), a reset has no
    // "current session" to keep — BOTH devices are signed out.
    expect(await authenticateToken(a.token)).toBeUndefined()
    expect(await authenticateToken(b.token)).toBeUndefined()
  })

  it('revokes EVERY issued agent credential (OAuth tokens + API keys) on reset (FR-015)', async () => {
    // A recovery reset must lock out stolen agent credentials, not just browser
    // sessions (migration 0020). Seed a live API key and a live OAuth token via
    // the owner pool (bypasses RLS), then assert both are revoked post-reset.
    const addr = await provision('srv-reset-agent')
    const userId = await authenticateToken((await login(addr, PASSWORD)).token as string)
    if (typeof userId !== 'string') throw new Error('expected a userId')

    const apiKeyHash = `reset-test-apikey-${crypto.randomUUID()}`
    await ownerPool.query(
      "INSERT INTO api_keys (user_id, name, key_hash, prefix) VALUES ($1, 'reset-test', $2, 'rk_test')",
      [userId, apiKeyHash],
    )
    const clientId = `reset-test-client-${crypto.randomUUID()}`
    const oauthHash = `reset-test-oauth-${crypto.randomUUID()}`
    await ownerPool.query(
      'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3::jsonb)',
      [clientId, 'reset-test', JSON.stringify(['https://localhost/cb'])],
    )
    await ownerPool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at)
       VALUES ($1, 'access', $2, $3, 'memory:read', now() + interval '1 hour')`,
      [oauthHash, clientId, userId],
    )

    const token = await mintToken(addr)
    expect((await reset({ token, newPassword: NEW_PASSWORD })).status).toBe(204)

    const ak = await ownerPool.query('SELECT revoked_at FROM api_keys WHERE key_hash = $1', [
      apiKeyHash,
    ])
    const ot = await ownerPool.query('SELECT revoked_at FROM oauth_tokens WHERE token_hash = $1', [
      oauthHash,
    ])
    expect(ak.rows[0]?.revoked_at).not.toBeNull()
    expect(ot.rows[0]?.revoked_at).not.toBeNull()
  })
})
