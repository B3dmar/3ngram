// SPDX-License-Identifier: Apache-2.0
// API-key wrappers against the REAL runtime role (app_user, NOBYPASSRLS) —
// owner bypasses RLS and would prove nothing (docs/concepts/testing.mdx). Covers the
// SECURITY DEFINER resolve path, the withTenant() INSERT/list/revoke paths,
// revoked-key filtering, last_used_at stamping, and that one tenant cannot
// read or revoke another tenant's keys (cross-tenant exit criterion).
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  insertApiKey,
  listApiKeys,
  resolveApiKey,
  revokeApiKey,
  touchApiKeyLastUsed,
} from '../../src/auth-api-keys.js'
import { closeDb } from '../../src/client.js'
import { closePools, ownerPool, seedUser } from './helpers.js'

const hash = (key: string) => createHash('sha256').update(key).digest('hex')

let userA: string
let userB: string

beforeAll(async () => {
  userA = await seedUser('apikey-a@test.local')
  userB = await seedUser('apikey-b@test.local')
})

afterAll(async () => {
  await ownerPool.query('DELETE FROM api_keys WHERE user_id = ANY($1)', [[userA, userB]])
  await closeDb()
  await closePools()
})

describe('auth-api-keys (runtime role, real withTenant + SECURITY DEFINER)', () => {
  it('inserts a key and resolves it back to its owner', async () => {
    const keyHash = hash(`3ng_p_${randomUUID()}`)
    const { id } = await insertApiKey(userA, 'ci', keyHash, 'p')
    expect(typeof id).toBe('string')
    const resolved = await resolveApiKey(keyHash)
    expect(resolved?.userId).toBe(userA)
  })

  it('returns undefined for an unknown key hash', async () => {
    expect(await resolveApiKey(hash(randomUUID()))).toBeUndefined()
  })

  it('does not resolve a revoked key (resolver filters revoked_at IS NULL)', async () => {
    const keyHash = hash(`3ng_r_${randomUUID()}`)
    const { id } = await insertApiKey(userA, 'to-revoke', keyHash, 'r')
    expect(await revokeApiKey(userA, id)).toBe(true)
    expect(await resolveApiKey(keyHash)).toBeUndefined()
  })

  it('lists metadata for the owner and never exposes the hash', async () => {
    const owner = await seedUser('apikey-list@test.local')
    try {
      const keyHash = hash(`3ng_l_${randomUUID()}`)
      await insertApiKey(owner, 'listed', keyHash, 'l')
      const keys = await listApiKeys(owner)
      const listed = keys.find((k) => k.prefix === 'l')
      expect(listed?.name).toBe('listed')
      // metadata shape carries no hash field at all
      expect(Object.keys(listed ?? {})).not.toContain('keyHash')
      expect(JSON.stringify(keys)).not.toContain(keyHash)
    } finally {
      await ownerPool.query('DELETE FROM api_keys WHERE user_id = $1', [owner])
    }
  })

  it('stamps last_used_at via the tenant-scoped wrapper', async () => {
    const keyHash = hash(`3ng_t_${randomUUID()}`)
    await insertApiKey(userA, 'touched', keyHash, 't')
    await touchApiKeyLastUsed(userA, keyHash)
    const keys = await listApiKeys(userA)
    const touched = keys.find((k) => k.prefix === 't')
    expect(touched?.lastUsedAt).toBeInstanceOf(Date)
  })

  it('isolates tenants: user B cannot list or revoke user A keys (RLS)', async () => {
    const keyHash = hash(`3ng_iso_${randomUUID()}`)
    const { id } = await insertApiKey(userA, 'a-private', keyHash, 'iso')

    // B's list never contains A's key.
    const bKeys = await listApiKeys(userB)
    expect(bKeys.find((k) => k.id === id)).toBeUndefined()

    // B's revoke of A's id matches nothing (RLS makes the row invisible).
    expect(await revokeApiKey(userB, id)).toBe(false)

    // A's key still resolves — B could not revoke it.
    expect((await resolveApiKey(keyHash))?.userId).toBe(userA)
  })

  it('rejects a forged key for another user (RLS WITH CHECK on the INSERT)', async () => {
    const { withTenant } = await import('../../src/client.js')
    const { sql } = await import('drizzle-orm')
    await expect(
      withTenant(userB, (tx) =>
        tx.execute(
          sql`INSERT INTO api_keys (user_id, name, key_hash, prefix)
              VALUES (${userA}, 'forged', ${hash(randomUUID())}, 'fk')`,
        ),
      ),
    ).rejects.toSatisfy((e: Error) =>
      /row-level security/.test(String((e as { cause?: unknown }).cause ?? e)),
    )
  })
})
