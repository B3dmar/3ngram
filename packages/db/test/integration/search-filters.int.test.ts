// SPDX-License-Identifier: Apache-2.0
// Integration — search FILTERS threaded into the fused query (slice
// A1), exercised through the RUNTIME role (RLS), the production path. Covers:
//   - each filter (type/scope/project/status) NARROWS the candidate set
//   - as_of bi-temporal time travel: valid-time, transaction-time, combined,
//     and over a supersession chain (surfaces history — docs/concepts/memory-model.mdx)
//   - filters compose WITH the fusion weights (they narrow, never reweight)
//   - tenant isolation (a second tenant's filtered read sees nothing)
//   - the count-consistency invariant: a filtered read returns EXACTLY the rows
//     matching the predicate, no leg leaks an out-of-filter row
//
// Self-contained seeding under dedicated tenants (owner connection for speed;
// scored reads run via withTenant on the runtime role). Embeddings are the same
// deterministic FakeGateway-style hash vectors the sibling search suite uses —
// a WIRING fake, so assertions are about candidate membership and filtering, not
// semantic ranking (that is the golden oracle's job).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { searchFused } from '../../src/search.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const EMBEDDING_DIMENSIONS = 1536

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function fakeEmbedding(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const rand = mulberry32(fnv1a(text))
  const v = Array.from({ length: dims }, () => rand() * 2 - 1)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

// All rows share the lexical term 'alpha' so the FTS leg recalls the whole set;
// filters are the only thing that should narrow the result. Distinct attributes
// across rows let each filter axis be asserted in isolation.
interface SeedRow {
  key: string
  memoryType: string
  scope: string
  project: string | null
  status: string
  validFrom: string
  validTo: string | null
  recordedAt: string
}

const SEED: SeedRow[] = [
  // dimensional matrix — all active, current
  {
    key: 'd_dec_work_p1',
    memoryType: 'decision',
    scope: 'work',
    project: 'p1',
    status: 'active',
    validFrom: '2026-01-01',
    validTo: null,
    recordedAt: '2026-01-01',
  },
  {
    key: 'd_note_work_p1',
    memoryType: 'note',
    scope: 'work',
    project: 'p1',
    status: 'active',
    validFrom: '2026-01-02',
    validTo: null,
    recordedAt: '2026-01-02',
  },
  {
    key: 'd_dec_personal_p1',
    memoryType: 'decision',
    scope: 'personal',
    project: 'p1',
    status: 'active',
    validFrom: '2026-01-03',
    validTo: null,
    recordedAt: '2026-01-03',
  },
  {
    key: 'd_dec_work_p2',
    memoryType: 'decision',
    scope: 'work',
    project: 'p2',
    status: 'active',
    validFrom: '2026-01-04',
    validTo: null,
    recordedAt: '2026-01-04',
  },
  {
    key: 'd_dec_work_null',
    memoryType: 'decision',
    scope: 'work',
    project: null,
    status: 'active',
    validFrom: '2026-01-05',
    validTo: null,
    recordedAt: '2026-01-05',
  },
  {
    key: 'd_archived',
    memoryType: 'fact',
    scope: 'work',
    project: 'p1',
    status: 'archived',
    validFrom: '2026-01-06',
    validTo: null,
    recordedAt: '2026-01-06',
  },
]

let uid: string
const idByKey = new Map<string, string>()

async function seedRow(userId: string, r: SeedRow): Promise<string> {
  const embedding = fakeEmbedding(r.key)
  const res = await ownerPool.query(
    `INSERT INTO memories
       (user_id, memory_type, topic, content, content_hash, scope, project, status,
        embedding, valid_from, valid_to, recorded_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10::timestamptz,$11,$12::timestamptz,$10::timestamptz)
     RETURNING id`,
    [
      userId,
      r.memoryType,
      r.key,
      `alpha ${r.key}`,
      `filter-${userId}-${r.key}`,
      r.scope,
      r.project,
      r.status,
      `[${embedding.join(',')}]`,
      r.validFrom,
      r.validTo,
      r.recordedAt,
    ],
  )
  return res.rows[0].id
}

// FTS-only weights isolate the filter behaviour from vector/recency noise: every
// row matches 'alpha', so any narrowing is the filter's doing alone.
const FTS_ONLY = { fts: 1, recency: 0, vector: 0 }
const BIG = 100

beforeAll(async () => {
  await resetDomainTables()
  uid = await seedUser('search-filters@test.local')
  for (const r of SEED) idByKey.set(r.key, await seedRow(uid, r))
}, 120_000)

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

const keysOf = (hits: { id: string }[]): string[] => {
  const byId = new Map([...idByKey.entries()].map(([k, v]) => [v, k] as const))
  return hits.map((h) => byId.get(h.id)).filter((k): k is string => k !== undefined)
}

describe('searchFused filters — dimensional narrowing (#134)', () => {
  it('no filter returns all ACTIVE rows (archived excluded by the live default)', async () => {
    const hits = await withTenant(uid, (tx) => searchFused(tx, uid, 'alpha', BIG, FTS_ONLY))
    const keys = keysOf(hits)
    expect(keys).not.toContain('d_archived')
    expect(keys).toContain('d_dec_work_p1')
    expect(keys.length).toBe(SEED.filter((r) => r.status === 'active').length)
  })

  it('type filter narrows to that memory_type', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, { memoryType: 'note' }),
    )
    expect(keysOf(hits)).toEqual(['d_note_work_p1'])
  })

  it('scope filter narrows to that scope', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, { scope: 'personal' }),
    )
    expect(keysOf(hits)).toEqual(['d_dec_personal_p1'])
  })

  it('project filter narrows to that project (null projects excluded)', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, { project: 'p2' }),
    )
    expect(keysOf(hits)).toEqual(['d_dec_work_p2'])
  })

  it('status filter OVERRIDES the active-only default (surfaces archived)', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, { status: 'archived' }),
    )
    expect(keysOf(hits)).toEqual(['d_archived'])
  })

  it('filters compose (AND) across axes', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        memoryType: 'decision',
        scope: 'work',
        project: 'p1',
      }),
    )
    expect(keysOf(hits)).toEqual(['d_dec_work_p1'])
  })

  it('filters narrow EVERY leg identically (recency + vector see the same set)', async () => {
    // The filter must apply to the recency pool and the vector pool too, not just
    // FTS — otherwise an out-of-filter row could leak in via another leg. Use a
    // no-lexical-match query so FTS recalls nothing; recency+vector must still
    // honour the scope filter (count-consistency over one eligibility rule).
    const target = fakeEmbedding('d_dec_personal_p1')
    const hits = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        'zzzznolexicalmatch qqwx',
        BIG,
        { fts: 0, recency: 1, vector: 1 },
        undefined,
        target,
        { scope: 'work' },
      ),
    )
    const keys = keysOf(hits)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys).not.toContain('d_dec_personal_p1') // personal scope filtered out
    for (const k of keys) {
      expect(SEED.find((r) => r.key === k)?.scope).toBe('work')
    }
  })

  it('filters compose WITH fusion weights without reweighting (vector leg still ranks)', async () => {
    // A scope filter + a vector-led weighting: the exact-embedding row within the
    // scope ranks first, proving the filter narrows the pool the fusion ranks
    // over rather than disturbing the weighted-sum math.
    const target = fakeEmbedding('d_dec_work_p2')
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, { fts: 0.2, recency: 0, vector: 1 }, undefined, target, {
        scope: 'work',
      }),
    )
    const keys = keysOf(hits)
    expect(keys[0]).toBe('d_dec_work_p2')
    for (const k of keys) expect(SEED.find((r) => r.key === k)?.scope).toBe('work')
  })

  it('is tenant-isolated: another tenant filtered read sees nothing', async () => {
    const other = await seedUser('search-filters-other@test.local')
    try {
      const hits = await withTenant(other, (tx) =>
        searchFused(tx, other, 'alpha', BIG, FTS_ONLY, undefined, undefined, { scope: 'work' }),
      )
      expect(hits).toHaveLength(0)
    } finally {
      await ownerPool.query(`DELETE FROM users WHERE id = $1`, [other])
    }
  })
})

describe('searchFused filters — as_of bi-temporal time travel (#134, docs/concepts/memory-model.mdx)', () => {
  // A dedicated supersession chain with explicit bi-temporal dates. The
  // predecessor was TRUE in Jan (closed when the successor took over in Feb), and
  // the successor was RECORDED LATE (Mar) though valid from Feb — the classic
  // bi-temporal case for testing transaction-time vs valid-time.
  let chainUid: string
  let predId: string
  let succId: string

  beforeAll(async () => {
    chainUid = await seedUser('search-filters-chain@test.local')
    predId = await seedRow(chainUid, {
      key: 'chain_pred',
      memoryType: 'fact',
      scope: 'work',
      project: 'p1',
      status: 'active',
      validFrom: '2026-01-01',
      validTo: '2026-02-01',
      recordedAt: '2026-01-01',
    })
    succId = await seedRow(chainUid, {
      key: 'chain_succ',
      memoryType: 'fact',
      scope: 'work',
      project: 'p1',
      status: 'active',
      validFrom: '2026-02-01',
      validTo: null,
      recordedAt: '2026-03-01', // recorded LATE
    })
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'supersedes', 'importer')`,
      [chainUid, succId, predId],
    )
  }, 120_000)

  const chainKeys = (hits: { id: string }[]): string[] =>
    hits.map((h) => (h.id === predId ? 'pred' : h.id === succId ? 'succ' : 'other'))

  it('validAt selects the row that was TRUE at the instant (Jan -> predecessor)', async () => {
    const hits = await withTenant(chainUid, (tx) =>
      searchFused(tx, chainUid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        asOf: { validAt: new Date('2026-01-15T00:00:00Z') },
      }),
    )
    const keys = chainKeys(hits)
    expect(keys).toContain('pred') // surfaces superseded history (docs/concepts/memory-model.mdx)
    expect(keys).not.toContain('succ') // not yet valid in Jan
  })

  it('validAt in the successor window selects the successor (Mar -> successor)', async () => {
    const hits = await withTenant(chainUid, (tx) =>
      searchFused(tx, chainUid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        asOf: { validAt: new Date('2026-03-15T00:00:00Z') },
      }),
    )
    const keys = chainKeys(hits)
    expect(keys).toContain('succ')
    expect(keys).not.toContain('pred') // its valid window closed Feb 1
  })

  it('asKnownAt hides not-yet-recorded rows (transaction time)', async () => {
    // The successor was recorded Mar 1; an asKnownAt of Feb 15 must not see it.
    const hits = await withTenant(chainUid, (tx) =>
      searchFused(tx, chainUid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        asOf: { asKnownAt: new Date('2026-02-15T00:00:00Z') },
      }),
    )
    const keys = chainKeys(hits)
    expect(keys).toContain('pred')
    expect(keys).not.toContain('succ')
  })

  it('combined validAt + asKnownAt: true-at-X as-known-at-Y', async () => {
    // True at Mar 15 (successor's valid window) BUT as known at Feb 15 (before the
    // successor was recorded): the late-recorded successor is invisible, and the
    // predecessor's valid window does not cover Mar -> empty chain result.
    const hits = await withTenant(chainUid, (tx) =>
      searchFused(tx, chainUid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        asOf: {
          validAt: new Date('2026-03-15T00:00:00Z'),
          asKnownAt: new Date('2026-02-15T00:00:00Z'),
        },
      }),
    )
    const keys = chainKeys(hits)
    expect(keys).not.toContain('succ')
    expect(keys).not.toContain('pred')
  })

  it('no asOf keeps the supersession-aware live view (successor ranks above predecessor)', async () => {
    // Default (no asOf): the live view ranks the superseded predecessor BELOW its
    // successor via the tier penalty, both retrievable (docs/concepts/memory-model.mdx default).
    const hits = await withTenant(chainUid, (tx) =>
      searchFused(tx, chainUid, 'alpha', BIG, FTS_ONLY),
    )
    const ids = hits.map((h) => h.id)
    expect(ids).toContain(succId)
    expect(ids).toContain(predId)
    expect(ids.indexOf(succId)).toBeLessThan(ids.indexOf(predId))
  })

  it('asOf composes with a dimensional filter (validAt + scope)', async () => {
    const hits = await withTenant(chainUid, (tx) =>
      searchFused(tx, chainUid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        asOf: { validAt: new Date('2026-01-15T00:00:00Z') },
        scope: 'personal', // no personal-scope rows in the chain
      }),
    )
    expect(hits).toHaveLength(0)
  })
})

describe('searchFused asOf-guard — empty asOf keeps the live default (#134, P2 3372942604)', () => {
  // The schema (asOfSchema) rejects asOf:{}, but the db layer is belt-and-
  // suspenders: an empty asOf object reaching the query must NOT lift the
  // active-only default (that would silently surface archived/superseded rows).
  it('asOf:{} (no coordinate) keeps the active default — archived stays excluded', async () => {
    const empty = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, { asOf: {} }),
    )
    const live = await withTenant(uid, (tx) => searchFused(tx, uid, 'alpha', BIG, FTS_ONLY))
    const emptyKeys = keysOf(empty).sort()
    // Identical to the no-asOf live view: archived excluded, all active present.
    expect(emptyKeys).not.toContain('d_archived')
    expect(emptyKeys).toEqual(keysOf(live).sort())
    expect(emptyKeys.length).toBe(SEED.filter((r) => r.status === 'active').length)
  })

  it('asOf WITH a coordinate lifts the active default (validAt surfaces an archived as-of row)', async () => {
    // d_archived is valid_from 2026-01-06, valid_to null, status archived. With a
    // validAt that the window covers, the active-only default is LIFTED so the
    // valid-time predicate can surface it — proving a real coordinate (unlike {})
    // lifts the default AND applies a temporal predicate.
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'alpha', BIG, FTS_ONLY, undefined, undefined, {
        asOf: { validAt: new Date('2026-02-01T00:00:00Z') },
      }),
    )
    expect(keysOf(hits)).toContain('d_archived')
  })
})
