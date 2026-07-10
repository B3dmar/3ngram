// SPDX-License-Identifier: Apache-2.0
// Connection-detection contract against the in-process app and the REAL
// runtime role. A verified user with no OAuth token reads
// `connected: false`; the moment their FIRST OAuth token is issued (an MCP client
// completed DCR + the code exchange) the same read flips to `connected: true`
// without any other change — exactly the signal the dashboard polls to render
// "Connected ✓". Tenant isolation is asserted too: user A's first token must not
// flip user B's status. The status row is read through core -> db withTenant, so
// the test only seeds the token row (raw SQL via the owner pool; apps/server has
// no @3ngram/db dependency).
import type { Server } from 'node:http'
import { createUser, login, registerOAuthClient } from '@3ngram/core/auth'
import type { Express } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { createTestApp } from '../test-app.js'

const PASSWORD = 'onboarding-connection-detection-password'

let server: Server
let baseUrl: string
let emailA: string
let emailB: string
let tokenA: string
let tokenB: string
let userIdA: string
let clientId: string

interface OnboardingBody {
  connected: boolean
}

async function readOnboarding(sessionToken: string): Promise<OnboardingBody> {
  const res = await fetch(`${baseUrl}/auth/onboarding`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as OnboardingBody
}

// Seed the user's FIRST OAuth access token directly via the owner pool — the
// onboarding ROUTE under test still reads it through core -> db withTenant.
async function issueFirstToken(userId: string, cid: string): Promise<void> {
  await ownerPool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at)
     VALUES ($1, 'access', $3, $2, 'memory:read', now() + interval '1 hour')`,
    [`acc-${crypto.randomUUID()}`, userId, cid],
  )
}

function buildApp(): Express {
  return createTestApp()
}

beforeAll(async () => {
  emailA = `srv-onboarding-a-${crypto.randomUUID()}@test.local`
  emailB = `srv-onboarding-b-${crypto.randomUUID()}@test.local`
  const a = await createUser(emailA, PASSWORD)
  await createUser(emailB, PASSWORD)
  userIdA = a.id
  const grantA = await login(emailA, PASSWORD, 1)
  const grantB = await login(emailB, PASSWORD, 1)
  if (!grantA || !grantB) throw new Error('login failed in setup')
  tokenA = grantA.token
  tokenB = grantB.token

  const client = await registerOAuthClient({
    redirect_uris: ['https://onboarding-app.example.com/callback'],
    token_endpoint_auth_method: 'none',
    client_name: 'Onboarding App',
  })
  clientId = client.client_id

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

describe('onboarding connection detection (runtime role, real DB)', () => {
  it('reads connected:false before any OAuth token is issued', async () => {
    expect((await readOnboarding(tokenA)).connected).toBe(false)
  })

  it('flips connected:true once the user is issued their first OAuth token', async () => {
    await issueFirstToken(userIdA, clientId)
    expect((await readOnboarding(tokenA)).connected).toBe(true)
  })

  it("another user's first token does not flip a different user's status", async () => {
    // A is connected (previous test); B was never issued a token.
    expect((await readOnboarding(tokenB)).connected).toBe(false)
  })

  it('rejects an unauthenticated read with 401', async () => {
    const res = await fetch(`${baseUrl}/auth/onboarding`)
    expect(res.status).toBe(401)
  })
})
