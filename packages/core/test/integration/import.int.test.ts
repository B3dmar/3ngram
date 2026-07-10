// SPDX-License-Identifier: Apache-2.0
// Integration — the import facade against the real runtime role (app_user,
// NOBYPASSRLS) on the CI ephemeral Neon branch. Proves the import-path
// invariants that unit tests (mocked db) cannot:
//   - original-history overrides (recorded_at/valid_from/status) land verbatim
//   - the 'import' audit event carries the payload and the ORIGINAL created_at
//   - a commitment-type import lands at its INITIAL FSM state in one tx
//     (insert-with-initial-status: the FSM trigger guards UPDATE only)
//   - historical events append with their original timestamps
//   - a supersedes edge + valid_to close land atomically at the supplied instant
//   - a row imported already-superseded may share content with the live row
//   - facts round-trip their bi-temporal range
//
// Reuses packages/db integration infra (helpers.ts).

import { closeDb } from '@3ngram/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import {
  DuplicateMemoryError,
  ImportTargetNotFoundError,
  importEdge,
  importEvent,
  importFact,
  importMemory,
} from '../../src/import/index.js'
import { remember } from '../../src/write/remember.js'

let userA: string

const T0 = '2024-03-01T12:00:00.000Z'
const T1 = '2024-06-01T12:00:00.000Z'

const baseInput = () => ({
  memoryType: 'note',
  topic: 'imported note',
  content: 'the pipeline deployed from jenkins before the migration',
  tags: ['legacy'],
})

beforeAll(async () => {
  userA = await seedUser('import-a@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('importMemory (original history, runtime role)', () => {
  it('lands overridden timestamps/status and the import event payload verbatim', async () => {
    const { id } = await importMemory(
      userA,
      {
        ...baseInput(),
        status: 'archived',
        recordedAt: T0,
        validFrom: T0,
        event: { payload: { sourceId: '42', sourceType: 'note' }, createdAt: T0 },
      },
      { skipEmbed: true },
    )

    const memory = await ownerPool.query(
      'SELECT status, recorded_at, valid_from, valid_to, embedding FROM memories WHERE id = $1',
      [id],
    )
    expect(memory.rows[0].status).toBe('archived')
    expect(memory.rows[0].recorded_at.toISOString()).toBe(T0)
    expect(memory.rows[0].valid_from.toISOString()).toBe(T0)
    expect(memory.rows[0].valid_to).toBeNull()
    expect(memory.rows[0].embedding).toBeNull()

    const events = await ownerPool.query(
      'SELECT event_kind, actor_kind, payload, created_at FROM memory_events WHERE memory_id = $1',
      [id],
    )
    expect(events.rowCount).toBe(1)
    expect(events.rows[0].event_kind).toBe('import')
    expect(events.rows[0].actor_kind).toBe('importer')
    expect(events.rows[0].payload).toEqual({ sourceId: '42', sourceType: 'note' })
    expect(events.rows[0].created_at.toISOString()).toBe(T0)
  })

  it('creates the commitment at its INITIAL FSM state in the same tx', async () => {
    const { id, commitmentId } = await importMemory(
      userA,
      {
        ...baseInput(),
        memoryType: 'commitment',
        topic: 'historical commitment',
        content: 'ship the legacy migration runbook',
        commitment: {
          status: 'resolved',
          owner: 'seb',
          dueAt: T0,
          resolvedAt: T1,
        },
      },
      { skipEmbed: true },
    )

    expect(commitmentId).toEqual(expect.any(String))
    const commitment = await ownerPool.query(
      'SELECT memory_id, status, owner, due_at, resolved_at FROM commitments WHERE id = $1',
      [commitmentId],
    )
    expect(commitment.rows[0].memory_id).toBe(id)
    expect(commitment.rows[0].status).toBe('resolved')
    expect(commitment.rows[0].owner).toBe('seb')
    expect(commitment.rows[0].due_at.toISOString()).toBe(T0)
    expect(commitment.rows[0].resolved_at.toISOString()).toBe(T1)
  })

  it('allows a row imported already-superseded to share content with the live row', async () => {
    // A native live row holds the hash slot...
    await remember(userA, baseInput(), 'user_api')
    // ...and the SAME content imports cleanly as a CLOSED historical version
    // (outside the live-hash space), while a LIVE duplicate import still conflicts.
    const closed = await importMemory(
      userA,
      { ...baseInput(), validFrom: T0, validTo: T1 },
      { skipEmbed: true },
    )
    expect(closed.id).toEqual(expect.any(String))
    await expect(importMemory(userA, baseInput(), { skipEmbed: true })).rejects.toBeInstanceOf(
      DuplicateMemoryError,
    )
  })
})

describe('importEvent / importEdge / importFact (runtime role)', () => {
  it('appends a historical event with its original timestamp', async () => {
    const { id } = await importMemory(userA, baseInput(), { skipEmbed: true })

    await importEvent(userA, {
      memoryId: id,
      eventKind: 'resolve',
      payload: { sourceEventId: '7' },
      createdAt: T1,
    })

    const events = await ownerPool.query(
      "SELECT actor_kind, payload, created_at FROM memory_events WHERE memory_id = $1 AND event_kind = 'resolve'",
      [id],
    )
    expect(events.rowCount).toBe(1)
    expect(events.rows[0].actor_kind).toBe('importer')
    expect(events.rows[0].payload).toEqual({ sourceEventId: '7' })
    expect(events.rows[0].created_at.toISOString()).toBe(T1)
  })

  it('writes a supersedes edge and closes the predecessor at the supplied instant', async () => {
    const predecessor = await importMemory(
      userA,
      { ...baseInput(), validFrom: T0 },
      { skipEmbed: true },
    )
    const successor = await importMemory(
      userA,
      { ...baseInput(), topic: 'imported note v2', content: 'jenkins was replaced by actions' },
      { skipEmbed: true },
    )

    await importEdge(userA, {
      fromId: successor.id,
      toId: predecessor.id,
      edgeType: 'supersedes',
      closePredecessorAt: T1,
    })

    const edge = await ownerPool.query(
      'SELECT edge_type, created_by FROM memory_edges WHERE from_id = $1 AND to_id = $2',
      [successor.id, predecessor.id],
    )
    expect(edge.rowCount).toBe(1)
    expect(edge.rows[0].edge_type).toBe('supersedes')
    expect(edge.rows[0].created_by).toBe('importer')

    const closed = await ownerPool.query('SELECT valid_to FROM memories WHERE id = $1', [
      predecessor.id,
    ])
    expect(closed.rows[0].valid_to.toISOString()).toBe(T1)
  })

  it('inserts a fact with its bi-temporal range tied to the memory', async () => {
    const { id } = await importMemory(userA, baseInput(), { skipEmbed: true })

    const fact = await importFact(userA, {
      memoryId: id,
      subject: 'pipeline',
      predicate: 'deploys_via',
      value: 'jenkins',
      confidence: 0.8,
      validFrom: T0,
      validTo: T1,
      recordedAt: T0,
    })

    const row = await ownerPool.query(
      'SELECT memory_id, subject, predicate, value, confidence, valid_from, valid_to FROM facts WHERE id = $1',
      [fact.id],
    )
    expect(row.rows[0].memory_id).toBe(id)
    expect(row.rows[0].value).toBe('jenkins')
    expect(row.rows[0].confidence).toBeCloseTo(0.8)
    expect(row.rows[0].valid_from.toISOString()).toBe(T0)
    expect(row.rows[0].valid_to.toISOString()).toBe(T1)
  })

  it('surfaces a typed not-found for an unknown target memory', async () => {
    const ghost = '00000000-0000-7000-8000-0000000000ff'
    await expect(
      importEvent(userA, { memoryId: ghost, eventKind: 'archive' }),
    ).rejects.toBeInstanceOf(ImportTargetNotFoundError)
    await expect(
      importFact(userA, { memoryId: ghost, subject: 's', predicate: 'p', value: 'v' }),
    ).rejects.toBeInstanceOf(ImportTargetNotFoundError)
  })
})
