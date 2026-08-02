// SPDX-License-Identifier: Apache-2.0
// Bi-temporal facts read (slice 2: get_facts + as_of) exercised through the
// RUNTIME role via withTenant() — the production path. Owner bypasses RLS and
// would prove nothing (docs/concepts/testing.mdx). The write path lands separately, so rows
// are seeded directly (owner connection) — precedent: search.int.test.ts.
//
// Seed: a supersession chain superseded TWICE plus a late-recorded correction.
//
//   subject="employee:42" predicate="role" — three valid-time generations:
//     v1 "engineer": valid [T0, T1), recorded R0
//     v2 "lead":     valid [T1, T2), recorded R1
//     v3 "manager":  valid [T2,  ∞), recorded R2   <- live (valid_to IS NULL)
//
//   subject="employee:42" predicate="city" — the classic bi-temporal case. We
//   LEARN on a late date that the city WAS "berlin" back at TPAST:
//     valid_from = TPAST (true in the past), recorded_at = RLATE (known late).
//   Before RLATE, asKnownAt sees nothing; from RLATE on, it sees it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { getFacts } from '../../src/facts-read.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

// Valid-time generations (UTC, far in the past so "now" never collides).
const T0 = '2020-01-01T00:00:00.000Z'
const T1 = '2021-01-01T00:00:00.000Z'
const T2 = '2022-01-01T00:00:00.000Z'
// Transaction-time (knowledge) instants.
const R0 = '2020-01-01T00:00:00.000Z'
const R1 = '2021-01-01T00:00:00.000Z'
const R2 = '2022-01-01T00:00:00.000Z'
// Late-recorded correction: true in the past, learned late.
const TPAST = '2019-06-01T00:00:00.000Z'
const RLATE = '2023-06-01T00:00:00.000Z'

let uid: string

/** A facts row needs a parent memory (composite FK). Returns the memory id. */
async function seedMemory(userId: string): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
     VALUES ($1, 'fact', $2, $3, $4) RETURNING id`,
    [userId, 'facts-read-topic', 'facts-read-content', `facts-read-${userId}-${Date.now()}`],
  )
  return r.rows[0].id
}

async function seedFact(
  userId: string,
  memoryId: string,
  subject: string,
  predicate: string,
  value: string,
  validFrom: string,
  validTo: string | null,
  recordedAt: string,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO facts (user_id, memory_id, subject, predicate, value,
                        valid_from, valid_to, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz)`,
    [userId, memoryId, subject, predicate, value, validFrom, validTo, recordedAt],
  )
}

beforeAll(async () => {
  await resetDomainTables()
  uid = await seedUser('facts-read@test.local')
  const memoryId = await seedMemory(uid)
  // role: three generations, the last live (valid_to NULL).
  await seedFact(uid, memoryId, 'employee:42', 'role', 'engineer', T0, T1, R0)
  await seedFact(uid, memoryId, 'employee:42', 'role', 'lead', T1, T2, R1)
  await seedFact(uid, memoryId, 'employee:42', 'role', 'manager', T2, null, R2)
  // city: late-recorded, true-in-the-past, still open-ended valid window.
  await seedFact(uid, memoryId, 'employee:42', 'city', 'berlin', TPAST, null, RLATE)
}, 120_000)

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('get_facts — current-row default (valid_to IS NULL)', () => {
  it('returns only the LIVE generation for a (subject, predicate)', async () => {
    const rows = await withTenant(uid, (tx) =>
      getFacts(tx, uid, { subject: 'employee:42', predicate: 'role' }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('manager')
    expect(rows[0]?.validTo).toBeNull()
  })

  it('list mode (no filters) returns one live row per key, recency-ordered', async () => {
    const rows = await withTenant(uid, (tx) => getFacts(tx, uid))
    // two live keys: role->manager (recorded R2) and city->berlin (recorded RLATE)
    expect(rows.map((r) => r.value).sort()).toEqual(['berlin', 'manager'])
    // recency axis = recorded_at DESC: city (RLATE 2023) before role (R2 2022)
    expect(rows[0]?.value).toBe('berlin')
    const recordedDesc = [...rows].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
    expect(rows.map((r) => r.id)).toEqual(recordedDesc.map((r) => r.id))
  })

  it('empty result for an unknown key is an empty array, not a throw', async () => {
    const rows = await withTenant(uid, (tx) =>
      getFacts(tx, uid, { subject: 'employee:42', predicate: 'nonexistent' }),
    )
    expect(rows).toEqual([])
  })

  it('limit bounds the list-mode window to the N most-recent rows (no-firehose)', async () => {
    // Two live keys exist; limit 1 returns only the single most-recent row.
    const rows = await withTenant(uid, (tx) => getFacts(tx, uid, { limit: 1 }))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('berlin') // recency-ordered: most recent first
  })
})

describe('get_facts — as_of valid-time (validAt: what was TRUE at t)', () => {
  it('returns the historically-true generation at three points', async () => {
    const at = (iso: string) =>
      withTenant(uid, (tx) =>
        getFacts(tx, uid, {
          subject: 'employee:42',
          predicate: 'role',
          asOf: { validAt: new Date(iso) },
        }),
      )
    // inside [T0, T1) -> engineer
    const early = await at('2020-06-01T00:00:00.000Z')
    expect(early).toHaveLength(1)
    expect(early[0]?.value).toBe('engineer')
    // inside [T1, T2) -> lead
    const mid = await at('2021-06-01T00:00:00.000Z')
    expect(mid).toHaveLength(1)
    expect(mid[0]?.value).toBe('lead')
    // inside [T2, ∞) -> manager (the live row)
    const late = await at('2022-06-01T00:00:00.000Z')
    expect(late).toHaveLength(1)
    expect(late[0]?.value).toBe('manager')
  })

  it('boundary is half-open: valid_to is exclusive (the successor wins at T)', async () => {
    // At exactly T1, v1's window [T0, T1) has ended and v2's [T1, T2) has begun.
    const rows = await withTenant(uid, (tx) =>
      getFacts(tx, uid, {
        subject: 'employee:42',
        predicate: 'role',
        asOf: { validAt: new Date(T1) },
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('lead')
  })

  it('before the first generation existed, nothing was true (empty)', async () => {
    const rows = await withTenant(uid, (tx) =>
      getFacts(tx, uid, {
        subject: 'employee:42',
        predicate: 'role',
        asOf: { validAt: new Date('2010-01-01T00:00:00.000Z') },
      }),
    )
    expect(rows).toEqual([])
  })
})

describe('get_facts — as_of transaction-time (asKnownAt: what we KNEW at t)', () => {
  it('differs before vs after a late-recorded correction', async () => {
    const cityAt = (iso: string) =>
      withTenant(uid, (tx) =>
        getFacts(tx, uid, {
          subject: 'employee:42',
          predicate: 'city',
          asOf: { asKnownAt: new Date(iso) },
        }),
      )
    // BEFORE RLATE: we had not yet recorded the city fact -> unknown -> empty.
    const before = await cityAt('2023-01-01T00:00:00.000Z')
    expect(before).toEqual([])
    // AFTER RLATE: the correction is now in our knowledge -> visible.
    const after = await cityAt('2024-01-01T00:00:00.000Z')
    expect(after).toHaveLength(1)
    expect(after[0]?.value).toBe('berlin')
  })

  it('asKnownAt hides generations recorded after the instant', async () => {
    // Known only as of R1: v3 ("manager", recorded R2) is not yet recorded, so
    // the live-row default among known rows is v2 ("lead", valid_to set but the
    // only row whose recorded_at <= R1 AND valid_to IS NULL would be none).
    // We assert via validAt+asKnownAt below; here check pure asKnownAt on role
    // with the current-row default: at R1 the live (valid_to IS NULL) row v3 is
    // not yet known, so the default (live) read returns nothing.
    const rows = await withTenant(uid, (tx) =>
      getFacts(tx, uid, {
        subject: 'employee:42',
        predicate: 'role',
        asOf: { asKnownAt: new Date(R1) },
      }),
    )
    // v3 (the only valid_to IS NULL row) was recorded at R2 > R1, so unknown.
    expect(rows).toEqual([])
  })
})

describe('get_facts — combined axes (true-at-X as-known-at-Y)', () => {
  it('true-at-T2 as-known-at-R1 returns the best knowledge available then', async () => {
    // At valid-time inside [T1, T2) the true role was "lead" (recorded R1). As
    // known at R1, lead IS recorded, so it surfaces.
    const rows = await withTenant(uid, (tx) =>
      getFacts(tx, uid, {
        subject: 'employee:42',
        predicate: 'role',
        asOf: { validAt: new Date('2021-06-01T00:00:00.000Z'), asKnownAt: new Date(R1) },
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('lead')
  })

  it('true-at-now as-known-at-R1 is empty: the live row was not yet recorded', async () => {
    // The currently-true role ("manager") was recorded at R2. Travelling to
    // knowledge-time R1 (< R2), that generation did not yet exist for us.
    const rows = await withTenant(uid, (tx) =>
      getFacts(tx, uid, {
        subject: 'employee:42',
        predicate: 'role',
        asOf: { validAt: new Date('2022-06-01T00:00:00.000Z'), asKnownAt: new Date(R1) },
      }),
    )
    expect(rows).toEqual([])
  })

  it('city true-at-2020 as-known-at-now: late record visible, past truth holds', async () => {
    const rows = await withTenant(uid, (tx) =>
      getFacts(tx, uid, {
        subject: 'employee:42',
        predicate: 'city',
        asOf: {
          validAt: new Date('2020-01-01T00:00:00.000Z'),
          asKnownAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('berlin')
  })
})

describe('get_facts — tenant isolation (RLS on every path)', () => {
  it('a second tenant never sees the first tenant facts on any read path', async () => {
    const otherUid = await seedUser('facts-read-other@test.local')
    try {
      const liveQueries = [
        { subject: 'employee:42', predicate: 'role' },
        {},
        {
          subject: 'employee:42',
          predicate: 'role',
          asOf: { validAt: new Date('2021-06-01T00:00:00.000Z') },
        },
        {
          subject: 'employee:42',
          predicate: 'city',
          asOf: { asKnownAt: new Date('2024-01-01T00:00:00.000Z') },
        },
      ]
      for (const q of liveQueries) {
        const rows = await withTenant(otherUid, (tx) => getFacts(tx, otherUid, q))
        expect(rows).toEqual([])
      }
    } finally {
      await ownerPool.query(`DELETE FROM users WHERE id = $1`, [otherUid])
    }
  })
})
