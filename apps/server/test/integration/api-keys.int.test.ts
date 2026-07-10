// SPDX-License-Identifier: Apache-2.0
// API-key management + X-API-Key transport contract against the in-process app
// and the REAL runtime role (issuance, listing, revocation, and resolution all
// run as app_user). Covers the full issue/use/revoke lifecycle, the uniform 401
// for revoked and malformed keys, that list never leaks a hash, and the
// cross-tenant exit criterion: user A's key cannot read user B's key list.
import type { Server } from 'node:http'
import { createUser, login } from '@3ngram/core/auth'
import type { Express } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { apiKeyAuth } from '../../src/middleware/api-key.js'
import { createTestApp } from '../test-app.js'

const PASSWORD = 'api-key-contract-password'

let server: Server
let baseUrl: string
let emailA: string
let emailB: string
let userAId: string
let tokenA: string
let tokenB: string

/** A small app that exposes the api-key routes AND a route guarded by apiKeyAuth,
 *  so the "use" leg of the lifecycle (presenting the key) is exercised end to end. */
function buildApp(): Express {
  const app = createTestApp()
  app.get('/whoami', apiKeyAuth, (req, res) => {
    res.status(200).json({ userId: req.userId })
  })
  return app
}

interface IssuedKeyBody {
  id: string
  key: string
  prefix: string
  name: string
  createdAt: string
}

async function issueKey(
  token: string,
  name: string,
): Promise<{ status: number; json: IssuedKeyBody }> {
  const res = await fetch(`${baseUrl}/auth/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  })
  return { status: res.status, json: (await res.json()) as IssuedKeyBody }
}

beforeAll(async () => {
  emailA = `srv-apikey-a-${crypto.randomUUID()}@test.local`
  emailB = `srv-apikey-b-${crypto.randomUUID()}@test.local`
  const a = await createUser(emailA, PASSWORD)
  await createUser(emailB, PASSWORD)
  userAId = a.id
  const grantA = await login(emailA, PASSWORD, 1)
  const grantB = await login(emailB, PASSWORD, 1)
  if (!grantA || !grantB) throw new Error('login failed in setup')
  tokenA = grantA.token
  tokenB = grantB.token

  server = buildApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [[emailA, emailB]])
  await closePools()
})

describe('API keys transport (runtime role, real DB)', () => {
  it('issues a key once, uses it via X-API-Key, then revokes it (lifecycle)', async () => {
    const issued = await issueKey(tokenA, 'ci-key')
    expect(issued.status).toBe(201)
    expect(issued.json.key).toMatch(/^3ng_/)
    expect(issued.json.name).toBe('ci-key')
    expect(typeof issued.json.id).toBe('string')
    const key: string = issued.json.key
    const id: string = issued.json.id

    // use: the key resolves to its owner via X-API-Key.
    const used = await fetch(`${baseUrl}/whoami`, { headers: { 'x-api-key': key } })
    expect(used.status).toBe(200)
    expect(((await used.json()) as { userId: string }).userId).toBe(userAId)

    // revoke.
    const del = await fetch(`${baseUrl}/auth/api-keys/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(del.status).toBe(204)

    // revoked key now yields a uniform 401.
    const afterRevoke = await fetch(`${baseUrl}/whoami`, { headers: { 'x-api-key': key } })
    expect(afterRevoke.status).toBe(401)
    expect(await afterRevoke.json()).toEqual({ error: 'unauthorized' })
  })

  it('401s a malformed key (no enumeration)', async () => {
    const res = await fetch(`${baseUrl}/whoami`, { headers: { 'x-api-key': 'not-a-real-key' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('list returns metadata but never a hash', async () => {
    await issueKey(tokenA, 'listed-key')
    const res = await fetch(`${baseUrl}/auth/api-keys`, {
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('listed-key')
    expect(text).not.toContain('keyHash')
    expect(text).not.toContain('key_hash')
    // and no 64-char hex sha256 digest leaks into the payload.
    expect(text).not.toMatch(/[0-9a-f]{64}/)
  })

  it('400s issuance with a missing name (column is NOT NULL)', async () => {
    const res = await fetch(`${baseUrl}/auth/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_request' })
  })

  it('404s a malformed (non-uuid) id on revoke instead of 500', async () => {
    const res = await fetch(`${baseUrl}/auth/api-keys/not-a-uuid`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('rejects unauthenticated management calls with 401', async () => {
    const res = await fetch(`${baseUrl}/auth/api-keys`)
    expect(res.status).toBe(401)
  })

  it('isolates tenants: user B never sees user A keys in their list (#78)', async () => {
    await issueKey(tokenA, 'a-only')
    const bList = await fetch(`${baseUrl}/auth/api-keys`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const bKeys = ((await bList.json()) as { keys: Array<{ name: string }> }).keys
    expect(bKeys.find((k) => k.name === 'a-only')).toBeUndefined()
  })
})
