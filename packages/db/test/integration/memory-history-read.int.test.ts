// SPDX-License-Identifier: Apache-2.0
// Integration regression test for memory history: a memory that
// has been updated then superseded must surface its full lineage + audit trail
// (create/revise/supersede), not the "History unavailable" error state. Also
// guards graceful degradation and the create-only single-node case.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closeDb,
  getMemoryHistory,
  reviseMemory,
  withTenant,
  writeMemory,
} from '../../src/index.js'
import { closePools, resetDomainTables, seedUser } from './helpers.js'

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
