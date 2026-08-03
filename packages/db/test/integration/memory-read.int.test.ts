// SPDX-License-Identifier: Apache-2.0
// Integration coverage for dashboard memory reads through the runtime role.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getMemoryById, listMemories, withTenant } from '../../src/index.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string

async function seedMemory(input: {
  userId: string
  memoryType: string
  topic: string
  content: string
  /** Optional explicit transaction time for recorded_at-range tests. */
  recordedAt?: string
}): Promise<string> {
  const result = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, scope, project, content_hash, recorded_at)
     VALUES ($1, $2, $3, $4, 'work', '3ngram', encode(sha256($5::bytea), 'hex'),
             coalesce($6::timestamptz, now()))
     RETURNING id`,
    [
      input.userId,
      input.memoryType,
      input.topic,
      input.content,
      input.content,
      input.recordedAt ?? null,
    ],
  )
  return result.rows[0].id
}

async function seedCommitment(userId: string, memoryId: string, status: string): Promise<void> {
  await ownerPool.query(
    'INSERT INTO commitments (user_id, memory_id, status) VALUES ($1, $2, $3)',
    [userId, memoryId, status],
  )
}

beforeAll(async () => {
  userA = await seedUser('memory-read-a@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('dashboard memory reads', () => {
  it('left joins commitment status for list and detail without selecting content in lists', async () => {
    const commitmentId = await seedMemory({
      userId: userA,
      memoryType: 'commitment',
      topic: 'send update',
      content: 'send the investor update',
    })
    const noteId = await seedMemory({
      userId: userA,
      memoryType: 'note',
      topic: 'plain note',
      content: 'ordinary body',
    })
    await seedCommitment(userA, commitmentId, 'resolved')

    const rows = await withTenant(userA, (tx) => listMemories(tx, userA, { limit: 10, offset: 0 }))
    const byId = new Map(rows.map((row) => [row.id, row]))

    expect(byId.get(commitmentId)?.status).toBe('active')
    expect(byId.get(commitmentId)?.commitmentStatus).toBe('resolved')
    expect(byId.get(noteId)?.commitmentStatus).toBeNull()
    expect(byId.get(commitmentId) as Record<string, unknown>).not.toHaveProperty('content')

    const detail = await withTenant(userA, (tx) => getMemoryById(tx, userA, commitmentId))
    expect(detail?.status).toBe('active')
    expect(detail?.commitmentStatus).toBe('resolved')
  })
})

describe('list filters V2 — memoryTypes OR-set + recorded_at range (#48)', () => {
  let decId: string
  let factId: string
  let noteId: string

  beforeEach(async () => {
    decId = await seedMemory({
      userId: userA,
      memoryType: 'decision',
      topic: 'jan decision',
      content: 'decided in january',
      recordedAt: '2026-01-01T00:00:00Z',
    })
    factId = await seedMemory({
      userId: userA,
      memoryType: 'fact',
      topic: 'feb fact',
      content: 'learned in february',
      recordedAt: '2026-02-01T00:00:00Z',
    })
    noteId = await seedMemory({
      userId: userA,
      memoryType: 'note',
      topic: 'mar note',
      content: 'noted in march',
      recordedAt: '2026-03-01T00:00:00Z',
    })
  })

  const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id).sort()

  it('memoryTypes array narrows via inArray (repeated-param path)', async () => {
    const rows = await withTenant(userA, (tx) =>
      listMemories(tx, userA, { limit: 10, offset: 0, memoryTypes: ['decision', 'fact'] }),
    )
    expect(ids(rows)).toEqual([decId, factId].sort())
  })

  it('a single-string memoryTypes narrows via eq (single-param path)', async () => {
    const rows = await withTenant(userA, (tx) =>
      listMemories(tx, userA, { limit: 10, offset: 0, memoryTypes: 'note' }),
    )
    expect(ids(rows)).toEqual([noteId])
  })

  it('recordedAfter / recordedBefore bound the list inclusively', async () => {
    const after = await withTenant(userA, (tx) =>
      listMemories(tx, userA, {
        limit: 10,
        offset: 0,
        recordedAfter: new Date('2026-02-01T00:00:00Z'), // inclusive: keeps the Feb fact
      }),
    )
    expect(ids(after)).toEqual([factId, noteId].sort())

    const before = await withTenant(userA, (tx) =>
      listMemories(tx, userA, {
        limit: 10,
        offset: 0,
        recordedBefore: new Date('2026-02-01T00:00:00Z'), // inclusive: keeps the Feb fact
      }),
    )
    expect(ids(before)).toEqual([decId, factId].sort())
  })

  it('V2 axes compose (AND) with each other and the paged count', async () => {
    const rows = await withTenant(userA, (tx) =>
      listMemories(tx, userA, {
        limit: 10,
        offset: 0,
        memoryTypes: ['decision', 'fact', 'note'],
        recordedAfter: new Date('2026-01-15T00:00:00Z'),
        recordedBefore: new Date('2026-02-15T00:00:00Z'),
      }),
    )
    expect(ids(rows)).toEqual([factId])
  })
})
