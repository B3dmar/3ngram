// SPDX-License-Identifier: Apache-2.0
// Integration — the GOLDEN-SET-THROUGH-THE-REAL-PATH slice. The blocking eval
// gate (eval/src/run.mjs) scores EXACT
// cosine in-memory — no DB, no fusion, no SQL. This suite proves the SAME
// frozen floors hold through the REAL core search path: core.search() ->
// withTenant -> db.searchFused (FTS + recency + vector weighted fusion + the
// supersession penalty) on real Postgres, scored with the cached real-model
// embeddings the gate uses. It is ADDITIVE to the gate (which stays untouched),
// not a replacement.
//
// Seeding mirrors hnsw-parity.int.test.ts: the full 158-memory golden set with
// real embeddings under ONE tenant, supersedes edges wired (the production
// penalty keys on an INCOMING supersedes/updates edge, not valid_to),
// superseded rows bi-temporally closed (valid_to set) for fidelity. Owner
// connection for seed speed; the SCORED reads run through core.search() on the
// runtime role with RLS, exactly as production serves them.
//
// METRIC RECONCILIATION (mirror run.mjs's per-slice semantics EXACTLY):
//   - recall@5 / mrr@5: run.mjs retrieves with includeSuperseded:false, i.e. it
//     scores over LIVE rows only. The production fused path NEVER filters
//     superseded rows (docs/concepts/memory-model.mdx) — the tier penalty only RANKS them down (below
//     every live row). So to compare like-for-like, this test POST-FILTERS
//     superseded rows out of the fused output BEFORE computing recall/mrr. The
//     filter lives ONLY in the metric computation here, never in the production
//     path.
//   - supersession_correct: run.mjs retrieves with includeSuperseded:true and
//     checks the successor ranks above the forbidden predecessor. This test uses
//     the RAW (unfiltered) fused output — the production ranking as served —
//     and asserts the successor/predecessor RELATIVE ORDER. With the shipped
//     TIER penalty (DEFAULT_SUPERSESSION_PENALTY=2) a superseded predecessor
//     sinks below every live row, so it (and sometimes a mid-chain successor)
//     leaves a K=5 window — yet docs/concepts/memory-model.mdx still requires the successor to rank
//     ABOVE the predecessor. So this slice uses IMPLEMENTATION (b):
//     query a WIDE fused output (the full golden set) and compare the
//     ranks of EXACTLY the expected/forbidden pair, regardless of K. This
//     proves the production ranking is correct without softening the product
//     default (the soft-penalty draft could surface a stale
//     predecessor above its live successor on a stronger lexical/vector match).
//   - abstention: floors.tau (0.4663) is a COSINE-scale threshold; the fused
//     score is a weighted sum and is NOT cosine-comparable. OPTION (a): decide
//     abstention on the VECTOR-SIMILARITY component of the top fused hit
//     (searchFused exposes it additively as SearchHit.vectorScore on a cosine
//     scale) and reuse the frozen tau. No fused-scale recalibration needed.
//
// Reuses packages/db integration infra (helpers.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb } from '@3ngram/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { search } from '../../src/read/search.js'

const fixtures = join(import.meta.dirname, '../../../../eval/fixtures')
const memories = JSON.parse(readFileSync(join(fixtures, 'golden-set.json'), 'utf8')) as Array<{
  id: string
  type: string
  topic: string
  content: string
  replaces?: string | null
  created: string
}>
const emb = JSON.parse(
  readFileSync(join(fixtures, 'embeddings-openai-large-1536.json'), 'utf8'),
) as {
  memories: Record<string, number[]>
  queries: number[][]
}
const queries = JSON.parse(readFileSync(join(fixtures, 'queries.json'), 'utf8')) as Array<{
  slice: 'retrieval' | 'supersession' | 'abstention'
  query: string
  expected: string[]
  forbidden: string[]
}>
const floors = JSON.parse(readFileSync(join(fixtures, 'floors.json'), 'utf8')) as {
  recorded: { recall_at_5: number; mrr_at_5: number; supersession_correct: number; tau: number }
}

const K = 5
const superseded = new Set(memories.filter((m) => m.replaces).map((m) => m.replaces as string))
// For each superseded predecessor, the close instant (valid_to) is when its
// successor was created — that is the bi-temporal moment the predecessor stopped
// being current. GREATEST guards the edge case where a fixture's predecessor was
// created AFTER its successor's date (g152/g155 in the golden set), which would
// otherwise produce valid_to < valid_from and trip the memories_validity_check
// constraint (valid_to IS NULL OR valid_from <= valid_to). Computed from the
// fixed golden-set dates, never assumed.
const successorCreatedByPredecessor = new Map<string, string>(
  memories.filter((m) => m.replaces).map((m) => [m.replaces as string, m.created] as const),
)
const validToFor = (predecessorId: string, predecessorCreated: string): string => {
  const successorCreated = successorCreatedByPredecessor.get(predecessorId)
  if (successorCreated === undefined) return predecessorCreated
  return successorCreated >= predecessorCreated ? successorCreated : predecessorCreated
}
const dbIdByFixtureId = new Map<string, string>()
const fixtureIdByDbId = new Map<string, string>()
let uid: string

beforeAll(async () => {
  await resetDomainTables()
  uid = await seedUser('search-golden@test.local')
  // Insert the full golden set WITH real embeddings; superseded rows get
  // valid_to (bi-temporal close) for fidelity. Owner connection for speed —
  // the scored reads below go through the runtime role via core.search().
  for (const m of memories) {
    const vec = `[${(emb.memories[m.id] as number[]).join(',')}]`
    const r = await ownerPool.query(
      `INSERT INTO memories
         (user_id, memory_type, topic, content, content_hash, embedding,
          valid_from, valid_to, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::timestamptz, $8, $7::timestamptz, $7::timestamptz)
       RETURNING id`,
      [
        uid,
        m.type,
        m.topic,
        m.content,
        `golden-${m.id}`,
        vec,
        m.created,
        superseded.has(m.id) ? validToFor(m.id, m.created) : null,
      ],
    )
    dbIdByFixtureId.set(m.id, r.rows[0].id)
    fixtureIdByDbId.set(r.rows[0].id, m.id)
  }
  // Wire supersedes edges (from successor -> superseded predecessor). The
  // production penalty keys on an INCOMING supersedes/updates edge, so these
  // must exist for the supersession-aware ranking to engage. (The golden set
  // only exercises the 'supersedes' kind here; 'updates' demotion parity is
  // covered by packages/db/test/integration/search.int.test.ts.)
  for (const m of memories) {
    if (!m.replaces) continue
    const fromId = dbIdByFixtureId.get(m.id)
    const toId = dbIdByFixtureId.get(m.replaces)
    if (!fromId || !toId) continue
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'supersedes', 'importer') ON CONFLICT DO NOTHING`,
      [uid, fromId, toId],
    )
  }
}, 240_000)

afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

/** Run a query through the REAL core search path with its cached embedding. */
async function realSearch(qi: number, limit?: number) {
  const queryEmbedding = emb.queries[qi] as number[]
  return search(uid, queries[qi]?.query as string, { queryEmbedding }, limit ? { limit } : {})
}

// Implementation (b), supersession slice: the full golden set is the widened
// window. Asking for every seeded row gives the complete fused ordering so the
// successor/predecessor pair ranks are well-defined no matter how far the tier
// penalty demotes the predecessor.
const FULL_OUTPUT_LIMIT = memories.length

describe('golden set through the real fused search path (#77 exit criterion)', () => {
  it('clears recall@5 and mrr@5 floors (superseded post-filtered, mirroring run.mjs)', async () => {
    let hits = 0
    let total = 0
    let mrr = 0
    // Per-query diagnostics so a CI failure is self-explanatory without a local
    // repro: which query lost its gold row (recall miss), or which gold row was
    // demoted below rank 1 (mrr drag), with the offending top-5 each time.
    const recallMisses: string[] = []
    const mrrDrags: string[] = []
    for (const [qi, q] of queries.entries()) {
      if (q.slice !== 'retrieval' && q.slice !== 'supersession') continue
      total++
      // POST-FILTER superseded rows out (run.mjs includeSuperseded:false). The
      // production path itself never filters — this filter is metric-only.
      const ranked = (await realSearch(qi))
        .map((h) => fixtureIdByDbId.get(h.id) as string)
        .filter((fid) => !superseded.has(fid))
        .slice(0, K)
      const rank = ranked.findIndex((fid) => q.expected.includes(fid))
      if (rank !== -1) {
        hits++
        mrr += 1 / (rank + 1)
        if (rank > 0) {
          mrrDrags.push(
            `qi=${qi} ${q.slice} gold=${q.expected.join('|')} rank=${rank + 1} top5=[${ranked.join(', ')}]`,
          )
        }
      } else {
        recallMisses.push(
          `qi=${qi} ${q.slice} gold=${q.expected.join('|')} (out of top-${K}) top5=[${ranked.join(', ')}]`,
        )
      }
    }
    // Mirror run.mjs's scoring EXACTLY: it records and compares metrics ROUNDED
    // to 4 decimals (`+(hits/total).toFixed(4)`, eval/src/run.mjs). The frozen
    // floor recall@5 0.9773 IS that rounding of 86/88 (= 0.977272…). Comparing
    // the raw fraction would make even the recorded baseline fail the literal
    // `>=` (0.977272… < 0.9773), so we round here too — the floors are on the
    // rounded scale by construction.
    const round4 = (x: number): number => Number(x.toFixed(4))
    const recall = round4(hits / total)
    const mrrAt5 = round4(mrr / total)
    const diag =
      `\n  recall misses (${recallMisses.length}):` +
      `${recallMisses.length ? `\n    ${recallMisses.join('\n    ')}` : ' none'}` +
      `\n  mrr drags (gold below rank 1, ${mrrDrags.length}):` +
      `${mrrDrags.length ? `\n    ${mrrDrags.join('\n    ')}` : ' none'}`
    expect(
      recall,
      `recall@5 ${recall} < floor ${floors.recorded.recall_at_5}${diag}`,
    ).toBeGreaterThanOrEqual(floors.recorded.recall_at_5)
    expect(
      mrrAt5,
      `mrr@5 ${mrrAt5} < floor ${floors.recorded.mrr_at_5}${diag}`,
    ).toBeGreaterThanOrEqual(floors.recorded.mrr_at_5)
  }, 180_000)

  it('clears the supersession floor: successor outranks predecessor in the RAW fused order at widened K (impl b)', async () => {
    // IMPLEMENTATION (b): with the shipped TIER penalty (2) a
    // superseded predecessor sinks below every live row and a mid-chain
    // successor can leave a K=5 window, but docs/concepts/memory-model.mdx still demands the successor
    // rank ABOVE the predecessor. So we read the FULL fused ordering (production
    // ranking, no post-filter — mirrors run.mjs includeSuperseded:true) and
    // compare the ranks of EXACTLY the expected/forbidden pair, regardless of K.
    // This proves correctness without softening the product default. With
    // penalty 2 the successor outranks essentially always; the offline mirror
    // (tuning evidence) measures 1.0, well above the 0.9474 floor.
    let supOk = 0
    let supN = 0
    for (const [qi, q] of queries.entries()) {
      if (q.slice !== 'supersession') continue
      supN++
      const ranked = (await realSearch(qi, FULL_OUTPUT_LIMIT)).map(
        (h) => fixtureIdByDbId.get(h.id) as string,
      )
      const succRank = ranked.findIndex((fid) => q.expected.includes(fid))
      const predRank = ranked.findIndex((fid) => q.forbidden.includes(fid))
      // Successor must be present AND ranked above the predecessor (or the
      // predecessor demoted out of the set entirely — never above the successor).
      if (succRank !== -1 && (predRank === -1 || succRank < predRank)) supOk++
    }
    const supersession = supOk / supN
    expect(
      supersession,
      `supersession_correct ${supersession} < floor ${floors.recorded.supersession_correct}`,
    ).toBeGreaterThanOrEqual(floors.recorded.supersession_correct)
  }, 180_000)

  it('abstains with precision 1.0 via the top hit vector-similarity component vs frozen tau (option a)', async () => {
    // OPTION (a): the cosine-scale abstention signal is the VECTOR-SIMILARITY
    // component of the top fused hit (SearchHit.vectorScore), compared to the
    // FROZEN cosine-scale tau. The fused score itself is not cosine-comparable.
    let abstOk = 0
    let abstN = 0
    for (const [qi, q] of queries.entries()) {
      if (q.slice !== 'abstention') continue
      abstN++
      const top = (await realSearch(qi))[0]
      const vectorSim = top?.vectorScore ?? 0
      if (vectorSim < floors.recorded.tau) abstOk++
    }
    const precision = abstOk / abstN
    expect(precision, `abstention_precision ${precision} != 1.0`).toBe(1)
  }, 120_000)
})
