// SPDX-License-Identifier: Apache-2.0
// Grant-scoped consent wrappers against the REAL runtime role (app_user,
// NOBYPASSRLS) — owner bypasses RLS and would prove nothing (docs/concepts/testing.mdx).
// Covers the withTenant() JOIN that derives "apps I authorized" from the
// CALLER'S oauth_tokens, and that a per-user revoke kills only the caller's
// tokens for the client while another user's grant for the SAME client survives
// (A3 acceptance criterion). Clients are GLOBAL (no user_id);
// listClientsAuthorizedByUser must therefore surface a client ONLY because the
// caller holds a live token for it.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  listClientsAuthorizedByUser,
  registerClient,
  revokeClientForUser,
} from '../../src/auth-oauth-clients.js'
import { consumeOauthCode, insertOauthCode } from '../../src/auth-oauth-codes.js'
import { insertOauthTokenPair } from '../../src/auth-oauth-tokens.js'
import { closeDb } from '../../src/client.js'
import { closePools, ownerPool, seedUser } from './helpers.js'

let userA: string
let userB: string
let sharedClientId: string
let aOnlyClientId: string
/** Per-test clients seeded inside it() bodies, cleaned up in afterAll. */
const extraClientIds: string[] = []

const hour = () => new Date(Date.now() + 3_600_000)
const hourAgo = () => new Date(Date.now() - 3_600_000)

/** Seed a global DCR client (public, no secret) and return its client_id. */
async function seedClient(name: string): Promise<string> {
  const clientId = randomUUID()
  await registerClient({
    clientId,
    clientName: name,
    redirectUris: [`https://${name}.example.com/callback`],
    tokenEndpointAuthMethod: 'none',
    clientSecretHash: null,
  })
  return clientId
}

/** Issue a live access+refresh grant for (userId, clientId). */
async function grant(userId: string, clientId: string): Promise<void> {
  await insertOauthTokenPair(
    userId,
    {
      tokenHash: `access-${randomUUID()}`,
      kind: 'access',
      clientId,
      scope: 'memory:read',
      expiresAt: hour(),
    },
    {
      tokenHash: `refresh-${randomUUID()}`,
      kind: 'refresh',
      clientId,
      scope: 'memory:read',
      expiresAt: hour(),
    },
  )
}

/** Issue an EXPIRED access+refresh grant for (userId, clientId). */
async function expiredGrant(userId: string, clientId: string): Promise<void> {
  await insertOauthTokenPair(
    userId,
    {
      tokenHash: `access-${randomUUID()}`,
      kind: 'access',
      clientId,
      scope: 'memory:read',
      expiresAt: hourAgo(),
    },
    {
      tokenHash: `refresh-${randomUUID()}`,
      kind: 'refresh',
      clientId,
      scope: 'memory:read',
      expiresAt: hourAgo(),
    },
  )
}

/** Seed a live, unused PKCE code for (userId, clientId); returns its raw hash. */
async function seedCode(userId: string, clientId: string): Promise<string> {
  const codeHash = `code-${randomUUID()}`
  await insertOauthCode(userId, {
    codeHash,
    clientId,
    redirectUri: 'https://app.example.com/callback',
    redirectUriSupplied: true,
    codeChallenge: 'challenge',
    scope: 'memory:read',
    expiresAt: hour(),
  })
  return codeHash
}

beforeAll(async () => {
  userA = await seedUser('oauth-consent-a@test.local')
  userB = await seedUser('oauth-consent-b@test.local')
  sharedClientId = await seedClient('shared-client')
  aOnlyClientId = await seedClient('a-only-client')
  // A authorized both clients; B authorized only the shared one.
  await grant(userA, sharedClientId)
  await grant(userA, aOnlyClientId)
  await grant(userB, sharedClientId)
})

afterAll(async () => {
  // Drop the users' codes/tokens first; oauth_clients CASCADE covers the rest,
  // but the per-test clients are tracked in `extraClientIds` so they go too.
  await ownerPool.query('DELETE FROM oauth_codes WHERE user_id = ANY($1)', [[userA, userB]])
  await ownerPool.query('DELETE FROM oauth_tokens WHERE user_id = ANY($1)', [[userA, userB]])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [
    [sharedClientId, aOnlyClientId, ...extraClientIds],
  ])
  await closeDb()
  await closePools()
})

describe('auth-oauth consent (runtime role, real withTenant + RLS)', () => {
  it('lists ONLY the clients the caller authorized (grant-scoped, RLS)', async () => {
    const aClients = await listClientsAuthorizedByUser(userA)
    const aIds = aClients.map((c) => c.clientId)
    expect(aIds).toContain(sharedClientId)
    expect(aIds).toContain(aOnlyClientId)

    // B authorized only the shared client — A's exclusive client must be invisible to B.
    const bClients = await listClientsAuthorizedByUser(userB)
    const bIds = bClients.map((c) => c.clientId)
    expect(bIds).toContain(sharedClientId)
    expect(bIds).not.toContain(aOnlyClientId)
  })

  it('surfaces client metadata (name + redirect uris) but never a secret hash', async () => {
    const aClients = await listClientsAuthorizedByUser(userA)
    const shared = aClients.find((c) => c.clientId === sharedClientId)
    expect(shared?.clientName).toBe('shared-client')
    expect(shared?.redirectUris).toEqual(['https://shared-client.example.com/callback'])
    expect(shared?.authorizedAt).toBeInstanceOf(Date)
    expect(JSON.stringify(aClients)).not.toContain('clientSecretHash')
  })

  it("revoke kills the caller's tokens for the client but leaves another user's grant intact", async () => {
    // A revokes the shared client: A's grant goes away, B's grant for the SAME
    // client must survive (the global client row is never touched).
    const revoked = await revokeClientForUser(userA, sharedClientId)
    expect(revoked).toBeGreaterThan(0)

    const aClients = await listClientsAuthorizedByUser(userA)
    expect(aClients.map((c) => c.clientId)).not.toContain(sharedClientId)
    // A still holds the exclusive client — only the shared grant was revoked.
    expect(aClients.map((c) => c.clientId)).toContain(aOnlyClientId)

    // B's grant for the shared client is untouched.
    const bClients = await listClientsAuthorizedByUser(userB)
    expect(bClients.map((c) => c.clientId)).toContain(sharedClientId)
  })

  it('a second revoke of an already-revoked grant matches nothing (idempotent)', async () => {
    // userA already revoked sharedClientId above; a repeat closes no live token.
    expect(await revokeClientForUser(userA, sharedClientId)).toBe(0)
  })

  it('isolates tenants: B cannot revoke A-only grant (RLS makes the rows invisible)', async () => {
    expect(await revokeClientForUser(userB, aOnlyClientId)).toBe(0)
    // A's grant for its exclusive client still stands.
    const aClients = await listClientsAuthorizedByUser(userA)
    expect(aClients.map((c) => c.clientId)).toContain(aOnlyClientId)
  })

  // BUG 1: a client whose tokens have all naturally expired is dead and
  // must NOT surface as a live Connected app; one with ≥1 live token must.
  it('excludes clients whose tokens have all expired, includes ones with a live token', async () => {
    const expiredOnly = await seedClient('expired-only-client')
    const liveClient = await seedClient('live-client')
    extraClientIds.push(expiredOnly, liveClient)
    await expiredGrant(userA, expiredOnly)
    await grant(userA, liveClient)

    const ids = (await listClientsAuthorizedByUser(userA)).map((c) => c.clientId)
    expect(ids).not.toContain(expiredOnly)
    expect(ids).toContain(liveClient)
  })

  // BUG 2: revoke must also burn the caller's LIVE unused codes for the
  // client, so a pending /authorize code cannot be exchanged post-revoke —
  // while another user's code for the SAME client stays exchangeable.
  it('burns the caller live code on revoke but leaves another user code exchangeable', async () => {
    const client = await seedClient('code-burn-client')
    extraClientIds.push(client)
    await grant(userA, client)
    const aCode = await seedCode(userA, client)
    const bCode = await seedCode(userB, client)

    await revokeClientForUser(userA, client)

    // A's pending code is burned: the consume resolver finds no live winner.
    expect(await consumeOauthCode(aCode)).toBeUndefined()
    // B's code for the SAME client is untouched and still exchangeable.
    const bGrant = await consumeOauthCode(bCode)
    expect(bGrant?.userId).toBe(userB)
    expect(bGrant?.clientId).toBe(client)
  })
})
