// SPDX-License-Identifier: Apache-2.0
// Integration — core getMemoriesByIds() against the real runtime role
// (app_user, NOBYPASSRLS). Proves what unit tests cannot:
//   - ONE batched query fetches every requested row (no per-id loop)
//   - notFound derivation: unknown ids come back as DATA, never an error
//   - RLS + the caller-bound predicate: a CROSS-TENANT id lands in notFound
//     exactly like an unknown one (no existence leak, no throw)
//   - an import-scale row (~256K chars) rides back BOUNDED at maxContentChars
//     with the marker + full contentLength (read-side shaping only)
//
// Reuses packages/db integration infra (helpers.ts).
import { randomUUID } from 'node:crypto'
import { closeDb } from '@3ngram/db'
import {
  DEFAULT_GET_CONTENT_CHARS,
  EXCERPT_MARKER,
  MAX_IMPORT_CONTENT_LENGTH,
} from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { getMemoriesByIds } from '../../src/read/memory.js'
import { revise } from '../../src/write/revise.js'

let userA: string
let userB: string

async function seedMemory(userId: string, topic: string, content: string): Promise<string> {
  const result = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, scope, project, content_hash)
     VALUES ($1, 'note', $2, $3, 'work', '3ngram', encode(sha256($4::bytea), 'hex'))
     RETURNING id`,
    [userId, topic, content, content],
  )
  return result.rows[0].id
}

beforeAll(async () => {
  userA = await seedUser('get-memories-a@test.local')
  userB = await seedUser('get-memories-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('getMemoriesByIds supersededBy (issue #223)', () => {
  it('names the direct successor of a revised row and null for the current one', async () => {
    const predecessor = await seedMemory(userA, 'cadence', 'weekly')
    const { id: successor } = await revise(
      userA,
      { memoryType: 'note', topic: 'cadence', content: 'fortnightly', predecessorId: predecessor },
      'user_api',
    )

    const result = await getMemoriesByIds(userA, [predecessor, successor])

    const byId = new Map(result.memories.map((m) => [m.id, m]))
    expect(byId.get(predecessor)?.supersededBy).toEqual({ id: successor, edgeType: 'supersedes' })
    expect(byId.get(successor)?.supersededBy).toBeNull()
  })

  it('reads null for a live row that only carries an imported updates edge', async () => {
    // search.ts supersededExists: an edge alone does not supersede; the target's
    // validity has to be closed as well. Mirror that so one surface never says
    // "superseded" while another says "current".
    const target = await seedMemory(userA, 'live', 'still current')
    const other = await seedMemory(userA, 'other', 'a later note')
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'updates', 'user_api')`,
      [userA, other, target],
    )

    const result = await getMemoriesByIds(userA, [target])

    expect(result.memories[0]?.supersededBy).toBeNull()
  })

  it('reads null for an archived row even with closed validity and an incoming edge', async () => {
    // The blocker archive path sets status='archived' AND valid_to; an imported
    // updates edge may point at it. REST history classifies by status first.
    const archived = await seedMemory(userA, 'blocker gone', 'was blocking')
    const later = await seedMemory(userA, 'later', 'a later note')
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'updates', 'user_api')`,
      [userA, later, archived],
    )
    await ownerPool.query(
      "UPDATE memories SET status = 'archived', valid_to = now() WHERE user_id = $1 AND id = $2",
      [userA, archived],
    )

    const result = await getMemoriesByIds(userA, [archived])

    expect(result.memories[0]?.status).toBe('archived')
    expect(result.memories[0]?.supersededBy).toBeNull()
  })

  it('reports an updates edge on a closed row, ignores additive edges, newest revision wins', async () => {
    const closed = await seedMemory(userA, 'closed', 'old value')
    const first = await seedMemory(userA, 'first', 'newer value')
    const second = await seedMemory(userA, 'second', 'newest value')
    const derived = await seedMemory(userA, 'derived', 'a derivation')
    await ownerPool.query('UPDATE memories SET valid_to = now() WHERE user_id = $1 AND id = $2', [
      userA,
      closed,
    ])
    for (const [from, edge, at] of [
      [first, 'updates', '2026-01-01T00:00:00Z'],
      [derived, 'derives', '2026-01-03T00:00:00Z'],
      [second, 'updates', '2026-01-02T00:00:00Z'],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by, created_at)
         VALUES ($1, $2, $3, $4, 'user_api', $5)`,
        [userA, from, closed, edge, at],
      )
    }

    const result = await getMemoriesByIds(userA, [closed])

    // The derives edge is newest but not a revision; among revision edges the
    // newest wins.
    expect(result.memories[0]?.supersededBy).toEqual({ id: second, edgeType: 'updates' })
  })
})

describe('getMemoriesByIds (runtime role, real withTenant)', () => {
  it('fetches a batch in one read and derives notFound for unknown ids', async () => {
    const id1 = await seedMemory(userA, 'first', 'first body')
    const id2 = await seedMemory(userA, 'second', 'second body')
    const missing = randomUUID()

    const result = await getMemoriesByIds(userA, [id1, id2, missing])

    expect(result.memories).toHaveLength(2)
    const byId = new Map(result.memories.map((m) => [m.id, m]))
    expect(byId.get(id1)?.content).toBe('first body')
    expect(byId.get(id1)?.truncated).toBe(false)
    expect(byId.get(id2)?.topic).toBe('second')
    expect(result.notFound).toEqual([missing])
  })

  it('normalizes mixed-case ids: a FOUND memory never lands in notFound', async () => {
    // z.uuid() accepts uppercase spellings and Postgres's uuid type matches
    // them, but rows come back lowercase — without normalization the diff
    // would report this FOUND memory as notFound too.
    const id = await seedMemory(userA, 'cased', 'cased body')
    const upper = id.toUpperCase()

    const result = await getMemoriesByIds(userA, [upper, id]) // dupe after lowercasing

    expect(result.memories.map((m) => m.id)).toEqual([id])
    expect(result.notFound).toEqual([])
  })

  it('puts a cross-tenant id in notFound — identical to unknown, NEVER an error', async () => {
    const ownId = await seedMemory(userA, 'mine', 'my body')
    const foreignId = await seedMemory(userB, 'theirs', 'their body')

    const result = await getMemoriesByIds(userA, [ownId, foreignId])

    expect(result.memories.map((m) => m.id)).toEqual([ownId])
    expect(result.notFound).toEqual([foreignId])
    // And the foreign row is untouched/invisible, not partially exposed.
    expect(result.memories.some((m) => m.content.includes('their body'))).toBe(false)
  })

  it('bounds an import-scale (~256K) row at EXACTLY maxContentChars with the marker', async () => {
    const huge = 'x'.repeat(MAX_IMPORT_CONTENT_LENGTH) // 262,144 — the import ceiling
    const hugeId = await seedMemory(userA, 'imported transcript', huge)
    const maxContentChars = 4096

    const result = await getMemoriesByIds(userA, [hugeId], { maxContentChars })

    expect(result.memories).toHaveLength(1)
    const item = result.memories[0]
    expect(item?.content.length).toBe(maxContentChars)
    expect(item?.content.endsWith(EXCERPT_MARKER)).toBe(true)
    expect(item?.contentLength).toBe(MAX_IMPORT_CONTENT_LENGTH)
    expect(item?.truncated).toBe(true)
    expect(result.notFound).toEqual([])
  })

  it('applies the schema default bound when no maxContentChars is passed', async () => {
    const long = 'y'.repeat(DEFAULT_GET_CONTENT_CHARS + 100)
    const id = await seedMemory(userA, 'long note', long)

    const { memories } = await getMemoriesByIds(userA, [id])

    expect(memories[0]?.content.length).toBe(DEFAULT_GET_CONTENT_CHARS)
    expect(memories[0]?.truncated).toBe(true)
    expect(memories[0]?.contentLength).toBe(DEFAULT_GET_CONTENT_CHARS + 100)
  })
})
