// SPDX-License-Identifier: Apache-2.0
// Integration — complete, read-only proposal-review pagination (issue #320)
// against the real runtime role. The fixture holds >100 edge AND >100 fact
// proposals, written in a few transactions so whole batches share ONE
// microsecond `created_at` (within a kind and ACROSS kinds). This suite proves,
// at the core seam both transports call:
//   - a read-only consumer enumerates the complete set exactly once, at several
//     page sizes, including the exact-boundary case (no empty trailing page)
//     and an empty queue;
//   - the live-view contract (packages/schema/src/proposals-page.ts): rows
//     decided mid-walk leave a status filter without skipping or repeating any
//     other row; rows created mid-walk are not seen until a fresh walk; totals
//     are live per page;
//   - listing never changes proposal, memory, edge, or fact rows.
// The opaque cursor (tenant/filter binding, malformed tokens) is proven
// through the transports in apps/server.
//
// Reuses packages/db integration infra (helpers.ts).
import {
  closeDb,
  type FactProposalWrite,
  insertFactProposals,
  insertProposals,
  type ProposalWrite,
  withTenant,
} from '@3ngram/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { acceptProposalAnyKind, rejectProposalAnyKind } from '../../src/admin/proposals.js'
import {
  listEdgeProposalsPage,
  listProposalsPage,
  type ProposalPosition,
  type ProposalsPage,
} from '../../src/admin/proposals-page.js'

const EDGE_TOTAL = 130
const FACT_TOTAL = 130

let userId: string
let otherUserId: string
let memories: string[]
/** Every ordered memory pair, consumed in order so each edge candidate is distinct. */
let pairs: Array<[string, string]>
let factSeq = 0

async function seedMemories(owner: string, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1, 'fact', 'proposals-page', 'proposals-page-content', $2) RETURNING id`,
      [owner, `pp-core-${owner}-${i}-${Math.random()}`],
    )
    ids.push(r.rows[0].id)
  }
  return ids
}

function edges(owner: string, count: number): ProposalWrite[] {
  return pairs.splice(0, count).map(([fromId, toId]) => ({
    userId: owner,
    fromId,
    toId,
    edgeType: 'extends',
    memoryType: 'fact',
    similarity: 0.91,
  }))
}

function facts(owner: string, memoryId: string, count: number): FactProposalWrite[] {
  return Array.from({ length: count }, () => ({
    userId: owner,
    memoryId,
    subject: 'proposals.page',
    predicate: 'seed.value',
    value: `v-${factSeq++}`,
    memoryType: 'fact',
  }))
}

/** One transaction = one now(): every row in the batch ties on created_at. */
function batch(owner: string, edgeCount: number, factCount: number, memoryId: string) {
  return withTenant(owner, async (tx) => {
    await insertProposals(tx, edges(owner, edgeCount))
    await insertFactProposals(tx, facts(owner, memoryId, factCount))
  })
}

async function allIds(table: 'consolidation_proposals' | 'fact_proposals', owner: string) {
  const r = await ownerPool.query(`SELECT id FROM ${table} WHERE user_id = $1`, [owner])
  return new Set<string>(r.rows.map((row: { id: string }) => row.id))
}

const pageIds = (page: ProposalsPage) => [
  ...page.proposals.map((p) => p.id),
  ...page.factProposals.map((p) => p.id),
]

/** Walk to exhaustion, calling `between` after each page (for mid-walk changes). */
async function walk(
  owner: string,
  limit: number,
  status?: string,
  between?: (page: ProposalsPage, index: number) => Promise<void>,
): Promise<ProposalsPage[]> {
  const pages: ProposalsPage[] = []
  let after: ProposalPosition | undefined
  for (let i = 0; i < 100; i++) {
    const page = await listProposalsPage(owner, { status, limit, after })
    pages.push(page)
    if (!page.hasMore) return pages
    expect(page.next).toBeDefined()
    after = page.next
    if (between) await between(page, i)
  }
  throw new Error('walk did not terminate')
}

function expectExactlyOnce(pages: ProposalsPage[], expected: Set<string>) {
  const seen = pages.flatMap(pageIds)
  expect(new Set(seen).size).toBe(seen.length) // no duplicate id in the walk
  expect(new Set(seen)).toEqual(expected)
}

/** Every row a listing could conceivably touch, as JSON, for before/after equality. */
async function snapshot(owner: string): Promise<string> {
  const tables = ['consolidation_proposals', 'fact_proposals', 'memories', 'memory_edges', 'facts']
  const parts: unknown[] = []
  for (const table of tables) {
    const r = await ownerPool.query(`SELECT * FROM ${table} WHERE user_id = $1 ORDER BY id`, [
      owner,
    ])
    parts.push(r.rows)
  }
  return JSON.stringify(parts)
}

beforeAll(async () => {
  await resetDomainTables()
}, 120_000)

beforeEach(async () => {
  await resetDomainTables()
  userId = await seedUser('proposals-page-core@test.local')
  otherUserId = await seedUser('proposals-page-core-other@test.local')
  memories = await seedMemories(userId, 16)
  pairs = memories.flatMap((from) =>
    memories.filter((to) => to !== from).map((to): [string, string] => [from, to]),
  )
  const anchor = memories[0] as string
  // 130 edge + 130 fact proposals in four transactions; batch 1 ties ACROSS kinds.
  await batch(userId, 60, 60, anchor)
  await batch(userId, 45, 0, anchor)
  await batch(userId, 0, 50, anchor)
  await batch(userId, 25, 20, anchor)
  // A second tenant's queue, which must never appear in or count toward ours.
  const otherMemories = await seedMemories(otherUserId, 3)
  const savedPairs = pairs
  pairs = [[otherMemories[0] as string, otherMemories[1] as string]]
  await batch(otherUserId, 1, 7, otherMemories[0] as string)
  pairs = savedPairs
}, 60_000)

afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('listProposalsPage — complete enumeration', () => {
  it('fixture sanity: >100 of each kind, with same-timestamp groups within and across kinds', async () => {
    const r = await ownerPool.query(
      `SELECT count(*)::int AS n, count(DISTINCT created_at)::int AS stamps
       FROM (SELECT created_at FROM consolidation_proposals WHERE user_id = $1
             UNION ALL SELECT created_at FROM fact_proposals WHERE user_id = $1) u`,
      [userId],
    )
    expect(r.rows[0]).toEqual({ n: EDGE_TOTAL + FACT_TOTAL, stamps: 4 })
  })

  it.each([
    25, 100, 7,
  ])('limit %i: every id exactly once, in strict merged order', async (limit) => {
    const expected = new Set([
      ...(await allIds('consolidation_proposals', userId)),
      ...(await allIds('fact_proposals', userId)),
    ])
    const pages = await walk(userId, limit)
    expectExactlyOnce(pages, expected)
    expect(pages).toHaveLength(Math.ceil(expected.size / limit))
    for (const page of pages) {
      expect(pageIds(page).length).toBeLessThanOrEqual(limit)
      expect(page.totals).toEqual({ edge: EDGE_TOTAL, fact: FACT_TOTAL })
    }
    // Strictly descending (createdAt, id) across the whole walk.
    const ordered = pages.flatMap((page) =>
      [
        ...page.proposals.map((p) => ({ t: p.createdAt.getTime(), id: p.id })),
        ...page.factProposals.map((p) => ({ t: p.createdAt.getTime(), id: p.id })),
      ].sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1)),
    )
    for (let i = 1; i < ordered.length; i++) {
      const [prev, cur] = [ordered[i - 1], ordered[i]] as [(typeof ordered)[0], (typeof ordered)[0]]
      expect(prev.t > cur.t || (prev.t === cur.t && prev.id > cur.id)).toBe(true)
    }
  })

  it('exact boundary: total divisible by limit ends on a full page with hasMore=false', async () => {
    const pages = await walk(userId, 20) // 260 / 20 = 13
    expect(pages).toHaveLength(13)
    const last = pages[12] as ProposalsPage
    expect(pageIds(last)).toHaveLength(20)
    expect(last.hasMore).toBe(false)
    expect(last.next).toBeUndefined()
  })

  it('an empty queue is one empty, final page with zero totals', async () => {
    const empty = await seedUser('proposals-page-empty@test.local')
    const pages = await walk(empty, 25)
    expect(pages).toEqual([
      {
        proposals: [],
        factProposals: [],
        totals: { edge: 0, fact: 0 },
        hasMore: false,
        next: undefined,
      },
    ])
  })

  it('the edge-only walk (REST scope) enumerates every edge proposal exactly once', async () => {
    const expected = await allIds('consolidation_proposals', userId)
    const seen: string[] = []
    let after: ProposalPosition | undefined
    for (let i = 0; i < 100; i++) {
      const page = await listEdgeProposalsPage(userId, { limit: 25, after })
      expect(page.totals).toEqual({ edge: EDGE_TOTAL })
      seen.push(...page.proposals.map((p) => p.id))
      if (!page.hasMore) break
      after = page.next
    }
    expect(seen).toHaveLength(EDGE_TOTAL)
    expect(new Set(seen)).toEqual(expected)
  })

  it('listing never changes proposal, memory, edge, or fact rows', async () => {
    const before = await snapshot(userId)
    await walk(userId, 25)
    await walk(userId, 25, 'proposed')
    expect(await snapshot(userId)).toBe(before)
  })
})

describe('listProposalsPage — live-view semantics', () => {
  it('a row decided mid-walk leaves a status filter: not returned, nothing else skipped or repeated', async () => {
    const expected = new Set([
      ...(await allIds('consolidation_proposals', userId)),
      ...(await allIds('fact_proposals', userId)),
    ])
    const decided = new Set<string>()
    const pages = await walk(userId, 25, 'proposed', async (page, index) => {
      if (index !== 0) return
      // Decide two unseen rows of each kind (accept one, reject one) and one
      // ALREADY-SEEN row, between page 1 and page 2.
      const seen = new Set(pageIds(page))
      const unseenEdges = [...(await allIds('consolidation_proposals', userId))].filter(
        (id) => !seen.has(id),
      )
      const unseenFacts = [...(await allIds('fact_proposals', userId))].filter(
        (id) => !seen.has(id),
      )
      const targets = [unseenEdges[0], unseenEdges[1], unseenFacts[0], unseenFacts[1]] as string[]
      await acceptProposalAnyKind(userId, targets[0] as string, 'user_mcp')
      await rejectProposalAnyKind(userId, targets[1] as string)
      await acceptProposalAnyKind(userId, targets[2] as string, 'user_mcp')
      await rejectProposalAnyKind(userId, targets[3] as string)
      const seenFact = page.factProposals[0]?.id
      expect(seenFact).toBeDefined()
      await rejectProposalAnyKind(userId, seenFact as string)
      for (const id of targets) decided.add(id)
    })
    const remaining = new Set([...expected].filter((id) => !decided.has(id)))
    expectExactlyOnce(pages, remaining)
    // Totals are live per page: page 1 saw the full queue, later pages see it shrunk by 5.
    expect(pages[0]?.totals).toEqual({ edge: EDGE_TOTAL, fact: FACT_TOTAL })
    expect(pages[1]?.totals).toEqual({ edge: EDGE_TOTAL - 2, fact: FACT_TOTAL - 2 - 1 })
    expect(pages.at(-1)?.totals).toEqual(pages[1]?.totals)
  })

  it('without a status filter a decided row is still returned once, with its current status', async () => {
    let target = ''
    const pages = await walk(userId, 25, undefined, async (page, index) => {
      if (index !== 0) return
      const seen = new Set(pageIds(page))
      target = [...(await allIds('fact_proposals', userId))].find((id) => !seen.has(id)) as string
      await rejectProposalAnyKind(userId, target)
    })
    const hits = pages.flatMap((page) => page.factProposals).filter((p) => p.id === target)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.status).toBe('rejected')
    expect(pages.flatMap(pageIds)).toHaveLength(EDGE_TOTAL + FACT_TOTAL)
  })

  it('rows created mid-walk sort newer than the cursor: unseen until a fresh walk', async () => {
    const expected = new Set([
      ...(await allIds('consolidation_proposals', userId)),
      ...(await allIds('fact_proposals', userId)),
    ])
    const pages = await walk(userId, 25, undefined, async (_page, index) => {
      if (index === 2) await batch(userId, 3, 4, memories[1] as string)
    })
    expectExactlyOnce(pages, expected)
    // Totals moved live once the new rows existed.
    expect(pages.at(-1)?.totals).toEqual({ edge: EDGE_TOTAL + 3, fact: FACT_TOTAL + 4 })
    // A fresh walk sees all of them.
    const fresh = await walk(userId, 100)
    expect(fresh.flatMap(pageIds)).toHaveLength(EDGE_TOTAL + FACT_TOTAL + 7)
    const created = fresh.flatMap(pageIds).filter((id) => !expected.has(id))
    expect(created).toHaveLength(7)
    // Newest first: all of them land on the fresh walk's first page.
    expect(created.every((id) => pageIds(fresh[0] as ProposalsPage).includes(id))).toBe(true)
  })
})
