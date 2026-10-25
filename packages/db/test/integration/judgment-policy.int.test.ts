// SPDX-License-Identifier: Apache-2.0
// Judgment opt-in store (issue #225) exercised through the RUNTIME role via
// withTenant(), the production path (the table is FORCE RLS).
//
// Covers, at the db layer:
//   - no row -> null (mode 'off' is core's default, never a fabricated row)
//   - upsert round-trip: on -> read -> off
//   - the DB CHECK rejects an unknown mode
//   - tenant isolation through the accessors AND raw SQL bound to the other tenant
//   - RLS fails closed with no tenant bound, and the table is FORCE RLS (0043)
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { getJudgmentPolicy, upsertJudgmentPolicy } from '../../src/judgment-policy.js'
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
  userA = await seedUser(`judgment-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`judgment-b-${crypto.randomUUID()}@test.local`)
})

afterAll(closePools)

describe('judgment opt-in store (runtime role, withTenant)', () => {
  it('returns null when the user never set a policy', async () => {
    expect(await withTenant(userA, (tx) => getJudgmentPolicy(tx, userA))).toBeNull()
  })

  it('round-trips on -> read -> off', async () => {
    const on = await withTenant(userA, (tx) => upsertJudgmentPolicy(tx, userA, 'on'))
    expect(on.mode).toBe('on')
    expect((await withTenant(userA, (tx) => getJudgmentPolicy(tx, userA)))?.mode).toBe('on')
    const off = await withTenant(userA, (tx) => upsertJudgmentPolicy(tx, userA, 'off'))
    expect(off.mode).toBe('off')
    expect(off.updatedAt.getTime()).toBeGreaterThanOrEqual(on.updatedAt.getTime())
  })

  it('the DB CHECK rejects an unknown mode', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the type to hit the DB CHECK
      withTenant(userA, (tx) => upsertJudgmentPolicy(tx, userA, 'always' as any)),
    ).rejects.toThrow()
  })

  it('isolates tenants through the accessors: B never sees or overwrites A', async () => {
    await withTenant(userA, (tx) => upsertJudgmentPolicy(tx, userA, 'on'))
    expect(await withTenant(userB, (tx) => getJudgmentPolicy(tx, userB))).toBeNull()
    await withTenant(userB, (tx) => upsertJudgmentPolicy(tx, userB, 'off'))
    expect((await withTenant(userA, (tx) => getJudgmentPolicy(tx, userA)))?.mode).toBe('on')
  })

  it('RLS blocks raw cross-tenant reads, updates, and inserts as the runtime role', async () => {
    await withTenant(userA, (tx) => upsertJudgmentPolicy(tx, userA, 'off'))
    await withTestTransaction(async (conn) => {
      await conn.query(`SELECT set_config('app.user_id', $1, true)`, [userB])
      const read = await conn.query('SELECT * FROM user_judgment_policy WHERE user_id = $1', [
        userA,
      ])
      expect(read.rowCount).toBe(0)
      // B cannot opt A in.
      const updated = await conn.query(
        `UPDATE user_judgment_policy SET mode = 'on' WHERE user_id = $1`,
        [userA],
      )
      expect(updated.rowCount).toBe(0)
      await expect(
        conn.query(
          `INSERT INTO user_judgment_policy (user_id, mode) VALUES ($1, 'on')
           ON CONFLICT (user_id) DO NOTHING`,
          [userA],
        ),
      ).rejects.toThrow(/row-level security/)
    })
    expect((await withTenant(userA, (tx) => getJudgmentPolicy(tx, userA)))?.mode).toBe('off')
  })

  it('RLS fails closed with no tenant bound (no app.user_id)', async () => {
    await withTenant(userA, (tx) => upsertJudgmentPolicy(tx, userA, 'on'))
    await withTestTransaction(async (conn) => {
      const r = await conn.query('SELECT * FROM user_judgment_policy')
      expect(r.rowCount).toBe(0)
    })
  })

  it('FORCEs RLS: the table is in the forced tenant set', async () => {
    const r = await ownerPool.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'user_judgment_policy'`,
    )
    expect(r.rows[0]?.relforcerowsecurity).toBe(true)
  })
})
