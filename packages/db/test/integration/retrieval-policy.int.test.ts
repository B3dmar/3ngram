// SPDX-License-Identifier: Apache-2.0
// Retrieval-scope policy store (issue #47) exercised through the RUNTIME role
// via withTenant() — the production path (owner bypasses RLS and proves
// nothing, docs/concepts/testing.mdx).
//
// Covers the PR-1 acceptance criteria at the db layer:
//   - no row -> null (mode 'off' is core's default, never a fabricated row)
//   - upsert round-trip: set -> read -> replace (full replace, not a merge)
//   - the DB CHECK backstop mirrors the schema refinement: a drifting
//     mode/scope pair is rejected whatever path writes it
//   - tenant isolation: user B never sees user A's policy (RLS + the
//     caller-bound predicate)
//   - FORCE RLS: the table is in the forced set (0030), so even the owner
//     role is subject to tenant_isolation
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { getRetrievalPolicy, upsertRetrievalPolicy } from '../../src/retrieval-policy.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string
let userB: string

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`retrieval-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`retrieval-b-${crypto.randomUUID()}@test.local`)
})

afterAll(closePools)

describe('retrieval policy store (runtime role, withTenant)', () => {
  it('returns null when the user never set a policy', async () => {
    const policy = await withTenant(userA, (tx) => getRetrievalPolicy(tx, userA))
    expect(policy).toBeNull()
  })

  it('round-trips set -> read -> replace', async () => {
    const set = await withTenant(userA, (tx) =>
      upsertRetrievalPolicy(tx, userA, { mode: 'default', defaultScope: 'work' }),
    )
    expect(set.mode).toBe('default')
    expect(set.defaultScope).toBe('work')

    const read = await withTenant(userA, (tx) => getRetrievalPolicy(tx, userA))
    expect(read?.mode).toBe('default')
    expect(read?.defaultScope).toBe('work')

    // Full replace: switching to 'require' clears the scope in the same upsert.
    const replaced = await withTenant(userA, (tx) =>
      upsertRetrievalPolicy(tx, userA, { mode: 'require', defaultScope: null }),
    )
    expect(replaced.mode).toBe('require')
    expect(replaced.defaultScope).toBeNull()
    expect(replaced.updatedAt.getTime()).toBeGreaterThanOrEqual(set.updatedAt.getTime())

    const after = await withTenant(userA, (tx) => getRetrievalPolicy(tx, userA))
    expect(after?.mode).toBe('require')
    expect(after?.defaultScope).toBeNull()
  })

  it('the DB CHECK backstop rejects a drifting mode/scope pair', async () => {
    // 'default' without a scope: nothing to apply — the schema boundary
    // rejects it first in production; the CHECK is the defense in depth.
    await expect(
      withTenant(userA, (tx) =>
        upsertRetrievalPolicy(tx, userA, { mode: 'default', defaultScope: null }),
      ),
    ).rejects.toThrow()
    // 'off' carrying a scope: a stored value that no mode would ever apply.
    await expect(
      withTenant(userA, (tx) =>
        upsertRetrievalPolicy(tx, userA, { mode: 'off', defaultScope: 'work' }),
      ),
    ).rejects.toThrow()
  })

  it('rejects an unregistered mode value (Zod-derived CHECK)', async () => {
    await expect(
      withTenant(userA, (tx) =>
        upsertRetrievalPolicy(tx, userA, {
          // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the type to hit the DB CHECK
          mode: 'everything' as any,
          defaultScope: null,
        }),
      ),
    ).rejects.toThrow()
  })

  it('isolates tenants: user B never sees or overwrites user A policy', async () => {
    await withTenant(userA, (tx) =>
      upsertRetrievalPolicy(tx, userA, { mode: 'default', defaultScope: 'work' }),
    )
    const bView = await withTenant(userB, (tx) => getRetrievalPolicy(tx, userB))
    expect(bView).toBeNull()

    // B setting its own policy must not disturb A's row.
    await withTenant(userB, (tx) =>
      upsertRetrievalPolicy(tx, userB, { mode: 'require', defaultScope: null }),
    )
    const aView = await withTenant(userA, (tx) => getRetrievalPolicy(tx, userA))
    expect(aView?.mode).toBe('default')
    expect(aView?.defaultScope).toBe('work')
  })

  it('FORCEs RLS: the table is in the forced tenant set', async () => {
    const r = await ownerPool.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'user_retrieval_policy'`,
    )
    expect(r.rows[0]?.relforcerowsecurity).toBe(true)
  })
})
