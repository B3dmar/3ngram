// SPDX-License-Identifier: Apache-2.0
// Mandatory suite 5: HNSW ↔ exact-cosine parity. The eval gate
// scores EXACT cosine over cached embeddings; this proves pgvector's HNSW
// approximation retrieves (nearly) the same top-K on the same data — the
// bridge between the eval harness's upper bound and what production serves.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool, resetDomainTables, runtimePool, seedUser } from './helpers.js'

const fixtures = join(import.meta.dirname, '../../../../eval/fixtures')
const memories = JSON.parse(readFileSync(join(fixtures, 'golden-set.json'), 'utf8')) as Array<{
  id: string
  type: string
  topic: string
  content: string
}>
const emb = JSON.parse(
  readFileSync(join(fixtures, 'embeddings-openai-large-1536.json'), 'utf8'),
) as { memories: Record<string, number[]>; queries: number[][] }
const queries = JSON.parse(readFileSync(join(fixtures, 'queries.json'), 'utf8')) as Array<{
  slice: string
}>

let uid: string
const distractors: string[] = []
const dbIdByFixtureId = new Map<string, string>()
const superseded = new Set(
  (memories as Array<{ id: string; replaces?: string | null }>)
    .filter((m) => m.replaces)
    .map((m) => m.replaces as string),
)

/** A single EXPLAIN (FORMAT JSON) plan node; children nest under `Plans`. */
interface PlanNode {
  'Node Type'?: string
  'Relation Name'?: string
  Plans?: PlanNode[]
}

/** True if the plan tree contains a Seq Scan node over `relation`. */
function planHasSeqScanOn(
  explain: { 'QUERY PLAN': Array<{ Plan: PlanNode }> },
  relation: string,
): boolean {
  const walk = (node: PlanNode): boolean => {
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === relation) return true
    return (node.Plans ?? []).some(walk)
  }
  return explain['QUERY PLAN'].some((entry) => walk(entry.Plan))
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number)
    na += (a[i] as number) ** 2
    nb += (b[i] as number) ** 2
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

beforeAll(async () => {
  await resetDomainTables()
  uid = await seedUser('hnsw@test.local')
  distractors.push(await seedUser('hnsw-d1@test.local'), await seedUser('hnsw-d2@test.local'))
  // load the full golden set with real embeddings (owner for speed; RLS read
  // path is exercised via the runtime query below with tenant context).
  // Tenant A: superseded rows get valid_to set (the production retrieval
  // filter shape); distractor tenants carry the SAME vectors so the index is
  // 3x the tenant's row count — the post-filter scenario pgvector warns about.
  for (const m of memories) {
    const vec = `[${(emb.memories[m.id] as number[]).join(',')}]`
    const r = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, embedding, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6::vector, '2026-01-01', $7) RETURNING id`,
      [
        uid,
        m.type,
        m.topic,
        m.content,
        `hnsw-${m.id}`,
        vec,
        superseded.has(m.id) ? '2026-06-01' : null,
      ],
    )
    dbIdByFixtureId.set(m.id, r.rows[0].id)
    for (const [di, d] of distractors.entries()) {
      await ownerPool.query(
        `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [d, m.type, m.topic, m.content, `hnsw-${m.id}-d${di}`, vec],
      )
    }
  }
  // Give the planner production-shaped statistics before the plan-shape
  // assertions below. Fresh CI Neon branches carry NO per-branch column stats
  // (the branch copies pages, not pg_statistic) and auto-analyze has not run on
  // a just-seeded table, so the planner has no row estimates and can pick a
  // whole-table Seq Scan on the tiny set — locally optimal at that size, but
  // exactly the plan FILTERED regime A asserts against (observed as
  // a near-deterministic flake, cost ~92-93). ANALYZE fills in cardinality and
  // valid_to/scope selectivity so the planner chooses the index-driven path it
  // would in production. Owner connection: ANALYZE needs table-owner privilege
  // and the runtime app_user role (NOBYPASSRLS) is denied; ownerPool already
  // owns the seed/DDL path. memories is the only relation these EXPLAINs plan
  // over, so analyzing it is sufficient.
  await ownerPool.query('ANALYZE memories')
}, 240_000)

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('HNSW parity with exact cosine', () => {
  it('mean top-5 overlap >= 0.95 across 30 sampled queries (index path forced)', async () => {
    const sample = queries
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => q.slice !== 'abstention')
      .filter((_, j) => j % 3 === 0)
      .slice(0, 30)

    let overlapSum = 0
    const conn = await runtimePool.connect()
    try {
      for (const { i } of sample) {
        const qVec = emb.queries[i] as number[]
        // exact top-5 (the eval gate's view), mapped to db ids
        const exact = memories
          .map((m) => ({
            id: dbIdByFixtureId.get(m.id) as string,
            s: cosine(qVec, emb.memories[m.id] as number[]),
          }))
          .sort((x, y) => y.s - x.s)
          .slice(0, 5)
          .map((x) => x.id)
        // HNSW top-5 through the runtime role with tenant context, seqscan off
        await conn.query('BEGIN')
        await conn.query(`SELECT set_config('app.user_id', $1, true)`, [uid])
        await conn.query('SET LOCAL enable_seqscan = off')
        const r = await conn.query(
          `SELECT id FROM memories ORDER BY embedding <=> $1::vector LIMIT 5`,
          [`[${qVec.join(',')}]`],
        )
        await conn.query('ROLLBACK')
        const hnsw = new Set(r.rows.map((row) => row.id))
        overlapSum += exact.filter((id) => hnsw.has(id)).length / 5
      }
    } finally {
      conn.release()
    }
    const meanOverlap = overlapSum / sample.length
    expect(meanOverlap).toBeGreaterThanOrEqual(0.95)
  }, 60_000)

  // Production retrieval shape (Phase 1B): RLS tenant filter + valid_to IS
  // NULL, against an index holding 3x the tenant's rows. Two legitimate plan
  // regimes exist (recorded in docs/concepts/data-model.mdx):
  //  A. selective tenant → planner uses the user_id btree + EXACT sort —
  //     perfect recall, the RIGHT plan at per-tenant scale (pgvector's own
  //     filtering guidance); the first run of this test proved the planner
  //     picks it naturally.
  //  B. large tenant → HNSW with hnsw.iterative_scan = relaxed_order so
  //     post-filtering doesn't starve the result set.
  function filteredSample() {
    return queries
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => q.slice !== 'abstention')
      .filter((_, j) => j % 3 === 1)
      .slice(0, 30)
  }
  const live = () => memories.filter((m) => !superseded.has(m.id))
  const exactTop5 = (qVec: number[]) =>
    live()
      .map((m) => ({
        id: dbIdByFixtureId.get(m.id) as string,
        s: cosine(qVec, emb.memories[m.id] as number[]),
      }))
      .sort((x, y) => y.s - x.s)
      .slice(0, 5)
      .map((x) => x.id)

  it('FILTERED regime A (natural plan): never a whole-table seqscan; parity holds', async () => {
    const conn = await runtimePool.connect()
    let overlapSum = 0
    const sample = filteredSample()
    try {
      await conn.query('BEGIN')
      await conn.query(`SELECT set_config('app.user_id', $1, true)`, [uid])
      const plan = await conn.query(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM memories WHERE valid_to IS NULL
         ORDER BY embedding <=> $1::vector LIMIT 5`,
        [`[${(emb.queries[0] as number[]).join(',')}]`],
      )
      await conn.query('ROLLBACK')
      const planText = JSON.stringify(plan.rows[0])
      // The pathology this regime guards against is a whole-table Seq Scan on
      // `memories` (unindexed scan + distance sort): at production tenant scale
      // that is the plan pgvector's filtering guidance warns about. Any
      // index-driven plan is acceptable — including the natural per-tenant plan,
      // an Index Scan over the small live set feeding an exact distance Sort
      // (docs/concepts/data-model.mdx regime A). The original assertion allowlisted two index
      // NAMES, but the tags column (0007) shifted stats/width so the planner now
      // reaches the live set via a different index, surfacing a Limit→Sort over
      // an Index Scan that names neither — still NOT a seqscan. Assert the
      // pathology directly: no Seq Scan node over the memories relation.
      expect(
        planHasSeqScanOn(plan.rows[0], 'memories'),
        `unexpected whole-table seqscan: ${planText.slice(0, 300)}`,
      ).toBe(false)

      for (const { i } of sample) {
        const qVec = emb.queries[i] as number[]
        await conn.query('BEGIN')
        await conn.query(`SELECT set_config('app.user_id', $1, true)`, [uid])
        const r = await conn.query(
          `SELECT id FROM memories WHERE valid_to IS NULL
           ORDER BY embedding <=> $1::vector LIMIT 5`,
          [`[${qVec.join(',')}]`],
        )
        await conn.query('ROLLBACK')
        const got = new Set(r.rows.map((row) => row.id))
        overlapSum += exactTop5(qVec).filter((id) => got.has(id)).length / 5
      }
    } finally {
      conn.release()
    }
    expect(overlapSum / sample.length).toBeGreaterThanOrEqual(0.95)
  }, 120_000)

  it('FILTERED regime B (HNSW forced + iterative scan): post-filter recall holds', async () => {
    // Forcing HNSW needs THREE knobs: seqscan+bitmapscan
    // off still leaves a plain btree Index Scan + Sort available — and that
    // path silently gives exact results without exercising HNSW at all.
    // enable_sort = off kills it: only the HNSW index provides the vector
    // ordering natively. The EXPLAIN assertion proves the regime, per query run.
    const forceHnsw = async (conn: pg.PoolClient) => {
      await conn.query('SET LOCAL enable_seqscan = off')
      await conn.query('SET LOCAL enable_bitmapscan = off')
      await conn.query('SET LOCAL enable_sort = off')
      await conn.query('SET LOCAL hnsw.iterative_scan = relaxed_order')
    }
    const conn = await runtimePool.connect()
    let overlapSum = 0
    const sample = filteredSample()
    try {
      // plan assertion: the forced regime really is the HNSW index
      await conn.query('BEGIN')
      await conn.query(`SELECT set_config('app.user_id', $1, true)`, [uid])
      await forceHnsw(conn)
      const plan = await conn.query(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM memories WHERE valid_to IS NULL
         ORDER BY embedding <=> $1::vector LIMIT 5`,
        [`[${(emb.queries[0] as number[]).join(',')}]`],
      )
      await conn.query('ROLLBACK')
      const planText = JSON.stringify(plan.rows[0])
      expect(planText, `forced plan must use HNSW: ${planText.slice(0, 300)}`).toContain(
        'memories_embedding_idx',
      )

      for (const { i } of sample) {
        const qVec = emb.queries[i] as number[]
        await conn.query('BEGIN')
        await conn.query(`SELECT set_config('app.user_id', $1, true)`, [uid])
        await forceHnsw(conn)
        const r = await conn.query(
          `SELECT id FROM memories WHERE valid_to IS NULL
           ORDER BY embedding <=> $1::vector LIMIT 5`,
          [`[${qVec.join(',')}]`],
        )
        await conn.query('ROLLBACK')
        const got = new Set(r.rows.map((row) => row.id))
        overlapSum += exactTop5(qVec).filter((id) => got.has(id)).length / 5
      }
    } finally {
      conn.release()
    }
    expect(overlapSum / sample.length).toBeGreaterThanOrEqual(0.95)
  }, 120_000)
})
