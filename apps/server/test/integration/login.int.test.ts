// SPDX-License-Identifier: Apache-2.0
// POST /auth/login contract against the in-process app and the REAL runtime
// role (createUser + the session INSERT both run as app_user). Asserts the
// status contract: 200 mints a token, wrong-password and unknown-user produce
// an IDENTICAL 401 body (no enumeration), schema-invalid is 400.
import type { Server } from 'node:http'
import { createUser } from '@3ngram/core/auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { createTestApp } from '../test-app.js'

const PASSWORD = 'login-contract-password'
let server: Server
let baseUrl: string
let email: string

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

beforeAll(async () => {
  email = `srv-login-${crypto.randomUUID()}@test.local`
  await createUser(email, PASSWORD)
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
  await ownerPool.query('DELETE FROM users WHERE email = $1', [email])
  await closePools()
})

describe('POST /auth/login (runtime role, real DB)', () => {
  it('200 with { token, expiresAt } on valid credentials', async () => {
    const { status, json } = await post({ email, password: PASSWORD })
    expect(status).toBe(200)
    const body = json as { token: string; expiresAt: string }
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(20)
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false)
  })

  it('wrong password and unknown user return an IDENTICAL 401 body (no enumeration)', async () => {
    const wrongPassword = await post({ email, password: 'definitely-not-it' })
    const unknownUser = await post({
      email: `nobody-${crypto.randomUUID()}@test.local`,
      password: PASSWORD,
    })
    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    expect(wrongPassword.json).toEqual(unknownUser.json)
    expect(wrongPassword.json).toEqual({ error: 'invalid_credentials' })
  })

  it('400 for a schema-invalid body (not a 401)', async () => {
    const { status, json } = await post({ email: 'not-an-email', password: '' })
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid_request' })
  })

  it('400 for a malformed JSON body (not a 500)', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_request' })
  })
})
