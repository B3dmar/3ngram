// SPDX-License-Identifier: Apache-2.0
// OAuth client GC db helpers against the REAL database. oauth_clients is the global system table (no RLS), so these run the
// audited admin path. Asserts the GC predicate end-to-end: a never-used client
// older than the cutoff is collected; a recently-used client (last_used_at set)
// and a recently-registered never-used client are KEPT. The owner pool back-dates
// created_at so the age gate is deterministic without waiting 30 days.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  deleteClients,
  getClientByClientId,
  listGarbageCollectableClients,
  registerClient,
  updateLastUsedAt,
} from '../../src/auth-oauth-clients.js'
import { closeDb } from '../../src/client.js'
import { closePools, ownerPool, seedUser } from './helpers.js'

const CUTOFF = new Date('2026-06-01T00:00:00.000Z')
const STALE = new Date('2026-05-01T00:00:00.000Z') // before cutoff
const FRESH = new Date('2026-06-10T00:00:00.000Z') // after cutoff

let idleStaleId: string // never used, registered before cutoff -> collected
let usedStaleId: string // used, registered before cutoff -> KEPT
let idleFreshId: string // never used, registered after cutoff -> KEPT
let tokenStaleId: string // last_used_at NULL + stale, BUT has a token row -> KEPT
let tokenUserId: string // owner of the token guarding tokenStaleId
let liveCodeStaleId: string // stale, only a LIVE pending oauth_codes row -> KEPT
let expiredCodeStaleId: string // stale, only an EXPIRED unused oauth_codes row -> collected
let codeUserId: string // owner of the code rows

async function seedClient(name: string, createdAt: Date): Promise<string> {
  const clientId = randomUUID()
  await registerClient({
    clientId,
    clientName: name,
    redirectUris: [`https://${name}.example.com/cb`],
    tokenEndpointAuthMethod: 'none',
    clientSecretHash: null,
  })
  // Back-date created_at deterministically (owner path; registerClient defaults to now()).
  await ownerPool.query('UPDATE oauth_clients SET created_at = $1 WHERE client_id = $2', [
    createdAt,
    clientId,
  ])
  return clientId
}

beforeAll(async () => {
  idleStaleId = await seedClient('idle-stale', STALE)
  usedStaleId = await seedClient('used-stale', STALE)
  idleFreshId = await seedClient('idle-fresh', FRESH)
  // Mark the used-stale client as used: this clears the last_used_at IS NULL gate.
  await updateLastUsedAt(usedStaleId)

  // Data-loss guard: a client whose last_used_at was NEVER stamped (fire-and-forget
  // updateLastUsedAt can drop, pre-existing rows were never backfilled) but which
  // HAS issued a token. last_used_at IS NULL + stale would select it for the
  // 30-day GC, and ON DELETE CASCADE would then orphan a real user's grant. The
  // token-existence guard must keep it out of both the scan and the delete.
  tokenStaleId = await seedClient('token-stale', STALE)
  tokenUserId = await seedUser('gc-token-guard@example.com')
  await ownerPool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at)
     VALUES ($1, 'access', $2, $3, 'mcp', now() + interval '1 hour')`,
    [`gc-token-guard-${tokenStaleId}`, tokenStaleId, tokenUserId],
  )

  // oauth_codes guard distinguishes LIVE from EXPIRED codes (issue: an abandoned,
  // expired+unused code that no cleanup removes must NOT pin a client out of GC).
  codeUserId = await seedUser('gc-code-guard@example.com')

  // A stale client whose ONLY grant is a LIVE pending code (unused, unexpired):
  // mid-flight authorization, KEPT.
  liveCodeStaleId = await seedClient('live-code-stale', STALE)
  await ownerPool.query(
    `INSERT INTO oauth_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, used_at)
     VALUES ($1, $2, $3, 'https://cb', 'chal', 'mcp', now() + interval '5 minutes', NULL)`,
    [`gc-live-code-${liveCodeStaleId}`, liveCodeStaleId, codeUserId],
  )

  // A stale client whose ONLY grant is an EXPIRED, unused code (hit /authorize,
  // never exchanged): no token, no live code -> collectable.
  expiredCodeStaleId = await seedClient('expired-code-stale', STALE)
  await ownerPool.query(
    `INSERT INTO oauth_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, used_at)
     VALUES ($1, $2, $3, 'https://cb', 'chal', 'mcp', now() - interval '1 hour', NULL)`,
    [`gc-expired-code-${expiredCodeStaleId}`, expiredCodeStaleId, codeUserId],
  )
})

afterAll(async () => {
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [tokenStaleId])
  await ownerPool.query('DELETE FROM oauth_codes WHERE client_id = ANY($1)', [
    [liveCodeStaleId, expiredCodeStaleId],
  ])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [
    [idleStaleId, usedStaleId, idleFreshId, tokenStaleId, liveCodeStaleId, expiredCodeStaleId],
  ])
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [[tokenUserId, codeUserId]])
  await closeDb()
  await closePools()
})

describe('oauth client GC (admin path, real DB)', () => {
  it('lists only never-used clients older than the cutoff', async () => {
    const candidates = await listGarbageCollectableClients(CUTOFF)
    expect(candidates).toContain(idleStaleId)
    // A used client (last_used_at set) is excluded even though it is old.
    expect(candidates).not.toContain(usedStaleId)
    // A never-used but recently-registered client is excluded (age gate).
    expect(candidates).not.toContain(idleFreshId)
    // last_used_at IS NULL + stale, but it HAS a token row: the token-existence
    // guard excludes it so its grant is never CASCADE-orphaned (data-loss fix).
    expect(candidates).not.toContain(tokenStaleId)
    // Stale with only a LIVE pending code (mid-flight authorize): KEPT.
    expect(candidates).not.toContain(liveCodeStaleId)
    // Stale with only an EXPIRED, unused code (abandoned authorize, never
    // exchanged, no cleanup job removes it): collectable — a dead code must not
    // pin a client out of GC forever.
    expect(candidates).toContain(expiredCodeStaleId)
  })

  it('keeps a client with only a live pending code; collects one with only an expired code', async () => {
    // The live-code client survives the delete (re-asserts the grant guard).
    expect(await deleteClients([liveCodeStaleId])).toBe(0)
    expect(await getClientByClientId(liveCodeStaleId)).toBeDefined()
    // The expired-code-only client is deletable (its code is not a live grant).
    // Its orphan code row goes with it via ON DELETE CASCADE — harmless, it was
    // already expired and unusable.
    expect(await deleteClients([expiredCodeStaleId])).toBe(1)
    expect(await getClientByClientId(expiredCodeStaleId)).toBeUndefined()
  })

  it('does not delete a stale, last_used_at-NULL client that has a token row', async () => {
    // Force the id past the scan straight into the delete: even if the scan were
    // bypassed, the DELETE predicate re-asserts the token-existence guard.
    const deleted = await deleteClients([tokenStaleId])
    expect(deleted).toBe(0)
    expect(await getClientByClientId(tokenStaleId)).toBeDefined()
  })

  it('deletes the collected clients and keeps the rest', async () => {
    const deleted = await deleteClients([idleStaleId])
    expect(deleted).toBe(1)
    expect(await getClientByClientId(idleStaleId)).toBeUndefined()
    // The used and fresh clients survive the GC.
    expect(await getClientByClientId(usedStaleId)).toBeDefined()
    expect(await getClientByClientId(idleFreshId)).toBeDefined()
  })

  it('deleting an empty set is a no-op', async () => {
    expect(await deleteClients([])).toBe(0)
  })

  it('skips a client that became used between scan and delete (TOCTOU guard)', async () => {
    // Simulate the race: a never-used stale client is selected by the scan, then
    // completes a token exchange (last_used_at stamped) before the delete runs.
    const racedId = await seedClient('raced-stale', STALE)
    try {
      const candidates = await listGarbageCollectableClients(CUTOFF)
      expect(candidates).toContain(racedId)
      // Token exchange lands in the window: last_used_at is now set.
      await updateLastUsedAt(racedId)
      // The delete re-asserts last_used_at IS NULL, so the now-active client is skipped.
      const deleted = await deleteClients([racedId])
      expect(deleted).toBe(0)
      expect(await getClientByClientId(racedId)).toBeDefined()
    } finally {
      await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [racedId])
    }
  })
})
