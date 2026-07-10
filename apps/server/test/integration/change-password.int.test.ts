// SPDX-License-Identifier: Apache-2.0
// POST /auth/change-password contract against the in-process app and the REAL
// runtime role (createUser + the UPDATE both run as app_user). Asserts the
// status contract: 204 rotates the password (and the new one logs in while the
// old one no longer does), 403 for a wrong current password (distinct from the
// authenticate middleware's 401 so the web action can tell them apart), 400 for
// a schema-invalid body, 401 for a missing Bearer token (authenticate gate).
import type { Server } from 'node:http'
import { authenticateToken, createUser } from '@3ngram/core/auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { createTestApp } from '../test-app.js'

const PASSWORD = 'change-password-initial-secret'
const NEW_PASSWORD = 'change-password-rotated-secret'
let server: Server
let baseUrl: string
let email: string
let token: string

async function login(password: string): Promise<{ status: number; token?: string }> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const json = (await res.json().catch(() => undefined)) as { token?: string } | undefined
  return { status: res.status, token: json?.token }
}

async function changePassword(
  body: unknown,
  bearer?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`
  const res = await fetch(`${baseUrl}/auth/change-password`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

beforeAll(async () => {
  email = `srv-changepw-${crypto.randomUUID()}@test.local`
  await createUser(email, PASSWORD)
  server = createTestApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  const grant = await login(PASSWORD)
  if (grant.token === undefined) throw new Error('expected a session token from login')
  token = grant.token
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  await ownerPool.query('DELETE FROM users WHERE email = $1', [email])
  await closePools()
})

describe('POST /auth/change-password (runtime role, real DB)', () => {
  it('401 without a Bearer token (authenticate gate runs)', async () => {
    const { status, json } = await changePassword({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(status).toBe(401)
    expect(json).toEqual({ error: 'unauthorized' })
  })

  it('400 for a schema-invalid body (newPassword below the 12-char floor)', async () => {
    const { status, json } = await changePassword(
      { currentPassword: PASSWORD, newPassword: 'short' },
      token,
    )
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid_request' })
  })

  it('403 (distinct from the 401 session gate) for a wrong current password', async () => {
    const { status, json } = await changePassword(
      { currentPassword: 'definitely-not-it', newPassword: NEW_PASSWORD },
      token,
    )
    expect(status).toBe(403)
    expect(json).toEqual({ error: 'invalid_credentials' })
  })

  it('204 rotates the password: the new one logs in, the old one no longer does', async () => {
    const res = await fetch(`${baseUrl}/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    })
    expect(res.status).toBe(204)

    // The rotation took effect at the credential boundary.
    const withNew = await login(NEW_PASSWORD)
    expect(withNew.status).toBe(200)
    expect(typeof withNew.token).toBe('string')

    const withOld = await login(PASSWORD)
    expect(withOld.status).toBe(401)
  })
})

describe('POST /auth/change-password revokes OTHER sessions, keeps current (#268)', () => {
  const OTHER_PASSWORD = 'change-password-multisession-secret'
  const OTHER_NEW_PASSWORD = 'change-password-multisession-rotated'
  let otherEmail: string

  beforeAll(async () => {
    otherEmail = `srv-changepw-multi-${crypto.randomUUID()}@test.local`
    await createUser(otherEmail, OTHER_PASSWORD)
  })

  afterAll(async () => {
    await ownerPool.query('DELETE FROM users WHERE email = $1', [otherEmail])
  })

  async function loginAs(password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password }),
    })
    const json = (await res.json().catch(() => undefined)) as { token?: string } | undefined
    if (json?.token === undefined) throw new Error('expected a session token from login')
    return json.token
  }

  it('keeps the rotating session (A) live and revokes every other session (B)', async () => {
    // Two live sessions for one user. A makes the rotation request; B is a
    // different device that must be logged out.
    const tokenA = await loginAs(OTHER_PASSWORD)
    const tokenB = await loginAs(OTHER_PASSWORD)
    expect(await authenticateToken(tokenA)).toBeDefined()
    expect(await authenticateToken(tokenB)).toBeDefined()

    const res = await fetch(`${baseUrl}/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        currentPassword: OTHER_PASSWORD,
        newPassword: OTHER_NEW_PASSWORD,
      }),
    })
    expect(res.status).toBe(204)

    // A (the current session) still resolves; B (the other session) no longer does.
    expect(await authenticateToken(tokenA)).toBeDefined()
    expect(await authenticateToken(tokenB)).toBeUndefined()
  })
})
