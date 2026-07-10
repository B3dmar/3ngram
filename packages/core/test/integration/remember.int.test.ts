// SPDX-License-Identifier: Apache-2.0
// Integration — remember() against the real runtime role (app_user,
// NOBYPASSRLS) on the CI ephemeral Neon branch. Proves the write-path
// invariants that unit tests (mocked db) cannot:
//   - memory row + create audit event land atomically in ONE withTenant tx
//   - they roll back together when the event INSERT fails (no orphan memory)
//   - tags round-trip as string[] through the jsonb column
//   - RLS write isolation: a write is scoped to its tenant, invisible to others
//   - re-asserting live content surfaces a typed DuplicateMemoryError
//
// Reuses packages/db integration infra (helpers.ts).

import { createHash } from 'node:crypto'
import { closeDb, DuplicateMemoryError, writeMemory } from '@3ngram/db'
import type { ActorKind } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { remember } from '../../src/write/remember.js'

let userA: string
let userB: string

const ACTOR: ActorKind = 'user_api'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const baseInput = () => ({
  memoryType: 'note',
  topic: 'release process',
  content: 'releases cut from main after the staging soak',
  tags: ['ops', 'release'],
})

beforeAll(async () => {
  userA = await seedUser('remember-a@test.local')
  userB = await seedUser('remember-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('remember (runtime role, real withTenant)', () => {
  it('lands a memory row and its create event atomically, with NULL embedding', async () => {
    const input = baseInput()
    const { id } = await remember(userA, input, ACTOR)

    const memory = await ownerPool.query(
      'SELECT user_id, memory_type, topic, content, content_hash, embedding, status FROM memories WHERE id = $1',
      [id],
    )
    expect(memory.rowCount).toBe(1)
    expect(memory.rows[0].user_id).toBe(userA)
    expect(memory.rows[0].content_hash).toBe(sha256(input.content))
    expect(memory.rows[0].embedding).toBeNull()
    expect(memory.rows[0].status).toBe('active')

    const events = await ownerPool.query(
      'SELECT event_kind, actor_kind FROM memory_events WHERE memory_id = $1',
      [id],
    )
    expect(events.rowCount).toBe(1)
    expect(events.rows[0].event_kind).toBe('create')
    expect(events.rows[0].actor_kind).toBe(ACTOR)
  })

  it('round-trips tags as a string[] through the jsonb column', async () => {
    const { id } = await remember(userA, { ...baseInput(), tags: ['alpha', 'beta'] }, ACTOR)

    const r = await ownerPool.query<{ tags: string[] }>('SELECT tags FROM memories WHERE id = $1', [
      id,
    ])
    expect(r.rows[0].tags).toEqual(['alpha', 'beta'])
    expect(Array.isArray(r.rows[0].tags)).toBe(true)
  })

  it('defaults tags to [] (not null) when none supplied', async () => {
    const { tags: _drop, ...noTags } = baseInput()
    const { id } = await remember(userA, noTags, ACTOR)

    const r = await ownerPool.query<{ tags: string[] }>('SELECT tags FROM memories WHERE id = $1', [
      id,
    ])
    expect(r.rows[0].tags).toEqual([])
  })

  it('rolls back the memory row when the audit event INSERT fails (atomic write)', async () => {
    const input = baseInput()
    // An invalid actor_kind fails the memory_events CHECK *after* the memory
    // INSERT in the same transaction — the memory must NOT survive.
    await expect(
      writeMemory({
        userId: userA,
        memoryType: input.memoryType,
        topic: input.topic,
        content: input.content,
        scope: 'personal',
        tags: input.tags,
        contentHash: sha256(input.content),
        actorKind: 'not_a_real_actor' as unknown as ActorKind,
      }),
    ).rejects.toThrow()

    const memory = await ownerPool.query('SELECT count(*) AS n FROM memories WHERE user_id = $1', [
      userA,
    ])
    expect(Number(memory.rows[0].n)).toBe(0)
    const events = await ownerPool.query('SELECT count(*) AS n FROM memory_events')
    expect(Number(events.rows[0].n)).toBe(0)
  })

  it('isolates writes by tenant: B never sees A’s memory (RLS)', async () => {
    await remember(userA, baseInput(), ACTOR)

    const seenByB = await ownerPool.query('SELECT count(*) AS n FROM memories WHERE user_id = $1', [
      userB,
    ])
    expect(Number(seenByB.rows[0].n)).toBe(0)

    const seenByA = await ownerPool.query('SELECT count(*) AS n FROM memories WHERE user_id = $1', [
      userA,
    ])
    expect(Number(seenByA.rows[0].n)).toBe(1)
  })

  it('surfaces DuplicateMemoryError when active content is re-asserted', async () => {
    await remember(userA, baseInput(), ACTOR)
    await expect(remember(userA, baseInput(), ACTOR)).rejects.toBeInstanceOf(DuplicateMemoryError)

    // exactly one row — the duplicate was rejected, not silently inserted
    const r = await ownerPool.query('SELECT count(*) AS n FROM memories WHERE user_id = $1', [
      userA,
    ])
    expect(Number(r.rows[0].n)).toBe(1)
  })

  it('allows the SAME content for a DIFFERENT tenant (hash space is per-tenant)', async () => {
    await remember(userA, baseInput(), ACTOR)
    await expect(remember(userB, baseInput(), ACTOR)).resolves.toMatchObject({
      id: expect.any(String),
    })
  })
})

describe('remember (commitment-type auto-create, issue #117)', () => {
  const commitmentInput = () => ({
    memoryType: 'commitment',
    topic: 'ship d1',
    content: 'open the d1 revise/resolve PR by friday',
    tags: ['mcp'],
  })

  it('auto-creates an open commitment in the SAME tx and surfaces its id', async () => {
    const { id, commitmentId } = await remember(userA, commitmentInput(), ACTOR)

    expect(commitmentId).toEqual(expect.any(String))
    const commitment = await ownerPool.query(
      'SELECT user_id, memory_id, status FROM commitments WHERE id = $1',
      [commitmentId],
    )
    expect(commitment.rowCount).toBe(1)
    expect(commitment.rows[0].user_id).toBe(userA)
    expect(commitment.rows[0].memory_id).toBe(id)
    expect(commitment.rows[0].status).toBe('open')
  })

  it('does NOT create a commitment for a non-commitment memory', async () => {
    const { id, commitmentId } = await remember(userA, baseInput(), ACTOR)

    expect(commitmentId).toBeUndefined()
    const r = await ownerPool.query('SELECT count(*) AS n FROM commitments WHERE memory_id = $1', [
      id,
    ])
    expect(Number(r.rows[0].n)).toBe(0)
  })

  it('rolls back the memory when the commitment cannot be created (atomic)', async () => {
    // The first commitment memory succeeds; re-asserting the SAME content is a
    // DuplicateMemoryError BEFORE the commitment insert, so no orphan commitment
    // and no second memory survive.
    await remember(userA, commitmentInput(), ACTOR)
    await expect(remember(userA, commitmentInput(), ACTOR)).rejects.toThrow()

    const memories = await ownerPool.query(
      "SELECT count(*) AS n FROM memories WHERE user_id = $1 AND memory_type = 'commitment'",
      [userA],
    )
    expect(Number(memories.rows[0].n)).toBe(1)
    const commitments = await ownerPool.query(
      'SELECT count(*) AS n FROM commitments WHERE user_id = $1',
      [userA],
    )
    expect(Number(commitments.rows[0].n)).toBe(1)
  })

  it('isolates the auto-created commitment by tenant (RLS)', async () => {
    await remember(userA, commitmentInput(), ACTOR)

    const seenByB = await ownerPool.query(
      'SELECT count(*) AS n FROM commitments WHERE user_id = $1',
      [userB],
    )
    expect(Number(seenByB.rows[0].n)).toBe(0)
  })
})
