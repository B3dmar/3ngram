// SPDX-License-Identifier: Apache-2.0
// OAuth consent-management transport contract against the in-process app and the
// REAL runtime role. A grant is seeded for two users over the
// same client; the test asserts the grant-scoped contract end to end: GET lists
// only the caller's authorized clients, DELETE revokes the caller's grant (so it
// disappears from their list) while another user's grant for the SAME client
// survives, and the routes reject unauthenticated calls.
import type { Server } from 'node:http'
import { createUser, login, registerOAuthClient } from '@3ngram/core/auth'
import type { Express } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { createTestApp } from '../test-app.js'

const PASSWORD = 'oauth-consent-contract-password'

let server: Server
let baseUrl: string
let emailA: string
let emailB: string
let tokenA: string
let tokenB: string
let clientId: string

interface ClientListBody {
  clients: Array<{ clientId: string; clientName: string; redirectHosts: string[] }>
}

// Seed a live access+refresh grant directly via the owner pool — apps/server
// has no @3ngram/db dependency, so the token rows are inserted with raw SQL
// (the consent ROUTE under test still reads them through core -> db withTenant).
async function grant(userId: string, cid: string): Promise<void> {
  await ownerPool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at)
     VALUES ($1, 'access',  $3, $2, 'memory:read', now() + interval '1 hour'),
            ($4, 'refresh', $3, $2, 'memory:read', now() + interval '1 hour')`,
    [`acc-${crypto.randomUUID()}`, userId, cid, `ref-${crypto.randomUUID()}`],
  )
}

function buildApp(): Express {
  return createTestApp()
}

beforeAll(async () => {
  emailA = `srv-consent-a-${crypto.randomUUID()}@test.local`
  emailB = `srv-consent-b-${crypto.randomUUID()}@test.local`
  const a = await createUser(emailA, PASSWORD)
  const b = await createUser(emailB, PASSWORD)
  const grantA = await login(emailA, PASSWORD, 1)
  const grantB = await login(emailB, PASSWORD, 1)
  if (!grantA || !grantB) throw new Error('login failed in setup')
  tokenA = grantA.token
  tokenB = grantB.token

  const client = await registerOAuthClient({
    redirect_uris: ['https://consent-app.example.com/callback'],
    token_endpoint_auth_method: 'none',
    client_name: 'Consent App',
  })
  clientId = client.client_id
  await grant(a.id, clientId)
  await grant(b.id, clientId)

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
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [[emailA, emailB]])
  await closePools()
})

describe('OAuth consent transport (runtime role, real DB)', () => {
  it('lists the caller authorized client with its name and redirect host', async () => {
    const res = await fetch(`${baseUrl}/auth/oauth-clients`, {
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ClientListBody
    const listed = body.clients.find((c) => c.clientId === clientId)
    expect(listed?.clientName).toBe('Consent App')
    expect(listed?.redirectHosts).toContain('consent-app.example.com')
  })

  it("revoke removes the caller's grant but leaves another user's grant intact", async () => {
    const del = await fetch(`${baseUrl}/auth/oauth-clients/${clientId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(del.status).toBe(204)

    // A no longer sees the client.
    const aAfter = await fetch(`${baseUrl}/auth/oauth-clients`, {
      headers: { authorization: `Bearer ${tokenA}` },
    })
    const aBody = (await aAfter.json()) as ClientListBody
    expect(aBody.clients.find((c) => c.clientId === clientId)).toBeUndefined()

    // B's grant for the SAME client survives.
    const bAfter = await fetch(`${baseUrl}/auth/oauth-clients`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const bBody = (await bAfter.json()) as ClientListBody
    expect(bBody.clients.find((c) => c.clientId === clientId)).toBeDefined()
  })

  it('a repeat revoke is idempotent (204 even with no live grant)', async () => {
    const del = await fetch(`${baseUrl}/auth/oauth-clients/${clientId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(del.status).toBe(204)
  })

  it('a malformed (non-uuid) client id revoke is a 204 no-op (no 500)', async () => {
    const del = await fetch(`${baseUrl}/auth/oauth-clients/not-a-uuid`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenB}` },
    })
    expect(del.status).toBe(204)
  })

  it('rejects unauthenticated management calls with 401', async () => {
    const res = await fetch(`${baseUrl}/auth/oauth-clients`)
    expect(res.status).toBe(401)
  })
})
