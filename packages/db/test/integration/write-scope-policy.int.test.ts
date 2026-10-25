// SPDX-License-Identifier: Apache-2.0
// Write-scope policy store (issue #235) exercised through the RUNTIME role via
// withTenant(), the production path (the owner bypasses nothing useful here:
// the table is FORCE RLS, docs/concepts/testing.mdx).
//
// Covers, at the db layer:
//   - no row -> null (mode 'off' is core's default, never a fabricated row)
//   - upsert round-trip: set -> read -> replace (full replace, not a merge)
//   - the DB CHECK backstop mirrors the schema refinement
//   - tenant isolation: another tenant can neither read nor write the row,
//     through the accessors OR through raw SQL bound to the other tenant
//   - replaceWriteScopePolicyDefault only touches a matching active default
//   - FORCE RLS: the table is in the forced set (0039)
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import {
  getWriteScopePolicy,
  replaceWriteScopePolicyDefault,
  upsertWriteScopePolicy,
} from '../../src/write-scope-policy.js'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
  withTestTransaction,
} from './helpers.js'

let userA: string
let userB: string

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`write-scope-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`write-scope-b-${crypto.randomUUID()}@test.local`)
})

afterAll(closePools)

describe('write-scope policy store (runtime role, withTenant)', () => {
  it('returns null when the user never set a policy', async () => {
    expect(await withTenant(userA, (tx) => getWriteScopePolicy(tx, userA))).toBeNull()
  })

  it('round-trips set -> read -> replace', async () => {
    const set = await withTenant(userA, (tx) =>
      upsertWriteScopePolicy(tx, userA, { mode: 'default', defaultScope: 'work' }),
    )
    expect(set).toMatchObject({ mode: 'default', defaultScope: 'work' })
    expect(await withTenant(userA, (tx) => getWriteScopePolicy(tx, userA))).toMatchObject({
      mode: 'default',
      defaultScope: 'work',
    })

    const replaced = await withTenant(userA, (tx) =>
      upsertWriteScopePolicy(tx, userA, { mode: 'require', defaultScope: null }),
    )
    expect(replaced).toMatchObject({ mode: 'require', defaultScope: null })
    expect(replaced.updatedAt.getTime()).toBeGreaterThanOrEqual(set.updatedAt.getTime())
    expect(await withTenant(userA, (tx) => getWriteScopePolicy(tx, userA))).toMatchObject({
      mode: 'require',
      defaultScope: null,
    })
  })

  it('the DB CHECK backstop rejects a drifting mode/scope pair and an unknown mode', async () => {
    for (const policy of [
      { mode: 'default' as const, defaultScope: null },
      { mode: 'off' as const, defaultScope: 'work' },
      { mode: 'require' as const, defaultScope: 'work' },
    ]) {
      await expect(
        withTenant(userA, (tx) => upsertWriteScopePolicy(tx, userA, policy)),
      ).rejects.toThrow()
    }
    await expect(
      withTenant(userA, (tx) =>
        upsertWriteScopePolicy(tx, userA, {
          // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the type to hit the DB CHECK
          mode: 'always' as any,
          defaultScope: null,
        }),
      ),
    ).rejects.toThrow()
  })

  it('isolates tenants through the accessors: B never sees or overwrites A', async () => {
    await withTenant(userA, (tx) =>
      upsertWriteScopePolicy(tx, userA, { mode: 'default', defaultScope: 'work' }),
    )
    expect(await withTenant(userB, (tx) => getWriteScopePolicy(tx, userB))).toBeNull()

    await withTenant(userB, (tx) =>
      upsertWriteScopePolicy(tx, userB, { mode: 'require', defaultScope: null }),
    )
    expect(await withTenant(userA, (tx) => getWriteScopePolicy(tx, userA))).toMatchObject({
      mode: 'default',
      defaultScope: 'work',
    })
  })

  it('RLS blocks raw cross-tenant reads, updates, and inserts as the runtime role', async () => {
    await withTenant(userA, (tx) =>
      upsertWriteScopePolicy(tx, userA, { mode: 'default', defaultScope: 'work' }),
    )
    await withTestTransaction(async (conn) => {
      await conn.query(`SELECT set_config('app.user_id', $1, true)`, [userB])
      // Read: A's row is invisible even when asked for by id.
      const read = await conn.query('SELECT * FROM user_write_scope_policy WHERE user_id = $1', [
        userA,
      ])
      expect(read.rowCount).toBe(0)
      // Update: matches nothing (USING filters A's row out).
      const updated = await conn.query(
        `UPDATE user_write_scope_policy SET mode = 'require', default_scope = NULL WHERE user_id = $1`,
        [userA],
      )
      expect(updated.rowCount).toBe(0)
      // Insert on A's behalf: WITH CHECK rejects it.
      await expect(
        conn.query(
          `INSERT INTO user_write_scope_policy (user_id, mode, default_scope) VALUES ($1, 'off', NULL)
           ON CONFLICT (user_id) DO NOTHING`,
          [userA],
        ),
      ).rejects.toThrow(/row-level security/)
    })
    // A's row is untouched.
    expect(await withTenant(userA, (tx) => getWriteScopePolicy(tx, userA))).toMatchObject({
      mode: 'default',
      defaultScope: 'work',
    })
  })

  it('RLS fails closed with no tenant bound (no app.user_id)', async () => {
    await withTenant(userA, (tx) =>
      upsertWriteScopePolicy(tx, userA, { mode: 'default', defaultScope: 'work' }),
    )
    await withTestTransaction(async (conn) => {
      const r = await conn.query('SELECT * FROM user_write_scope_policy')
      expect(r.rowCount).toBe(0)
    })
  })

  it('replaceWriteScopePolicyDefault rewrites only a matching active default', async () => {
    await withTenant(userA, (tx) =>
      upsertWriteScopePolicy(tx, userA, { mode: 'default', defaultScope: 'work' }),
    )
    await withTenant(userB, (tx) =>
      upsertWriteScopePolicy(tx, userB, { mode: 'default', defaultScope: 'work' }),
    )
    // Non-matching scope: no change.
    await withTenant(userA, (tx) =>
      replaceWriteScopePolicyDefault(tx, userA, 'other', { mode: 'require', defaultScope: null }),
    )
    expect((await withTenant(userA, (tx) => getWriteScopePolicy(tx, userA)))?.defaultScope).toBe(
      'work',
    )
    // Matching scope: renamed, and only for the caller.
    await withTenant(userA, (tx) =>
      replaceWriteScopePolicyDefault(tx, userA, 'work', { mode: 'default', defaultScope: 'job' }),
    )
    expect(await withTenant(userA, (tx) => getWriteScopePolicy(tx, userA))).toMatchObject({
      mode: 'default',
      defaultScope: 'job',
    })
    expect(await withTenant(userB, (tx) => getWriteScopePolicy(tx, userB))).toMatchObject({
      mode: 'default',
      defaultScope: 'work',
    })
  })

  it('FORCEs RLS: the table is in the forced tenant set', async () => {
    const r = await ownerPool.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'user_write_scope_policy'`,
    )
    expect(r.rows[0]?.relforcerowsecurity).toBe(true)
  })
})
