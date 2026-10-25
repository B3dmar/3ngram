// SPDX-License-Identifier: Apache-2.0
// Integration regression test for memory history: a memory that
// has been updated then superseded must surface its full lineage + audit trail
// (create/revise/supersede), not the "History unavailable" error state. Also
// guards graceful degradation, the create-only single-node case, and the
// allowlisted session-provenance fields (issue #262) — runtime role, so every
// tenant assertion is an RLS assertion.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  appendImportedEvent,
  closeDb,
  eraseAccountData,
  getMemoryHistory,
  MEMORY_HISTORY_EVENT_LIMIT,
  reviseMemory,
  UnknownSessionRunError,
  withTenant,
  writeImportedMemory,
  writeMemory,
} from '../../src/index.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userId: string

beforeAll(async () => {
  userId = await seedUser('memory-history-366@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

async function buildUpdateSupersedeLineage(): Promise<{ idA: string; idB: string; idC: string }> {
  const a = await writeMemory({
    userId,
    memoryType: 'note',
    topic: 'lineage topic',
    content: 'version A',
    scope: 'work',
    project: '3ngram',
    tags: [],
    contentHash: 'hash-a-366',
    actorKind: 'user_api',
  })
  const b = await reviseMemory({
    userId,
    memoryType: 'note',
    topic: 'lineage topic',
    content: 'version B',
    scope: 'work',
    project: '3ngram',
    tags: [],
    contentHash: 'hash-b-366',
    actorKind: 'user_api',
    predecessorId: a.id,
    edgeType: 'updates',
  })
  const c = await reviseMemory({
    userId,
    memoryType: 'note',
    topic: 'lineage topic',
    content: 'version C',
    scope: 'work',
    project: '3ngram',
    tags: [],
    contentHash: 'hash-c-366',
    actorKind: 'user_api',
    predecessorId: b.id,
    edgeType: 'supersedes',
  })
  return { idA: a.id, idB: b.id, idC: c.id }
}

describe('memory history after update + supersede (#366)', () => {
  it('returns full lineage + edges for the current memory (no error state)', async () => {
    const { idA, idB, idC } = await buildUpdateSupersedeLineage()

    const history = await withTenant(userId, (tx) => getMemoryHistory(tx, idC))
    expect(history).toBeDefined()
    if (!history) throw new Error('history undefined')

    const nodeIds = history.lineage.nodes.map((n) => n.id).sort()
    expect(nodeIds).toEqual([idA, idB, idC].sort())

    const edgeKinds = history.lineage.edges
      .map((e) => `${e.fromId}->${e.toId}:${e.edgeType}`)
      .sort()
    expect(edgeKinds).toEqual([`${idB}->${idA}:updates`, `${idC}->${idB}:supersedes`].sort())
  })

  it('returns the audit trail for a superseded version (create + supersede)', async () => {
    const { idA } = await buildUpdateSupersedeLineage()

    const history = await withTenant(userId, (tx) => getMemoryHistory(tx, idA))
    expect(history).toBeDefined()
    if (!history) throw new Error('history undefined')

    const kinds = history.auditEvents.map((e) => e.eventKind).sort()
    // Exactly create + supersede for A — no fabricated events.
    expect(kinds).toEqual(['create', 'supersede'])
  })

  it('renders a coherent single-node lineage for a create-only memory (FR-004)', async () => {
    const a = await writeMemory({
      userId,
      memoryType: 'note',
      topic: 'solo',
      content: 'only version',
      scope: 'work',
      project: '3ngram',
      tags: [],
      contentHash: 'hash-solo-366',
      actorKind: 'user_api',
    })

    const history = await withTenant(userId, (tx) => getMemoryHistory(tx, a.id))
    expect(history).toBeDefined()
    if (!history) throw new Error('history undefined')

    expect(history.lineage.nodes.map((n) => n.id)).toEqual([a.id])
    expect(history.auditEvents.map((e) => e.eventKind)).toEqual(['create'])
    // Full success → both sections ok.
    expect(history.sections).toEqual({ lineage: 'ok', events: 'ok' })
  })
})

// Deep-walk a drizzle SQL object's static fragments for a table marker. Only
// `readAuditEvents` references `memory_events` (the lineage reads use
// `memory_edges`/`memories`), so this uniquely targets the events query.
function queryMentions(query: unknown, marker: string): boolean {
  const seen = new Set<unknown>()
  const stack: unknown[] = [query]
  while (stack.length > 0) {
    const current = stack.pop()
    if (typeof current === 'string') {
      if (current.includes(marker)) return true
      continue
    }
    if (current !== null && typeof current === 'object') {
      if (seen.has(current)) continue
      seen.add(current)
      for (const value of Object.values(current)) stack.push(value)
    }
  }
  return false
}

/**
 * Wrap a tx so any execute() touching `marker` is replaced with a query that
 * raises a REAL Postgres error, aborting the surrounding transaction. This is
 * stronger than throwing a JS error: it reproduces the transaction-poisoning
 * scenario the per-section savepoints must isolate. Only `readAuditEvents` uses
 * `memory_events`; only the lineage group uses `memory_edges`; `readInspectedMemory`
 * uses `memories` alone — so each marker targets exactly one section.
 */
function failReadsTouching<T extends { execute: (q: unknown) => unknown }>(
  tx: T,
  marker: string,
): T {
  const execute = tx.execute.bind(tx)
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (query: unknown) => {
          if (queryMentions(query, marker)) {
            return execute(sql`SELECT * FROM __history_fault_injection__`)
          }
          return execute(query)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as T
}

describe('memory history graceful degradation (FR-003a)', () => {
  it('returns lineage with sections.events = unavailable when the events read fails', async () => {
    const { idA, idB, idC } = await buildUpdateSupersedeLineage()

    const history = await withTenant(userId, (tx) =>
      getMemoryHistory(failReadsTouching(tx as never, 'memory_events'), idC),
    )
    expect(history).toBeDefined()
    if (!history) throw new Error('history undefined')

    // Events degraded; lineage still fully assembled — not the unavailable state.
    expect(history.sections).toEqual({ lineage: 'ok', events: 'unavailable' })
    expect(history.auditEvents).toEqual([])
    expect(history.eventsTruncated).toBe(false)
    expect(history.sectionErrors?.events).toBeDefined()

    const nodeIds = history.lineage.nodes.map((n) => n.id).sort()
    expect(nodeIds).toEqual([idA, idB, idC].sort())
    expect(history.lineage.edges.length).toBe(2)
  })

  it('returns events with sections.lineage = unavailable when the lineage read aborts the tx', async () => {
    // The lineage group fails FIRST and raises a real Postgres error. Without
    // per-section savepoints this would poison the events read on the same tx and
    // surface BOTH sections as unavailable — the regression Codex flagged.
    const { idA } = await buildUpdateSupersedeLineage()

    const history = await withTenant(userId, (tx) =>
      getMemoryHistory(failReadsTouching(tx as never, 'memory_edges'), idA),
    )
    expect(history).toBeDefined()
    if (!history) throw new Error('history undefined')

    // Lineage degraded but events survived the lineage failure (savepoint isolation).
    expect(history.sections).toEqual({ lineage: 'unavailable', events: 'ok' })
    expect(history.lineage.nodes).toEqual([])
    expect(history.lineage.edges).toEqual([])
    expect(history.directRelationships.predecessors).toEqual([])
    expect(history.directRelationships.successors).toEqual([])
    expect(history.sectionErrors?.lineage).toBeDefined()
    // Audit trail for A is still fully read: create + supersede, no fabrication.
    expect(history.auditEvents.map((e) => e.eventKind).sort()).toEqual(['create', 'supersede'])
  })
})

// ---------------------------------------------------------------------------
// Issue #262 — the creating session run on the history read. Events come from
// the REAL write path (provenance stamped by resolveSessionProvenance); only
// the corrupt/legacy shapes the write path cannot produce are seeded through
// the owner connection.
// ---------------------------------------------------------------------------

const RUN_A = '01890b6e-0000-7000-8000-0000000262aa'
const RUN_B = '01890b6e-0000-7000-8000-0000000262bb'
const RUN_OTHER_TENANT = '01890b6e-0000-7000-8000-0000000262cc'
const NOW_262 = new Date('2026-10-01T12:00:00.000Z')
let hash262 = 0
const nextHash262 = () => `hash-262-${Date.now()}-${hash262++}`

async function seedRun(owner: string, id: string, project: string): Promise<void> {
  await ownerPool.query(
    `INSERT INTO agent_sessions
       (id, user_id, agent, session_id, source, project, selector, last_seen_at, closed_at, activation_epoch)
     VALUES ($1, $2, 'codex', $3, 'startup', $4, '{"kind":"all"}'::jsonb, $5, NULL, 1)`,
    [id, owner, `sess-${id.slice(-4)}`, project, NOW_262],
  )
}

function noteWrite(owner: string, project: string, sessionRunId?: string) {
  return {
    userId: owner,
    memoryType: 'note' as const,
    topic: 'provenance 262',
    content: `body-${nextHash262()}`,
    scope: 'work',
    project,
    tags: [],
    contentHash: nextHash262(),
    actorKind: 'user_mcp' as const,
    now: NOW_262,
    ...(sessionRunId === undefined ? {} : { sessionRunId }),
  }
}

async function historyOf(owner: string, memoryId: string) {
  const history = await withTenant(owner, (tx) => getMemoryHistory(tx, memoryId))
  if (!history) throw new Error(`history of ${memoryId} undefined`)
  return history
}

function eventsByKind(history: Awaited<ReturnType<typeof historyOf>>) {
  return Object.fromEntries(history.auditEvents.map((e) => [e.eventKind, e]))
}

describe('memory history session provenance (#262)', () => {
  // Two leased-open runs on the project, so the single-open-session floor
  // never attaches a write that omitted the id: "without provenance" stays so.
  beforeEach(async () => {
    await seedRun(userId, RUN_A, '3ngram')
    await seedRun(userId, RUN_B, '3ngram')
  })

  it('reports the creating run on the create event and as createdBySessionRunId', async () => {
    const m = await writeMemory(noteWrite(userId, '3ngram', RUN_A))
    const history = await historyOf(userId, m.id)
    expect(history.auditEvents.map((e) => [e.eventKind, e.sessionRunId])).toEqual([
      ['create', RUN_A],
    ])
    expect(history.createdBySessionRunId).toBe(RUN_A)
    // payloadMetadata keeps describing the whole stored payload.
    expect(history.auditEvents[0]?.payloadMetadata).toMatchObject({
      present: true,
      jsonType: 'object',
    })
  })

  it('reports null for a create written without provenance (never inferred)', async () => {
    const m = await writeMemory(noteWrite(userId, '3ngram'))
    const history = await historyOf(userId, m.id)
    expect(history.auditEvents.map((e) => [e.eventKind, e.sessionRunId])).toEqual([
      ['create', null],
    ])
    expect(history.auditEvents[0]?.payloadMetadata).toEqual({
      present: false,
      jsonType: null,
      byteLength: 0,
    })
    expect(history.createdBySessionRunId).toBeNull()
  })

  it('reports null for an imported memory and its imported create event', async () => {
    const m = await writeImportedMemory({
      ...noteWrite(userId, '3ngram'),
      actorKind: 'importer',
      event: { payload: { source: 'legacy', sourceId: 'abc-1' } },
    })
    await appendImportedEvent({
      userId,
      memoryId: m.id,
      eventKind: 'create',
      actorKind: 'importer',
      payload: { source: 'legacy' },
    })
    const history = await historyOf(userId, m.id)
    expect(history.auditEvents.map((e) => [e.eventKind, e.sessionRunId]).sort()).toEqual([
      ['create', null],
      ['import', null],
    ])
    expect(history.createdBySessionRunId).toBeNull()
  })

  it('reports each version of a revision chain with its OWN creating run', async () => {
    const a = await writeMemory(noteWrite(userId, '3ngram', RUN_A))
    const b = await reviseMemory({
      ...noteWrite(userId, '3ngram', RUN_B),
      predecessorId: a.id,
      edgeType: 'supersedes',
    })
    const c = await reviseMemory({
      ...noteWrite(userId, '3ngram'),
      predecessorId: b.id,
      edgeType: 'updates',
    })

    const ha = await historyOf(userId, a.id)
    expect(ha.createdBySessionRunId).toBe(RUN_A)
    // The predecessor's supersede is stamped with the RUN THAT REVISED it.
    expect(eventsByKind(ha).supersede?.sessionRunId).toBe(RUN_B)
    expect(eventsByKind(ha).create?.sessionRunId).toBe(RUN_A)

    const hb = await historyOf(userId, b.id)
    expect(hb.createdBySessionRunId).toBe(RUN_B)
    expect(eventsByKind(hb).supersede?.sessionRunId).toBeNull()

    // C was written without a run: null, not inherited from B or A.
    const hc = await historyOf(userId, c.id)
    expect(hc.createdBySessionRunId).toBeNull()
    expect(hc.auditEvents.map((e) => [e.eventKind, e.sessionRunId])).toEqual([['create', null]])
  })

  it('finds the create even when it has fallen out of the bounded events window', async () => {
    const m = await writeMemory(noteWrite(userId, '3ngram', RUN_A))
    await ownerPool.query(
      `INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, created_at)
       SELECT $1, $2, 'revise', 'user_api', c.created_at + make_interval(secs => g)
       FROM generate_series(1, $3::int) g,
            (SELECT created_at FROM memory_events WHERE memory_id = $2 AND event_kind = 'create') c`,
      [userId, m.id, MEMORY_HISTORY_EVENT_LIMIT + 1],
    )
    const history = await historyOf(userId, m.id)
    expect(history.eventsTruncated).toBe(true)
    expect(history.auditEvents.some((e) => e.eventKind === 'create')).toBe(false)
    expect(history.createdBySessionRunId).toBe(RUN_A)
  })

  it('returns the recorded id as stored after the session row is gone or the account erased', async () => {
    const m = await writeMemory(noteWrite(userId, '3ngram', RUN_A))
    // Unavailable: no agent_sessions join validates the id — it is reported as
    // recorded (an id, not content).
    await ownerPool.query('DELETE FROM agent_sessions WHERE id = $1', [RUN_A])
    expect((await historyOf(userId, m.id)).createdBySessionRunId).toBe(RUN_A)

    // Erased: account erasure redacts in place and cannot reach
    // memory_events.payload (INSERT/SELECT-only grant), so the id survives.
    const erased = await seedUser(`history-262-erase-${crypto.randomUUID()}@test.local`)
    await seedRun(erased, RUN_OTHER_TENANT, 'erase')
    const e = await writeMemory(noteWrite(erased, 'erase', RUN_OTHER_TENANT))
    await withTenant(erased, (tx) => eraseAccountData(tx, erased, NOW_262))
    const he = await historyOf(erased, e.id)
    expect(he.createdBySessionRunId).toBe(RUN_OTHER_TENANT)
  })

  it("keeps another tenant's history and run ids out of reach (RLS + write path)", async () => {
    const other = await seedUser('history-262-other@test.local')
    await seedRun(other, RUN_OTHER_TENANT, '3ngram')
    const mine = await writeMemory(noteWrite(userId, '3ngram', RUN_A))
    const theirs = await writeMemory(noteWrite(other, '3ngram', RUN_OTHER_TENANT))

    // RLS: neither tenant can read the other's history (absent -> undefined).
    expect(await withTenant(other, (tx) => getMemoryHistory(tx, mine.id))).toBeUndefined()
    expect(await withTenant(userId, (tx) => getMemoryHistory(tx, theirs.id))).toBeUndefined()
    // Each tenant sees only its own run on its own memory.
    expect((await historyOf(other, theirs.id)).createdBySessionRunId).toBe(RUN_OTHER_TENANT)
    // The write path cannot stamp another tenant's run id on my memory.
    await expect(writeMemory(noteWrite(userId, '3ngram', RUN_OTHER_TENANT))).rejects.toBeInstanceOf(
      UnknownSessionRunError,
    )
  })

  it('reports a malformed stored value as null and never passes other keys through', async () => {
    const m = await writeMemory(noteWrite(userId, '3ngram', RUN_A))
    // Corrupt/legacy shapes the native write path cannot produce: seeded via owner.
    await ownerPool.query(
      `UPDATE memory_events
          SET payload = '{"sessionRunId":"not-a-run-id","note":"secret-262-text"}'::jsonb
        WHERE memory_id = $1 AND event_kind = 'create'`,
      [m.id],
    )
    await ownerPool.query(
      `INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload, created_at)
       VALUES ($1, $2, 'revise', 'user_api', '{"sessionRunId":42}'::jsonb, now() + interval '1 second'),
              ($1, $2, 'archive', 'user_api', '"bare-string"'::jsonb, now() + interval '2 seconds')`,
      [userId, m.id],
    )
    const history = await historyOf(userId, m.id)
    expect(history.auditEvents.map((e) => e.sessionRunId)).toEqual([null, null, null])
    expect(history.createdBySessionRunId).toBeNull()
    const create = eventsByKind(history).create
    expect(create?.payloadMetadata.present).toBe(true)
    expect(create?.payloadMetadata.byteLength).toBeGreaterThan(0)
    expect(JSON.stringify(history)).not.toContain('secret-262-text')
    expect(JSON.stringify(history)).not.toContain('not-a-run-id')
  })

  it('canonicalizes a stored uppercase id to the lowercase spelling', async () => {
    const m = await writeMemory(noteWrite(userId, '3ngram'))
    await ownerPool.query(
      `UPDATE memory_events SET payload = jsonb_build_object('sessionRunId', $2::text)
        WHERE memory_id = $1 AND event_kind = 'create'`,
      [m.id, RUN_A.toUpperCase()],
    )
    const history = await historyOf(userId, m.id)
    expect(history.createdBySessionRunId).toBe(RUN_A)
    expect(history.auditEvents[0]?.sessionRunId).toBe(RUN_A)
  })
})
