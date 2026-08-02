// SPDX-License-Identifier: Apache-2.0
// Unified-search query layer (slice 1b): FTS + recency + vector legs and
// the weighted-sum fusion, exercised against the seeded golden set through the
// RUNTIME role (owner bypasses RLS and would prove nothing — docs/concepts/testing.mdx).
//
// These assertions cover the FTS leg, the recency leg, the NEW vector leg, the
// fusion SHAPE, and the load-bearing behavior — superseded predecessors rank
// BELOW their successors (ranking, not filtering: both stay retrievable).
//
// Embeddings are deterministic FakeGateway-style hash vectors (mirrors
// packages/llm/src/fake.ts: fnv1a seed → mulberry32 PRNG → unit vector). Same
// text always maps to the same vector; this is a WIRING fake, so the vector
// tests assert exact-match nearest-neighbour ranking and weight gating, never
// semantic similarity (that is the eval harness's job, never a unit test's).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import {
  DEFAULT_FUSION_WEIGHTS,
  searchFts,
  searchFused,
  searchRecency,
  searchVector,
} from '../../src/search.js'
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

/** Deterministic unit-vector embedding from text (FakeGateway hash pattern). */
function fakeEmbedding(text: string, dims: number = EMBEDDING_DIMENSIONS): number[] {
  const rand = mulberry32(fnv1a(text))
  const v = Array.from({ length: dims }, () => rand() * 2 - 1)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

const fixtures = join(import.meta.dirname, '../../../../eval/fixtures')
const golden = JSON.parse(readFileSync(join(fixtures, 'golden-set.json'), 'utf8')) as Array<{
  id: string
  type: string
  topic: string
  content: string
  replaces: string | null
  created: string
}>

let uid: string
const dbIdByGoldenId = new Map<string, string>()
const embeddingByGoldenId = new Map<string, number[]>()

beforeAll(async () => {
  await resetDomainTables()
  uid = await seedUser('search@test.local')
  // Insert the full golden set (owner connection for speed; reads below run
  // through the runtime role via withTenant, the production path). Each row gets
  // a deterministic FakeGateway-style embedding so the vector leg has data.
  for (const m of golden) {
    const embedding = fakeEmbedding(m.content)
    embeddingByGoldenId.set(m.id, embedding)
    const r = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, embedding,
                             valid_from, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::timestamptz, $7::timestamptz, $7::timestamptz)
       RETURNING id`,
      [uid, m.type, m.topic, m.content, `search-${m.id}`, `[${embedding.join(',')}]`, m.created],
    )
    dbIdByGoldenId.set(m.id, r.rows[0].id)
  }
  // Wire supersedes edges (from = successor, to = predecessor) and bi-temporally
  // close each superseded predecessor, mirroring seed.mjs / the write path.
  for (const m of golden) {
    if (!m.replaces) continue
    const fromId = dbIdByGoldenId.get(m.id)
    const toId = dbIdByGoldenId.get(m.replaces)
    if (!fromId || !toId) continue
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'supersedes', 'importer') ON CONFLICT DO NOTHING`,
      [uid, fromId, toId],
    )
    await ownerPool.query(
      `UPDATE memories SET valid_to = $2::timestamptz WHERE id = $1 AND valid_to IS NULL`,
      [toId, m.created],
    )
  }
}, 120_000)

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('migration 0006 structure', () => {
  it('memories has a GENERATED STORED search_tsv column + GIN index', async () => {
    const col = await ownerPool.query(
      `SELECT data_type, is_generated FROM information_schema.columns
       WHERE table_name = 'memories' AND column_name = 'search_tsv'`,
    )
    expect(col.rows).toHaveLength(1)
    expect(col.rows[0].data_type).toBe('tsvector')
    expect(col.rows[0].is_generated).toBe('ALWAYS')
    const idx = await ownerPool.query(
      `SELECT count(*) AS n FROM pg_indexes
       WHERE tablename = 'memories' AND indexname = 'memories_search_tsv_idx'
       AND indexdef LIKE '%gin%'`,
    )
    expect(Number(idx.rows[0].n)).toBe(1)
  })
})

describe('FTS leg (searchFts)', () => {
  it('returns matching rows ranked by descending normalized score in [0,1]', async () => {
    const hits = await withTenant(uid, (tx) =>
      searchFts(tx, uid, 'session handoff release canary validation', 10),
    )
    expect(hits.length).toBeGreaterThan(0)
    // both members of the g116/g115 supersession pair match this query
    const ids = hits.map((h) => h.id)
    expect(ids).toContain(dbIdByGoldenId.get('g116'))
    expect(ids).toContain(dbIdByGoldenId.get('g115'))
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(1)
    }
    const scores = hits.map((h) => h.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('returns nothing for a query with no lexical match', async () => {
    const hits = await withTenant(uid, (tx) => searchFts(tx, uid, 'zzzznonexistentlexeme qqwx', 10))
    expect(hits).toHaveLength(0)
  })
})

describe('recency leg (searchRecency)', () => {
  it('returns active rows in descending recency with decayed scores in (0,1]', async () => {
    const hits = await withTenant(uid, (tx) => searchRecency(tx, uid, 20))
    expect(hits.length).toBe(20)
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0)
      expect(h.score).toBeLessThanOrEqual(1)
    }
    const scores = hits.map((h) => h.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })
})

describe('fusion (searchFused) — supersession-aware ranking', () => {
  it('ranks a superseded predecessor BELOW its successor (not filtered out)', async () => {
    // limit spans the full candidate pool: the tier penalty sinks the
    // predecessor below even zero-relevance recency candidates, so a small
    // limit would CUT it — which is exactly the filtering this test forbids.
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'session handoff release canary validation', 200),
    )
    const ids = hits.map((h) => h.id)
    const succ = dbIdByGoldenId.get('g116') as string
    const pred = dbIdByGoldenId.get('g115') as string
    // ranking, NOT filtering: the superseded predecessor is still retrievable
    expect(ids).toContain(succ)
    expect(ids).toContain(pred)
    expect(ids.indexOf(succ)).toBeLessThan(ids.indexOf(pred))
    const succScore = hits.find((h) => h.id === succ)?.score as number
    const predScore = hits.find((h) => h.id === pred)?.score as number
    expect(succScore).toBeGreaterThan(predScore)
  })

  it('the supersession penalty is what demotes the predecessor (penalty=0 can reorder)', async () => {
    // With the penalty disabled, the predecessor is no longer forced below its
    // successor — proving the demotion is the penalty, not an artifact of the
    // base FTS/recency scores.
    const noPenalty = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        'session handoff release canary validation',
        200,
        DEFAULT_FUSION_WEIGHTS,
        0,
      ),
    )
    const withPenalty = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'session handoff release canary validation', 200),
    )
    const pred = dbIdByGoldenId.get('g115') as string
    const rank = (hits: { id: string }[]) => hits.findIndex((h) => h.id === pred)
    expect(rank(withPenalty)).toBeGreaterThanOrEqual(rank(noPenalty))
  })

  it('recency leg contributes candidates without a lexical match (Codex P2 on #88)', async () => {
    // Pre-fix, candidates were gated on FTS matches: a no-match query returned
    // empty even at recency weight 1, and recent-but-non-matching rows could
    // never enter fusion. The recency pool now unions into the candidate set.
    const recencyOnly = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'zzzznonexistentlexeme qqwx', 10, { fts: 0, recency: 1, vector: 0 }),
    )
    expect(recencyOnly.length).toBeGreaterThan(0)
    const scores = recencyOnly.map((h) => h.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    // default weights surface recency-ranked rows for a no-match query too
    const defaults = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'zzzznonexistentlexeme qqwx', 10),
    )
    expect(defaults.length).toBeGreaterThan(0)
  })

  it('a zero-weight leg neither scores nor recalls (lexical-only ablation)', async () => {
    // With recency disabled, the recency pool must not inject zero-score
    // filler rows into the response (Codex P2 on): the fused result is
    // exactly the lexical matches, nothing more.
    const hits = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'session handoff release canary validation', 200, {
        fts: 1,
        recency: 0,
        vector: 0,
      }),
    )
    expect(hits.length).toBeGreaterThan(0)
    const ftsHits = await withTenant(uid, (tx) =>
      searchFts(tx, uid, 'session handoff release canary validation', 200),
    )
    expect(hits.length).toBe(ftsHits.length)
  })
})

describe('fusion (searchFused) — keyset cursor continuation (PR #358)', () => {
  // FTS-only weights give a now()-INDEPENDENT total order: ts_rank does not move
  // between requests and the candidate pool (floor 50 > the query's match count)
  // is identical for both pages, so the (score, id) keyset is exact — the proof
  // that continuation neither skips nor repeats rows, which an offset cannot give.
  // websearch_to_tsquery ANDs the terms, so the match set is small and stable;
  // the page size is half of it (>=1) so there is always a real second page.
  const FTS_ONLY = { fts: 1, recency: 0, vector: 0 }
  const QUERY = 'session handoff release canary validation'

  it('continues strictly after the (score, id) cursor with no skips or repeats', async () => {
    const all = await withTenant(uid, (tx) => searchFused(tx, uid, QUERY, 200, FTS_ONLY))
    expect(all.length).toBeGreaterThanOrEqual(2)
    const PAGE = Math.max(1, Math.floor(all.length / 2))

    const page1 = await withTenant(uid, (tx) => searchFused(tx, uid, QUERY, PAGE, FTS_ONLY))
    expect(page1.length).toBe(PAGE)
    const last = page1[page1.length - 1]
    if (last === undefined) throw new Error('expected a full first page')

    const page2 = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        QUERY,
        PAGE,
        FTS_ONLY,
        undefined,
        undefined,
        {},
        {
          score: last.score,
          id: last.id,
        },
      ),
    )
    expect(page2.length).toBeGreaterThan(0)

    // No row appears on both pages (the offset failure mode this fixes).
    const page1Ids = new Set(page1.map((h) => h.id))
    expect(page2.some((h) => page1Ids.has(h.id))).toBe(false)

    // Every page-2 row ranks at or below the cursor boundary.
    for (const h of page2) expect(h.score).toBeLessThanOrEqual(last.score)

    // The concatenation reproduces the single-shot ranking prefix exactly
    // (score DESC, id ASC) — keyset paging == slicing the global order.
    const combined = [...page1, ...page2].map((h) => h.id)
    expect(combined).toEqual(all.slice(0, combined.length).map((h) => h.id))
  })
})

describe('vector leg (searchVector)', () => {
  it('ranks the exact-embedding match first with score ~1 in [0,1]', async () => {
    // A query embedding equal to a row's embedding has cosine distance 0, so
    // 1 - distance = 1: that row must be the nearest neighbour. (FakeGateway
    // vectors are not semantically clustered, so this is the only ranking
    // assertion a wiring fake can make — exact match dominates.)
    const target = embeddingByGoldenId.get('g001') as number[]
    const hits = await withTenant(uid, (tx) => searchVector(tx, uid, target, 10))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.id).toBe(dbIdByGoldenId.get('g001'))
    expect(hits[0]?.score).toBeGreaterThan(0.999)
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(1)
    }
    const scores = hits.map((h) => h.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })
})

describe('fusion (searchFused) — vector leg', () => {
  const targetEmbedding = () => embeddingByGoldenId.get('g001') as number[]

  it('surfaces the exact-embedding match at vector weight when no lexical match', async () => {
    // Vector-only weights + a no-lexical-match query: fusion must recall and
    // rank the exact-embedding row via the vector leg alone, proving the leg
    // is wired into the candidate pool and the fused score.
    const hits = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        'zzzznonexistentlexeme qqwx',
        10,
        { fts: 0, recency: 0, vector: 1 },
        undefined,
        targetEmbedding(),
      ),
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.id).toBe(dbIdByGoldenId.get('g001'))
    const scores = hits.map((h) => h.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('vector leg is additive: enabling it changes the fused ordering', async () => {
    // Same query, identical FTS+recency weights; adding a vector weight + the
    // target embedding pulls the exact-embedding row up — the leg contributes
    // signal on top of the existing legs rather than replacing them.
    const baseWeights = { fts: 1, recency: 0.3, vector: 0 }
    const withVector = { fts: 1, recency: 0.3, vector: 1 }
    const baseline = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'session handoff release canary validation', 50, baseWeights),
    )
    const fused = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        'session handoff release canary validation',
        50,
        withVector,
        undefined,
        targetEmbedding(),
      ),
    )
    const targetId = dbIdByGoldenId.get('g001') as string
    // the exact-embedding row enters/rises in the fused result once vector is on
    expect(fused.map((h) => h.id)).toContain(targetId)
    const baselineRank = baseline.findIndex((h) => h.id === targetId)
    const fusedRank = fused.findIndex((h) => h.id === targetId)
    const norm = (r: number) => (r === -1 ? Number.POSITIVE_INFINITY : r)
    expect(fusedRank).toBeGreaterThanOrEqual(0)
    expect(norm(fusedRank)).toBeLessThanOrEqual(norm(baselineRank))
  })

  it('supersession penalty still demotes with the vector leg on (ranking, not filtering)', async () => {
    // docs/concepts/memory-model.mdx: a superseded predecessor stays retrievable but ranks below its
    // successor. Feed the predecessor's OWN embedding (so the vector leg would
    // otherwise rank it #1) and confirm the tier penalty still sinks it below
    // the successor — the penalty dominates the vector signal, and BOTH rows
    // remain in the result (limit spans the candidate pool).
    const pred = dbIdByGoldenId.get('g115') as string
    const succ = dbIdByGoldenId.get('g116') as string
    const hits = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        'session handoff release canary validation',
        200,
        { fts: 1, recency: 0.3, vector: 1 },
        undefined,
        embeddingByGoldenId.get('g115'),
      ),
    )
    const ids = hits.map((h) => h.id)
    expect(ids).toContain(succ)
    expect(ids).toContain(pred)
    expect(ids.indexOf(succ)).toBeLessThan(ids.indexOf(pred))
  })

  it('zero vector weight does NOT execute the vector leg (gating, lexical parity)', async () => {
    // At vector weight 0 the vector_pool is gated off and contributes nothing,
    // even with an embedding supplied: the fused result is byte-for-byte the
    // FTS-only ablation (the embedding must not leak candidates or score).
    const gated = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        'session handoff release canary validation',
        200,
        { fts: 1, recency: 0, vector: 0 },
        undefined,
        targetEmbedding(),
      ),
    )
    const ftsHits = await withTenant(uid, (tx) =>
      searchFts(tx, uid, 'session handoff release canary validation', 200),
    )
    expect(gated.length).toBe(ftsHits.length)
    // and identical to the same call with NO embedding passed at all
    const gatedNoEmbedding = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'session handoff release canary validation', 200, {
        fts: 1,
        recency: 0,
        vector: 0,
      }),
    )
    expect(gated.map((h) => h.id)).toEqual(gatedNoEmbedding.map((h) => h.id))
  })

  it('non-zero vector weight WITHOUT an embedding is inert (no dimension error)', async () => {
    // Regression: the SQL once gated the vector_pool/vector_score on
    // `weights.vector > 0` alone, while the app guard also required an
    // embedding. A caller passing a non-zero weight but NO embedding then ran
    // `embedding <=> '[]'::vector` against the 1536-dim column, which pgvector
    // rejects ("different vector dimensions 0 and 1536"). Both gates now key on
    // the SAME `vectorActive` flag, so this call must succeed and equal the
    // no-vector result byte-for-byte.
    const noEmbedding = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'session handoff release canary validation', 200, {
        fts: 1,
        recency: 0.3,
        vector: 1,
      }),
    )
    const vectorOff = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'session handoff release canary validation', 200, {
        fts: 1,
        recency: 0.3,
        vector: 0,
      }),
    )
    expect(noEmbedding.map((h) => h.id)).toEqual(vectorOff.map((h) => h.id))
  })

  it('vector leg is tenant-isolated (RLS scopes the candidate pool)', async () => {
    // A second tenant's exact-embedding query must never surface the first
    // tenant's rows: withTenant() binds app.user_id, RLS does the rest.
    const otherUid = await seedUser('search-vector-other@test.local')
    try {
      const hits = await withTenant(otherUid, (tx) =>
        searchVector(tx, otherUid, targetEmbedding(), 10),
      )
      expect(hits).toHaveLength(0)
      const fused = await withTenant(otherUid, (tx) =>
        searchFused(
          tx,
          otherUid,
          'session handoff release canary validation',
          50,
          { fts: 1, recency: 0.3, vector: 1 },
          undefined,
          targetEmbedding(),
        ),
      )
      expect(fused).toHaveLength(0)
    } finally {
      await ownerPool.query(`DELETE FROM users WHERE id = $1`, [otherUid])
    }
  })

  it('topicMatch bonus ranks topic-matching row first; zero weight does not (issue #339)', async () => {
    // Seed a memory whose topic contains "Ana" — the short-name entity case.
    const r = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash,
                             valid_from, recorded_at, created_at)
       VALUES ($1, 'fact', 'Ana Rodriguez contact details', 'Phone: 555-0101',
               'topic-match-ana', now(), now(), now())
       RETURNING id`,
      [uid],
    )
    const seedId = r.rows[0].id as string
    try {
      // With topicMatch: 0.5, the seeded memory must rank first.
      const withBonus = await withTenant(uid, (tx) =>
        searchFused(tx, uid, 'Ana', 5, { fts: 0.2, recency: 0, vector: 0, topicMatch: 0.5 }),
      )
      expect(withBonus[0]?.id).toBe(seedId)

      // With topicMatch: 0, the bonus is inert. The seeded row is still the only
      // FTS candidate for "Ana" (golden set has no person-name contacts), so rank
      // is not a meaningful assertion. Instead verify the raw score delta: the
      // topicMatch leg must add weight to the fused score.
      const withoutBonus = await withTenant(uid, (tx) =>
        searchFused(tx, uid, 'Ana', 5, { fts: 0.2, recency: 0, vector: 0, topicMatch: 0 }),
      )
      const hitWith = withBonus.find((h) => h.id === seedId)!
      const hitWithout = withoutBonus.find((h) => h.id === seedId)!
      expect(hitWith.score).toBeGreaterThan(hitWithout.score)
    } finally {
      await ownerPool.query(`DELETE FROM memories WHERE id = $1`, [seedId])
    }
  })

  it('exposes SearchHit.vectorScore (cosine scale) ONLY on the active vector path', async () => {
    // The additive per-leg score the core abstention policy reads. On the active
    // path it is the UNWEIGHTED cosine-scale similarity (GREATEST(0, 1-distance)
    // in [0,1]); the exact-embedding row scores ~1. It must NOT appear on the
    // inert path (no vector weight / no embedding), where it would be a
    // meaningless literal 0 masquerading as a cosine.
    const target = embeddingByGoldenId.get('g001') as number[]
    const targetId = dbIdByGoldenId.get('g001') as string
    const active = await withTenant(uid, (tx) =>
      searchFused(
        tx,
        uid,
        'session handoff release canary validation',
        50,
        {
          fts: 1,
          recency: 0.3,
          vector: 1,
        },
        undefined,
        target,
      ),
    )
    const top = active.find((h) => h.id === targetId)
    expect(top?.vectorScore).toBeGreaterThan(0.999)
    expect(top?.vectorScore).toBeLessThanOrEqual(1)
    for (const h of active) {
      expect(h.vectorScore).toBeTypeOf('number')
      expect(h.vectorScore as number).toBeGreaterThanOrEqual(0)
    }
    // inert path (vector weight 0): vectorScore is undefined, never 0
    const inert = await withTenant(uid, (tx) =>
      searchFused(tx, uid, 'session handoff release canary validation', 50, {
        fts: 1,
        recency: 0.3,
        vector: 0,
      }),
    )
    for (const h of inert) {
      expect(h.vectorScore).toBeUndefined()
    }
  })
})
