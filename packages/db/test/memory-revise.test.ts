// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. carryCommitment's four-case branch matrix inside
// reviseMemory (D1, Codex P2), exercised through reviseMemory
// with withTenant + a fake tenant tx and the memory/edge helpers mocked. The
// real-RLS, end-to-end resolvability proof (cases a/d) lives in
// packages/core/test/integration/revise.int.test.ts; this isolates the branch
// decision (move / leave / nothing / auto-create) from Postgres.
//
// The carry matrix, by (predecessor has a commitments row) x (successor type):
//   (a) row + successor IS commitment      -> MOVE: UPDATE commitments memory_id
//   (b) row + successor is NON-commitment   -> RESOLVE a live (open/waiting) row
//  (Option A: status 'resolved' + 'resolve' audit event);
//       terminal rows (resolved/expired) stay put as history
//   (c) no row + non-commitment successor   -> NOTHING
//   (d) no row + successor IS commitment    -> AUTO-CREATE: INSERT commitments
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitments, memories, memoryEvents } from '../src/schema/memory.js'

// withTenant just runs the callback with our fake tx — no real connection.
const fakeTx = { kind: 'fake-tx' as const }
const withTenant = vi.fn(async (_userId: string, fn: (tx: typeof fakeTx) => Promise<unknown>) =>
  fn(fakeTx),
)
vi.mock('../src/client.js', () => ({ withTenant: (...a: unknown[]) => withTenant(...a) }))

// The successor INSERT and the typed edge are covered elsewhere; stub them so the
// only DB-shaped calls the fake tx sees are the predecessor SELECT/UPDATE, the
// audit-event INSERT, and (the unit under test) the commitments carry ops.
const insertMemoryWithEvent = vi.fn(async () => ({ id: SUCCESSOR_ID }))
vi.mock('../src/memory-write.js', () => ({
  insertMemoryWithEvent: (...a: unknown[]) => insertMemoryWithEvent(...a),
  DuplicateMemoryError: class DuplicateMemoryError extends Error {},
}))
const insertEdge = vi.fn(async () => undefined)
vi.mock('../src/memory-edges.js', () => ({
  insertEdge: (...a: unknown[]) => insertEdge(...a),
  EdgeConflictError: class EdgeConflictError extends Error {},
}))
vi.mock('../src/pg-errors.js', () => ({ isUniqueViolation: () => false }))
vi.mock('../src/session-provenance.js', () => ({
  resolveSessionProvenance: async () => undefined,
  sessionPayload: () => undefined,
  UnknownSessionRunError: class UnknownSessionRunError extends Error {
    sessionRunId: string
    constructor(sessionRunId: string) {
      super('session run is not owned by this tenant')
      this.name = 'UnknownSessionRunError'
      this.sessionRunId = sessionRunId
    }
  },
}))

const { moveMemory, reviseMemory } = await import('../src/memory-revise.js')

const USER = '00000000-0000-7000-8000-000000000001'
const PREDECESSOR_ID = '00000000-0000-7000-8000-0000000000aa'
const SUCCESSOR_ID = '00000000-0000-7000-8000-0000000000bb'
const COMMITMENT_ID = '00000000-0000-7000-8000-0000000000cc'

/**
 * Records every drizzle builder call the fake tx receives and feeds back queued
 * results per operation type. `selectResults` is a FIFO drained per `select`
 * (first the predecessor validity, then the predecessor-commitment lookup);
 * `updateReturning` feeds the predecessor-close `.returning()`.
 */
interface Recorder {
  inserts: unknown[]
  updates: unknown[]
}

function makeTx(opts: {
  predecessorLive: boolean
  predecessorHasCommitment: boolean
  /** Predecessor filing handed back by the first SELECT (issue #222). */
  predecessorProject?: string | null
  predecessorCommitmentStatus?: string
  /**
   * Simulates the TOCTOU race with sweepCommitments: the
   * demote branch SELECTed a live row, but the sweep flipped it to 'expired'
   * before the guarded UPDATE ran — so the UPDATE's liveness predicate matches
   * zero rows and `.returning()` comes back empty.
   */
  commitmentResolveLosesRace?: boolean
}): {
  tx: typeof fakeTx
  rec: Recorder
} {
  const rec: Recorder = { inserts: [], updates: [] }
  // SELECT order in reviseMemory: (1) predecessor validity, (2) predecessor commitment.
  const selectResults: unknown[][] = [
    [
      {
        validTo: opts.predecessorLive ? null : new Date(),
        scope: 'work',
        project:
          opts.predecessorProject === undefined ? 'inherited-project' : opts.predecessorProject,
        tags: ['inherited'],
      },
    ],
    opts.predecessorHasCommitment
      ? [{ id: COMMITMENT_ID, status: opts.predecessorCommitmentStatus ?? 'open' }]
      : [],
  ]

  const select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => selectResults.shift() ?? [],
      }),
    }),
  })

  const update = (table: unknown) => ({
    set: (values: unknown) => ({
      where: () => {
        rec.updates.push({ table, values })
        // The predecessor-close and demote-resolve paths await `.returning()`;
        // the carry MOVE awaits the where() result directly (drizzle's builder
        // is itself a thenable). A real Promise with `.returning` attached
        // satisfies BOTH consumers without a hand-rolled `then` (biome
        // noThenProperty). The race knob only empties the commitments UPDATE's
        // rows — the memories close must keep returning its row.
        const lostRace = opts.commitmentResolveLosesRace === true && table === commitments
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => (lostRace ? [] : [{ id: PREDECESSOR_ID }]),
        })
      },
    }),
  })

  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      rec.inserts.push({ table, values })
      return Promise.resolve(undefined)
    },
  })

  const tx = { select, update, insert } as unknown as typeof fakeTx
  return { tx, rec }
}

const baseInput = (memoryType: string) => ({
  userId: USER,
  memoryType,
  topic: 'follow up',
  content: 'do the thing',
  scope: 'work',
  tags: [],
  contentHash: 'hash',
  actorKind: 'user_mcp' as const,
  predecessorId: PREDECESSOR_ID,
  edgeType: 'supersedes' as const,
})

const commitmentUpdates = (rec: Recorder) =>
  rec.updates.filter((u) => (u as { table: unknown }).table === commitments)
const commitmentInserts = (rec: Recorder) =>
  rec.inserts.filter((i) => (i as { table: unknown }).table === commitments)

afterEach(() => {
  withTenant.mockClear()
  insertMemoryWithEvent.mockClear()
  insertEdge.mockClear()
})

describe('moveMemory (issue #233)', () => {
  const CURRENT = {
    memoryType: 'decision',
    topic: 'where it lives',
    scope: 'work',
    project: 'rdg',
    tags: ['a'],
  }
  function moveTx(current: Record<string, unknown> | undefined) {
    const rec: Recorder = { inserts: [], updates: [] }
    // Two SELECTs: the unlocked peek (awaited after limit) and the locked
    // re-read (awaited after `.for('update')`).
    const rows = async () => (current ? [current] : [])
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Object.assign(rows(), { for: rows }),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: unknown) => ({
          where: async () => {
            rec.updates.push({ table, values })
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: async (values: unknown) => {
          rec.inserts.push({ table, values })
        },
      }),
    } as unknown as typeof fakeTx
    return { tx, rec }
  }
  const base = { userId: USER, memoryId: PREDECESSOR_ID, actorKind: 'user_mcp' as const }

  it('updates only the requested filing columns and audits the change', async () => {
    const { tx, rec } = moveTx(CURRENT)
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    const out = await moveMemory({ ...base, project: 'rdg-npd' })

    expect(out).toEqual({
      id: PREDECESSOR_ID,
      memoryType: 'decision',
      topic: 'where it lives',
      scope: 'work',
      project: 'rdg-npd',
      tags: ['a'],
      changed: true,
    })
    expect(rec.updates).toHaveLength(1)
    const values = (rec.updates[0] as { values: Record<string, unknown> }).values
    expect(values).toMatchObject({ scope: 'work', project: 'rdg-npd', tags: ['a'] })
    expect(values).not.toHaveProperty('content')
    expect(values).not.toHaveProperty('validFrom')
    expect(values).not.toHaveProperty('recordedAt')
    expect(values).not.toHaveProperty('status')
    const events = rec.inserts.filter((i) => (i as { table: unknown }).table === memoryEvents)
    expect(events).toHaveLength(1)
    expect((events[0] as { values: { eventKind: string; payload: unknown } }).values).toMatchObject(
      {
        eventKind: 'revise',
        payload: {
          disposition: 'move',
          from: { scope: 'work', project: 'rdg', tagCount: 1 },
          to: { scope: 'work', project: 'rdg-npd', tagCount: 1 },
        },
      },
    )
    // Never a successor row.
    expect(insertMemoryWithEvent).not.toHaveBeenCalled()
    expect(insertEdge).not.toHaveBeenCalled()
  })

  it('is a no-op when every requested value already matches: no UPDATE, no event', async () => {
    const { tx, rec } = moveTx(CURRENT)
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    const out = await moveMemory({ ...base, project: 'rdg', tags: ['a'] })

    expect(out.changed).toBe(false)
    expect(rec.updates).toHaveLength(0)
    expect(rec.inserts).toHaveLength(0)
  })

  it('throws the typed not-found for an unknown or foreign id', async () => {
    const { tx } = moveTx(undefined)
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    await expect(moveMemory({ ...base, scope: 'personal' })).rejects.toMatchObject({
      name: 'PredecessorNotFoundError',
    })
  })
})

describe('reviseMemory filing inheritance (issue #222)', () => {
  const successorWrite = () =>
    insertMemoryWithEvent.mock.calls[0]?.[1] as {
      scope: string
      project?: string
      tags: string[]
    }

  it('copies scope, project and tags from the predecessor when omitted', async () => {
    const { tx } = makeTx({ predecessorLive: true, predecessorHasCommitment: false })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))
    const { scope: _s, tags: _t, ...bare } = baseInput('note')

    const out = await reviseMemory(bare)

    expect(successorWrite().scope).toBe('work')
    expect(successorWrite().project).toBe('inherited-project')
    expect(successorWrite().tags).toEqual(['inherited'])
    expect([out.scope, out.project, out.tags]).toEqual(['work', 'inherited-project', ['inherited']])
  })

  it('keeps a predecessor without a project project-less (no default sneaks in)', async () => {
    const { tx } = makeTx({
      predecessorLive: true,
      predecessorHasCommitment: false,
      predecessorProject: null,
    })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))
    const { scope: _s, tags: _t, ...bare } = baseInput('note')

    const out = await reviseMemory(bare)

    expect(successorWrite().project).toBeUndefined()
    expect(out.project).toBeNull()
  })

  it('lets an explicit value override the inherited one', async () => {
    const { tx } = makeTx({ predecessorLive: true, predecessorHasCommitment: false })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    const out = await reviseMemory({
      ...baseInput('note'),
      scope: 'personal',
      project: 'other',
      tags: ['x'],
    })

    expect(successorWrite().scope).toBe('personal')
    expect(successorWrite().project).toBe('other')
    expect(successorWrite().tags).toEqual(['x'])
    expect([out.scope, out.project, out.tags]).toEqual(['personal', 'other', ['x']])
  })
})

describe('reviseMemory commitment carry (four-case branch matrix)', () => {
  it('(a) MOVES the commitment row to the successor when both have/are commitment', async () => {
    const { tx, rec } = makeTx({ predecessorLive: true, predecessorHasCommitment: true })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    const out = await reviseMemory(baseInput('commitment'))
    expect(out.id).toBe(SUCCESSOR_ID)

    const moves = commitmentUpdates(rec)
    expect(moves).toHaveLength(1)
    expect((moves[0] as { values: { memoryId: string } }).values.memoryId).toBe(SUCCESSOR_ID)
    // a MOVE, never an INSERT.
    expect(commitmentInserts(rec)).toHaveLength(0)
  })

  it('(b) RESOLVES a live row when demoting commitment -> non-commitment (issue #127)', async () => {
    const { tx, rec } = makeTx({ predecessorLive: true, predecessorHasCommitment: true })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    await reviseMemory(baseInput('note'))

    // ONE commitments UPDATE: status -> 'resolved' with the DB-clock stamps
    // (never a move — memoryId stays on the predecessor), no auto-create.
    const updates = commitmentUpdates(rec)
    expect(updates).toHaveLength(1)
    const values = (updates[0] as { values: Record<string, unknown> }).values
    expect(values.status).toBe('resolved')
    expect(values.resolvedAt).toBeDefined()
    expect(values).not.toHaveProperty('memoryId')
    expect(commitmentInserts(rec)).toHaveLength(0)
    // ...plus the 'resolve' audit event on the PREDECESSOR memory (the
    // transitionCommitment pattern).
    const events = rec.inserts.filter((i) => (i as { table: unknown }).table === memoryEvents)
    const resolveEvents = events.filter(
      (e) => (e as { values: { eventKind: string } }).values.eventKind === 'resolve',
    )
    expect(resolveEvents).toHaveLength(1)
    expect((resolveEvents[0] as { values: { memoryId: string } }).values.memoryId).toBe(
      PREDECESSOR_ID,
    )
  })

  it('(b) leaves a TERMINAL row untouched on demote (expired -> resolved is illegal)', async () => {
    const { tx, rec } = makeTx({
      predecessorLive: true,
      predecessorHasCommitment: true,
      predecessorCommitmentStatus: 'expired',
    })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    await reviseMemory(baseInput('note'))

    // No live obligation to close: terminal rows stay put as history, and no
    // 'resolve' audit event is appended.
    expect(commitmentUpdates(rec)).toHaveLength(0)
    expect(commitmentInserts(rec)).toHaveLength(0)
    const events = rec.inserts.filter((i) => (i as { table: unknown }).table === memoryEvents)
    expect(
      events.filter((e) => (e as { values: { eventKind: string } }).values.eventKind === 'resolve'),
    ).toHaveLength(0)
  })

  it('(b) skips the resolve event when the sweep wins the race (guarded UPDATE hits 0 rows)', async () => {
    // TOCTOU: SELECT saw 'open', but sweepCommitments
    // expired the row before the UPDATE. The liveness predicate makes the
    // UPDATE a no-op instead of an FSM-trigger abort; no transition means no
    // 'resolve' audit event, and the revise itself still commits.
    const { tx, rec } = makeTx({
      predecessorLive: true,
      predecessorHasCommitment: true,
      commitmentResolveLosesRace: true,
    })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    const out = await reviseMemory(baseInput('note'))
    expect(out.id).toBe(SUCCESSOR_ID)

    // The guarded UPDATE was attempted (the snapshot said live)...
    expect(commitmentUpdates(rec)).toHaveLength(1)
    // ...but zero rows came back, so NO 'resolve' event is appended.
    const events = rec.inserts.filter((i) => (i as { table: unknown }).table === memoryEvents)
    expect(
      events.filter((e) => (e as { values: { eventKind: string } }).values.eventKind === 'resolve'),
    ).toHaveLength(0)
  })

  it('(c) touches no commitments when neither predecessor nor successor is a commitment', async () => {
    const { tx, rec } = makeTx({ predecessorLive: true, predecessorHasCommitment: false })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    await reviseMemory(baseInput('note'))

    expect(commitmentUpdates(rec)).toHaveLength(0)
    expect(commitmentInserts(rec)).toHaveLength(0)
  })

  it('(d) AUTO-CREATES a commitment when promoting non-commitment -> commitment', async () => {
    const { tx, rec } = makeTx({ predecessorLive: true, predecessorHasCommitment: false })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    await reviseMemory(baseInput('commitment'))

    const created = commitmentInserts(rec)
    expect(created).toHaveLength(1)
    expect((created[0] as { values: { memoryId: string; userId: string } }).values).toMatchObject({
      memoryId: SUCCESSOR_ID,
      userId: USER,
    })
    // an INSERT, never a MOVE.
    expect(commitmentUpdates(rec)).toHaveLength(0)
  })

  it('keeps the memories close UPDATE separate from any commitments carry write', async () => {
    // Guard against accidentally classifying the predecessor-close UPDATE (on
    // `memories`) as a commitments carry: case (c) must show the memories UPDATE
    // but zero commitments writes.
    const { tx, rec } = makeTx({ predecessorLive: true, predecessorHasCommitment: false })
    withTenant.mockImplementationOnce(async (_u: string, fn) => fn(tx))

    await reviseMemory(baseInput('note'))

    const memoryUpdates = rec.updates.filter((u) => (u as { table: unknown }).table === memories)
    expect(memoryUpdates).toHaveLength(1)
  })
})
