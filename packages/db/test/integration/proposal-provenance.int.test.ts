// SPDX-License-Identifier: Apache-2.0
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { readUserDataExport } from '../../src/data-export.js'
import { insertFactProposals } from '../../src/fact-proposals.js'
import { insertFact } from '../../src/facts-write.js'
import { insertEdge } from '../../src/memory-edges.js'
import { getMemoryHistory } from '../../src/memory-history-read.js'
import { writeMemory } from '../../src/memory-write.js'
import { applyProposal } from '../../src/proposals-apply.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string
let userB: string
beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`provenance-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`provenance-b-${crypto.randomUUID()}@test.local`)
})
afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

const memory = (userId: string) =>
  writeMemory({
    userId,
    memoryType: 'decision',
    topic: 'fixture',
    content: 'fixture',
    contentHash: crypto.randomUUID(),
    scope: 'work',
    tags: [],
    actorKind: 'user_mcp',
  })

async function edgeProposal(userId: string, from: string, to: string) {
  const r = await ownerPool.query(
    `INSERT INTO consolidation_proposals
    (user_id, from_id, to_id, edge_type, memory_type, similarity)
    VALUES ($1, $2, $3, 'supersedes', 'decision', 0.95) RETURNING id`,
    [userId, from, to],
  )
  return r.rows[0].id as string
}

describe('recorded proposal producers', () => {
  it('records an edge producer and disambiguates its resolve event', async () => {
    const older = await memory(userA)
    const newer = await memory(userA)
    // A commitment can ride a formerly-commitment memory. The accept must
    // resolve it when the successor cannot carry that obligation.
    await ownerPool.query('INSERT INTO commitments (user_id, memory_id) VALUES ($1, $2)', [
      userA,
      older.id,
    ])
    const id = await edgeProposal(userA, newer.id, older.id)
    await withTenant(userA, (tx) => applyProposal(tx, userA, id, 'user_mcp'))
    const edge = await ownerPool.query(
      'SELECT source_consolidation_proposal_id, source_retention_proposal_id FROM memory_edges WHERE from_id = $1',
      [newer.id],
    )
    expect(edge.rows).toEqual([
      { source_consolidation_proposal_id: id, source_retention_proposal_id: null },
    ])
    const exported = await withTenant(userA, (tx) => readUserDataExport(tx, userA))
    expect(exported?.edges).toEqual([
      expect.objectContaining({
        sourceConsolidationProposalId: id,
        sourceRetentionProposalId: null,
      }),
    ])
    const history = await withTenant(userA, (tx) => getMemoryHistory(tx, userA, older.id))
    expect(history?.auditEvents.find((e) => e.eventKind === 'resolve')?.sourceProposal).toEqual({
      proposalKind: 'edge',
      proposalId: id,
    })
  })

  it('does not claim a pre-existing edge as its own product', async () => {
    const older = await memory(userA)
    const newer = await memory(userA)
    await withTenant(userA, (tx) =>
      insertEdge(tx, {
        userId: userA,
        fromId: newer.id,
        toId: older.id,
        edgeType: 'supersedes',
        createdBy: 'user_mcp',
      }),
    )
    const id = await edgeProposal(userA, newer.id, older.id)
    await withTenant(userA, (tx) => applyProposal(tx, userA, id, 'user_mcp'))
    const edge = await ownerPool.query(
      'SELECT source_consolidation_proposal_id FROM memory_edges WHERE from_id = $1',
      [newer.id],
    )
    expect(edge.rows).toEqual([{ source_consolidation_proposal_id: null }])
    expect(
      (await withTenant(userA, (tx) => getMemoryHistory(tx, userA, older.id)))?.auditEvents,
    ).toHaveLength(1)
  })

  it('rejects a fact linked to another tenant’s proposal', async () => {
    const a = await memory(userA)
    const b = await memory(userB)
    await withTenant(userB, (tx) =>
      insertFactProposals(tx, [
        {
          userId: userB,
          memoryId: b.id,
          subject: 'fixture',
          predicate: 'value',
          value: '1',
          memoryType: 'decision',
        },
      ]),
    )
    const r = await ownerPool.query('SELECT id FROM fact_proposals WHERE user_id = $1', [userB])
    await expect(
      withTenant(userA, (tx) =>
        insertFact(tx, {
          userId: userA,
          memoryId: a.id,
          subject: 'fixture',
          predicate: 'value',
          value: '1',
          sourceFactProposalId: r.rows[0].id,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } })
  })

  it.each([
    'consolidation',
    'retention',
  ])('rejects an edge linked to another tenant’s %s proposal', async (kind) => {
    const a = await memory(userA)
    const b = await memory(userA)
    const foreign = await memory(userB)
    const foreignNewer = await memory(userB)
    const id =
      kind === 'consolidation'
        ? await edgeProposal(userB, foreignNewer.id, foreign.id)
        : (
            await ownerPool.query(
              `INSERT INTO retention_proposals (user_id, memory_id, action, probability, probabilities, model)
          VALUES ($1, $2, 'archive', 0.9, '{}', 'test') RETURNING id`,
              [userB, foreign.id],
            )
          ).rows[0].id
    await expect(
      withTenant(userA, (tx) =>
        insertEdge(tx, {
          userId: userA,
          fromId: a.id,
          toId: b.id,
          edgeType: 'extends',
          createdBy: 'user_mcp',
          ...(kind === 'consolidation'
            ? { sourceConsolidationProposalId: id }
            : { sourceRetentionProposalId: id }),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } })
  })

  it('rejects two producers on the same edge', async () => {
    const a = await memory(userA)
    const b = await memory(userA)
    await expect(
      withTenant(userA, (tx) =>
        insertEdge(tx, {
          userId: userA,
          fromId: a.id,
          toId: b.id,
          edgeType: 'extends',
          createdBy: 'user_mcp',
          sourceConsolidationProposalId: crypto.randomUUID(),
          sourceRetentionProposalId: crypto.randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
  })

  it('does not promote historical imported payloads to native producer references', async () => {
    const a = await memory(userA)
    const payload = JSON.stringify({ proposalKind: 'resolution', proposalId: crypto.randomUUID() })
    await withTenant(userA, (tx) =>
      tx.execute(sql`INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload)
      VALUES (${userA}, ${a.id}, 'resolve', 'importer', ${payload}::jsonb)`),
    )
    const history = await withTenant(userA, (tx) => getMemoryHistory(tx, userA, a.id))
    expect(history?.auditEvents.find((e) => e.actorKind === 'importer')?.sourceProposal).toBeNull()
  })

  it('allowlists only a complete valid proposal reference from event payloads', async () => {
    const a = await memory(userA)
    await withTenant(userA, (tx) =>
      tx.execute(sql`INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload)
      VALUES (${userA}, ${a.id}, 'resolve', 'user_mcp', '{"proposalKind":"secret","proposalId":"text","content":"hidden"}')`),
    )
    const history = await withTenant(userA, (tx) => getMemoryHistory(tx, userA, a.id))
    expect(history?.auditEvents.every((e) => e.sourceProposal === null)).toBe(true)
    expect(JSON.stringify(history)).not.toContain('hidden')
  })
})
