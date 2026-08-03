// SPDX-License-Identifier: Apache-2.0
// Integration — search filters V2: the memoryTypes OR-set and the recorded_at
// range (issue #48), exercised through the RUNTIME role (RLS) like the V1
// suite. Split from search-filters.int.test.ts for the 500-line file cap; the
// SAME dimensional matrix is seeded via ./search-filters-fixture.js so both
// suites assert against identical rows. Files run sequentially
// (--fileParallelism=false), so per-file resetDomainTables cannot interleave.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { searchFused } from '../../src/search.js'
import { closePools, resetDomainTables, seedUser } from './helpers.js'
import {
  BIG,
  FTS_ONLY,
  fakeEmbedding,
  keysOf as keysOfWith,
  SEED,
  seedMatrix,
} from './search-filters-fixture.js'

let uid: string
let idByKey = new Map<string, string>()

beforeAll(async () => {
  await resetDomainTables()
  uid = await seedUser('search-filters-v2@test.local')
  idByKey = await seedMatrix(uid)
}, 120_000)

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

const keysOf = (hits: { id: string }[]): string[] => keysOfWith(idByKey, hits)

describe('searchFused filters V2 — memoryTypes OR-set + recorded_at range (#48)', () => {
  // Reuses the dimensional SEED matrix: recorded_at runs 2026-01-01..01-06 one
  // day apart per row, so range bounds can slice it deterministically.

  it('memoryTypes narrows to the OR-set (= ANY), across both matching types', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        memoryTypes: ['note', 'decision'],
      }),
    )
    const keys = keysOf(hits).sort()
    expect(keys).toEqual(
      SEED.filter((r) => r.status === 'active' && ['note', 'decision'].includes(r.memoryType))
        .map((r) => r.key)
        .sort(),
    )
  })

  it('a single-element memoryTypes behaves like the scalar memoryType filter', async () => {
    const viaList = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        memoryTypes: ['note'],
      }),
    )
    const viaScalar = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, { memoryType: 'note' }),
    )
    expect(keysOf(viaList)).toEqual(keysOf(viaScalar))
    expect(keysOf(viaList)).toEqual(['d_note_work_p1'])
  })

  it('recordedAfter narrows to rows recorded at/after the bound (inclusive)', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        recordedAfter: new Date('2026-01-03T00:00:00Z'),
      }),
    )
    const keys = keysOf(hits).sort()
    // Inclusive bound: the row recorded exactly AT 01-03 is in. Archived row
    // (recorded 01-06) stays out — the range never lifts the active default.
    expect(keys).toEqual(['d_dec_personal_p1', 'd_dec_work_null', 'd_dec_work_p2'])
  })

  it('recordedBefore narrows to rows recorded at/before the bound (inclusive)', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        recordedBefore: new Date('2026-01-02T00:00:00Z'),
      }),
    )
    expect(keysOf(hits).sort()).toEqual(['d_dec_work_p1', 'd_note_work_p1'])
  })

  it('recordedAfter + recordedBefore compose into a closed range', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        recordedAfter: new Date('2026-01-02T00:00:00Z'),
        recordedBefore: new Date('2026-01-04T00:00:00Z'),
      }),
    )
    expect(keysOf(hits).sort()).toEqual(['d_dec_personal_p1', 'd_dec_work_p2', 'd_note_work_p1'])
  })

  it('the range does NOT lift the active-only default (unlike asOf — not time travel)', async () => {
    // d_archived was recorded 2026-01-06 and sits INSIDE this range; a range
    // read must still exclude it because the live default holds (only an asOf
    // coordinate lifts it — the V1 time-travel tests prove that side).
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        recordedAfter: new Date('2026-01-05T00:00:00Z'),
        recordedBefore: new Date('2026-01-07T00:00:00Z'),
      }),
    )
    const keys = keysOf(hits)
    expect(keys).toEqual(['d_dec_work_null'])
    expect(keys).not.toContain('d_archived')
  })

  it('an explicit status filter still composes WITH the range (archived in-range row)', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        status: 'archived',
        recordedAfter: new Date('2026-01-05T00:00:00Z'),
      }),
    )
    expect(keysOf(hits)).toEqual(['d_archived'])
  })

  it('V2 axes compose (AND) with the existing V1 filters in one read', async () => {
    // types OR-set + range + scope + project together: only d_dec_work_p1
    // (decision, work, p1, recorded 01-01) survives every predicate.
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        memoryTypes: ['decision', 'fact'],
        recordedAfter: new Date('2026-01-01T00:00:00Z'),
        recordedBefore: new Date('2026-01-03T00:00:00Z'),
        scope: 'work',
        project: 'p1',
      }),
    )
    expect(keysOf(hits)).toEqual(['d_dec_work_p1'])
  })

  it('V2 axes narrow EVERY leg identically (no leak via recency/vector pools)', async () => {
    // No-lexical-match query -> FTS recalls nothing; recency+vector legs must
    // still honour the memoryTypes + range predicates (leg parity over the ONE
    // rowEligibility rule).
    const target = fakeEmbedding('d_note_work_p1')
    const hits = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        'zzzznolexicalmatch qqwx',
        BIG,
        { fts: 0, recency: 1, vector: 1 },
        undefined,
        target,
        { memoryTypes: ['decision'], recordedBefore: new Date('2026-01-04T00:00:00Z') },
      ),
    )
    const keys = keysOf(hits)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys).not.toContain('d_note_work_p1') // type-filtered out of every leg
    for (const k of keys) {
      const row = SEED.find((r) => r.key === k)
      expect(row?.memoryType).toBe('decision')
      expect(Date.parse(`${row?.recordedAt}T00:00:00Z`)).toBeLessThanOrEqual(
        Date.parse('2026-01-04T00:00:00Z'),
      )
    }
  })
})
