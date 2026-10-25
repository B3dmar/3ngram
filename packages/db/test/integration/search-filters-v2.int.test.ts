// SPDX-License-Identifier: Apache-2.0
// Integration — search filters V2: the memoryTypes OR-set and the recorded_at
// range (issue #48), exercised through the RUNTIME role (RLS) like the V1
// suite. Split from search-filters.int.test.ts for the 500-line file cap; the
// SAME dimensional matrix is seeded via ./search-filters-fixture.js so both
// suites assert against identical rows. Files run sequentially
// (--fileParallelism=false), so per-file resetDomainTables cannot interleave.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { fetchHitsByIds, type SearchHit, searchFts, searchFused } from '../../src/search.js'
import { searchList } from '../../src/search-list.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'
import {
  BIG,
  FTS_ONLY,
  fakeEmbedding,
  keysOf as keysOfWith,
  SEED,
  type SeedRow,
  seedMatrix,
  seedRow,
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

describe('search hit metadata — filing + commitment lifecycle (#319)', () => {
  // A SECOND tenant holds commitments in every live lifecycle state plus a
  // plain note, so the assertions also prove tenant isolation against `uid`.
  const row = (
    key: string,
    memoryType: string,
    scope: string,
    project: string | null,
    day: number,
  ) =>
    ({
      key,
      memoryType,
      scope,
      project,
      status: 'active',
      validFrom: `2026-02-0${day}`,
      validTo: null,
      recordedAt: `2026-02-0${day}`,
    }) satisfies SeedRow
  const ROWS = [
    { seed: row('c_open', 'commitment', 'work', 'p1', 1), commitment: 'open' },
    { seed: row('c_waiting', 'commitment', 'work', null, 2), commitment: 'waiting' },
    { seed: row('c_resolved', 'commitment', 'personal', 'p2', 3), commitment: 'resolved' },
    { seed: row('n_plain', 'note', 'work', null, 4), commitment: undefined },
  ]
  let other: string
  const otherIds = new Map<string, string>()

  beforeAll(async () => {
    other = await seedUser('search-hit-metadata@test.local')
    for (const r of ROWS) {
      const id = await seedRow(other, r.seed)
      otherIds.set(r.seed.key, id)
      if (r.commitment === undefined) continue
      await ownerPool.query(
        'INSERT INTO commitments (user_id, memory_id, status) VALUES ($1, $2, $3)',
        [other, id, r.commitment],
      )
    }
  })

  /** Expected per-key metadata; a non-commitment carries NO commitmentStatus key. */
  function expectMetadata(hits: SearchHit[]): void {
    const keyById = new Map([...otherIds.entries()].map(([k, v]) => [v, k] as const))
    expect(hits.map((h) => keyById.get(h.id)).sort()).toEqual(ROWS.map((r) => r.seed.key).sort())
    for (const hit of hits) {
      const r = ROWS.find((x) => x.seed.key === keyById.get(hit.id))
      expect(hit.scope).toBe(r?.seed.scope)
      expect(hit.project).toBe(r?.seed.project)
      if (r?.commitment === undefined) expect(hit).not.toHaveProperty('commitmentStatus')
      else expect(hit.commitmentStatus).toBe(r.commitment)
    }
  }

  it('ranked, page-continuation and chronological reads carry the same metadata', async () => {
    const [fused, byIds, list] = await withTenant(other, async (tx) => {
      const ranked = await searchFused(tx, other, 'alpha', BIG, FTS_ONLY)
      return [
        ranked,
        await fetchHitsByIds(tx, other, [...otherIds.values()]),
        await searchList(tx, other, BIG),
      ] as const
    })
    expectMetadata(fused)
    expectMetadata(byIds)
    expectMetadata(list.hits)
    // The join labels, never reorders: chronological stays recorded_at DESC.
    expect(list.hits.map((h) => h.id)).toEqual(
      ['n_plain', 'c_resolved', 'c_waiting', 'c_open'].map((k) => otherIds.get(k)),
    )
  })

  it('the standalone legs select the filing too', async () => {
    const hits = await withTenant(other, (tx) => searchFts(tx, other, 'alpha', BIG))
    expect(hits.find((h) => h.id === otherIds.get('c_resolved'))).toMatchObject({
      scope: 'personal',
      project: 'p2',
    })
  })

  it("stays tenant-isolated: neither tenant sees the other's rows or labels", async () => {
    const mine = await withTenant(uid, async (tx) => [
      ...(await searchFused(tx, uid, 'alpha', BIG, FTS_ONLY)),
      ...(await searchList(tx, uid, BIG)).hits,
      ...(await fetchHitsByIds(tx, uid, [...otherIds.values()])),
    ])
    const foreign = new Set(otherIds.values())
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.filter((h) => foreign.has(h.id))).toEqual([])
    expect(mine.filter((h) => h.commitmentStatus !== undefined)).toEqual([])
  })
})
