// SPDX-License-Identifier: Apache-2.0
// Forgetting-pass candidate reads (docs/concepts/forgetting-pass.mdx, "Candidate
// query") through the RUNTIME role via withTenant(), the production path.
//
// Covers: stale singles (briefing's predicate, re-judging only after a change,
// content cut, tenant scoping); newer neighbours (same type and scope, newer,
// live, nearest first); conflict pairs (same type, scope and project above the
// floor, the type allowlist, the three anti-joins, newer-first orientation,
// stale-older-first ranking, the limit).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { conflictPairs, newerNeighbours, staleSingles } from '../../src/forgetting-candidates.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string
let userB: string

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const daysAgo = (days: number) => new Date(now - days * DAY).toISOString()
const STALE_BEFORE = new Date(now - 30 * DAY)
const TYPES = ['decision', 'preference', 'fact'] as const

/** A 1536-d embedding with weight on the given axes; cosine is the dot product of unit vectors. */
function embedding(weights: Record<number, number>): string {
  const vec = new Array(1536).fill(0)
  for (const [axis, w] of Object.entries(weights)) vec[Number(axis)] = w
  return `[${vec.join(',')}]`
}
/** Unit vector at angle with cosine `similarity` to axis 0. */
const near = (similarity: number) => ({ 0: similarity, 1: Math.sqrt(1 - similarity ** 2) })

interface SeedOptions {
  type?: string
  scope?: string
  project?: string | null
  embed?: Record<number, number> | null
  createdDaysAgo?: number
  touchedDaysAgo?: number
  content?: string
}

/** Insert a live memory (owner pool); returns its id. */
async function seed(userId: string, o: SeedOptions = {}): Promise<string> {
  const created = daysAgo(o.createdDaysAgo ?? 90)
  const touched = daysAgo(o.touchedDaysAgo ?? 60)
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, scope, project,
                           embedding, created_at, recorded_at, valid_from, updated_at)
     VALUES ($1, $2, 'topic', $3, md5(random()::text), $4, $5, $6::vector,
             $7::timestamptz, $7::timestamptz, $7::timestamptz, $8::timestamptz)
     RETURNING id`,
    [
      userId,
      o.type ?? 'decision',
      o.content ?? 'content',
      o.scope ?? 'work',
      o.project === undefined ? '3ngram' : o.project,
      o.embed === null ? null : embedding(o.embed ?? { 0: 1 }),
      created,
      touched,
    ],
  )
  return (r.rows[0] as { id: string }).id
}

async function verdictOn(userId: string, memoryId: string, createdDaysAgo: number): Promise<void> {
  await ownerPool.query(
    `INSERT INTO retention_proposals (user_id, memory_id, action, probability, probabilities, model,
                                      status, created_at)
     VALUES ($1, $2, 'keep', 0.9, '{"keep":0.9}'::jsonb, 'jev-test', 'dismissed', $3::timestamptz)`,
    [userId, memoryId, daysAgo(createdDaysAgo)],
  )
}

/** An OPEN proposal on `memoryId`; `related` makes it a conflict with that memory. */
async function openProposalOn(
  userId: string,
  memoryId: string,
  createdDaysAgo: number,
  related?: string,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO retention_proposals (user_id, memory_id, action, related_memory_id, probability,
                                      probabilities, model, status, created_at)
     VALUES ($1, $2, $3, $4, 0.9, '{}'::jsonb, 'jev-test', 'proposed', $5::timestamptz)`,
    [
      userId,
      memoryId,
      related === undefined ? 'archive' : 'conflict',
      related ?? null,
      daysAgo(createdDaysAgo),
    ],
  )
}

const singles = (userId: string, limit = 60, contentChars = 1200) =>
  withTenant(userId, (tx) =>
    staleSingles(tx, userId, {
      staleBefore: STALE_BEFORE,
      memoryTypes: TYPES,
      limit,
      contentChars,
    }),
  )

const pairs = (userId: string, limit = 40, conflictFloor = 0.82) =>
  withTenant(userId, (tx) =>
    conflictPairs(tx, userId, {
      conflictFloor,
      memoryTypes: TYPES,
      staleBefore: STALE_BEFORE,
      limit,
      contentChars: 1200,
    }),
  )

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`forget-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`forget-b-${crypto.randomUUID()}@test.local`)
})

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('staleSingles', () => {
  it('returns live stale memories of the allowed types, most stale first, with content cut', async () => {
    const stalest = await seed(userA, { touchedDaysAgo: 200, content: 'x'.repeat(50) })
    const stale = await seed(userA, { type: 'fact', touchedDaysAgo: 60 })
    await seed(userA, { touchedDaysAgo: 5 }) // fresh
    await seed(userA, { type: 'note', touchedDaysAgo: 200 })
    await seed(userA, { type: 'event', touchedDaysAgo: 200 })
    const superseded = await seed(userA, { touchedDaysAgo: 200 })
    await ownerPool.query(`UPDATE memories SET valid_to = now() WHERE id = $1`, [superseded])
    const archived = await seed(userA, { touchedDaysAgo: 200 })
    await ownerPool.query(`UPDATE memories SET status = 'archived' WHERE id = $1`, [archived])
    await seed(userB, { touchedDaysAgo: 300 })

    const rows = await singles(userA, 60, 10)
    expect(rows.map((r) => r.id)).toEqual([stalest, stale])
    expect(rows[0]?.content).toBe('x'.repeat(10))
    expect(rows[0]?.lastTouchedAt.toISOString()).toBe(daysAgo(200))
    expect((await singles(userA, 1)).map((r) => r.id)).toEqual([stalest])
  })

  it('skips a memory judged since it last changed, and returns it again once it changes', async () => {
    const judged = await seed(userA, { touchedDaysAgo: 60 })
    await verdictOn(userA, judged, 10)
    expect(await singles(userA)).toEqual([])
    // A reaffirm after the verdict moves its freshness past it, but it is no
    // longer stale either; a verdict older than the last touch no longer counts.
    const touchedAfter = await seed(userA, { touchedDaysAgo: 40 })
    await verdictOn(userA, touchedAfter, 50)
    expect((await singles(userA)).map((r) => r.id)).toEqual([touchedAfter])
  })

  it('skips a memory with an open proposal, or on the other side of a conflict verdict', async () => {
    const open = await seed(userA, { touchedDaysAgo: 40 })
    await openProposalOn(userA, open, 50) // older than its last change, but still open
    const other = await seed(userA, { touchedDaysAgo: 5 })
    const side = await seed(userA, { touchedDaysAgo: 60 })
    await openProposalOn(userA, other, 1, side)
    expect(await singles(userA)).toEqual([])
  })
})

describe('newerNeighbours', () => {
  it('lists newer live memories of the same type and scope, nearest first', async () => {
    const single = await seed(userA, { createdDaysAgo: 100, embed: { 0: 1 } })
    const nearest = await seed(userA, { createdDaysAgo: 10, embed: near(0.95) })
    const next = await seed(userA, { createdDaysAgo: 20, embed: near(0.7) })
    await seed(userA, { createdDaysAgo: 30, embed: near(0.5) }) // beyond perMemory
    await seed(userA, { createdDaysAgo: 200, embed: near(0.99) }) // older
    await seed(userA, { createdDaysAgo: 10, type: 'fact', embed: near(0.99) }) // other type
    await seed(userA, { createdDaysAgo: 10, scope: 'personal', embed: near(0.99) }) // other scope
    const superseded = await seed(userA, { createdDaysAgo: 10, embed: near(0.99) })
    await ownerPool.query(`UPDATE memories SET valid_to = now() WHERE id = $1`, [superseded])
    const unembedded = await seed(userA, { embed: null })
    await seed(userB, { createdDaysAgo: 5, embed: { 0: 1 } }) // nearer, but another tenant

    const rows = await withTenant(userA, (tx) =>
      newerNeighbours(tx, userA, [single, unembedded], { perMemory: 2, contentChars: 300 }),
    )
    expect(rows.map((r) => [r.forId, r.id])).toEqual([
      [single, nearest],
      [single, next],
    ])
    expect(rows[0]?.similarity).toBeCloseTo(0.95, 5)
    expect(rows[0]?.recordedAt.toISOString()).toBe(daysAgo(10))
  })
})

describe('conflictPairs', () => {
  it('pairs same type, scope and project above the floor, oriented newer first', async () => {
    const older = await seed(userA, { createdDaysAgo: 100, embed: { 0: 1 } })
    const newer = await seed(userA, { createdDaysAgo: 10, touchedDaysAgo: 10, embed: near(0.9) })
    await seed(userA, { project: 'other', embed: near(0.95) })
    await seed(userA, { project: null, embed: near(0.95) })
    await seed(userA, { scope: 'personal', embed: near(0.95) })
    await seed(userA, { type: 'fact', embed: near(0.95) })
    await seed(userA, { type: 'note', embed: { 5: 1 } })
    await seed(userA, { type: 'note', embed: { 5: 1 } }) // a note pair: type not allowed
    await seed(userA, { embed: { 0: 0.5, 9: Math.sqrt(0.75) } }) // below the floor with both
    await seed(userB, { embed: { 0: 1 } })

    const rows = await pairs(userA)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.newer.id).toBe(newer)
    expect(rows[0]?.older.id).toBe(older)
    expect(rows[0]?.similarity).toBeCloseTo(0.9, 5)
    expect(rows[0]?.olderStale).toBe(true)
    expect(rows[0]?.older.recordedAt.toISOString()).toBe(daysAgo(100))
    expect(rows[0]?.older.lastTouchedAt.toISOString()).toBe(daysAgo(60))
    expect(rows[0]?.newer.lastTouchedAt.toISOString()).toBe(daysAgo(10))
  })

  it('skips a pair while either side has an open proposal', async () => {
    const older = await seed(userA, { embed: { 4: 1 }, touchedDaysAgo: 20 })
    await seed(userA, { embed: { 4: 1 }, touchedDaysAgo: 5 })
    await openProposalOn(userA, older, 50) // older than both changes, but still open
    expect(await pairs(userA)).toEqual([])
  })

  it('skips pairs with an edge, a consolidation proposal, or a verdict since both changed', async () => {
    const edged = [await seed(userA, { embed: { 0: 1 } }), await seed(userA, { embed: { 0: 1 } })]
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'extends', 'user_api')`,
      [userA, edged[1], edged[0]],
    )
    const proposed = [
      await seed(userA, { embed: { 1: 1 } }),
      await seed(userA, { embed: { 1: 1 } }),
    ]
    await ownerPool.query(
      `INSERT INTO consolidation_proposals (user_id, from_id, to_id, edge_type, memory_type, similarity, status)
       VALUES ($1, $2, $3, 'extends', 'decision', 0.99, 'rejected')`,
      [userA, proposed[1], proposed[0]],
    )
    const judged = [await seed(userA, { embed: { 2: 1 } }), await seed(userA, { embed: { 2: 1 } })]
    await verdictOn(userA, judged[0] as string, 10)
    const reopened = [
      await seed(userA, { embed: { 3: 1 } }),
      await seed(userA, { embed: { 3: 1 }, touchedDaysAgo: 5 }),
    ]
    await verdictOn(userA, reopened[0] as string, 10) // older than the second side's change

    const rows = await pairs(userA)
    expect(rows.map((r) => [r.older.id, r.newer.id].sort())).toEqual([[...reopened].sort()])
  })

  it('ranks pairs whose older side is stale first, then by similarity, within the limit', async () => {
    const freshOlder = await seed(userA, { createdDaysAgo: 20, touchedDaysAgo: 5, embed: { 0: 1 } })
    await seed(userA, { createdDaysAgo: 10, touchedDaysAgo: 5, embed: { 0: 1 } })
    const staleOlder = await seed(userA, {
      createdDaysAgo: 100,
      touchedDaysAgo: 90,
      embed: { 7: 1 },
    })
    await seed(userA, {
      createdDaysAgo: 10,
      touchedDaysAgo: 5,
      embed: { 7: 0.9, 8: Math.sqrt(0.19) },
    })

    const rows = await pairs(userA)
    expect(rows.map((r) => [r.older.id, r.olderStale])).toEqual([
      [staleOlder, true],
      [freshOlder, false],
    ])
    expect((await pairs(userA, 1)).map((r) => r.older.id)).toEqual([staleOlder])
  })
})
