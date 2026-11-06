// SPDX-License-Identifier: Apache-2.0
import { memoryProvenanceSchema } from '@3ngram/schema'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { insertFactProposals } from '../../src/fact-proposals.js'
import { applyFactProposal } from '../../src/fact-proposals-apply.js'
import {
  closeDb,
  reviseMemory,
  withTenant,
  writeImportedMemory,
  writeMemory,
} from '../../src/index.js'
import { insertEdge } from '../../src/memory-edges.js'
import { getMemoriesProvenance } from '../../src/memory-provenance-read.js'
import { applyProposal } from '../../src/proposals-apply.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let a: string
let b: string
beforeEach(async () => {
  await resetDomainTables()
  a = await seedUser('provenance-read-a@test.local')
  b = await seedUser('provenance-read-b@test.local')
})
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})
const input = (userId: string) => ({
  userId,
  memoryType: 'decision' as const,
  topic: 'same topic',
  content: 'private body',
  contentHash: crypto.randomUUID(),
  scope: 'work',
  tags: [],
  actorKind: 'user_mcp' as const,
})
const read = (user: string, ids: string[]) =>
  withTenant(user, (tx) => getMemoriesProvenance(tx, user, ids))

async function run(user: string) {
  const r = await ownerPool.query(
    `INSERT INTO agent_sessions (user_id, agent, session_id, source, selector)
    VALUES ($1, 'reported-agent', $2, 'startup', '{"kind":"all"}') RETURNING id`,
    [user, crypto.randomUUID()],
  )
  return r.rows[0].id as string
}

describe('bounded provenance read', () => {
  it('returns applied proposals and only products carrying their recorded link', async () => {
    const older = await writeMemory(input(a))
    const newer = await writeMemory(input(a))
    const edge = await ownerPool.query(
      `INSERT INTO consolidation_proposals
      (user_id,from_id,to_id,edge_type,memory_type,similarity)
      VALUES ($1,$2,$3,'supersedes','decision',0.95) RETURNING id`,
      [a, newer.id, older.id],
    )
    const proposalId = edge.rows[0].id as string
    await withTenant(a, (tx) =>
      insertFactProposals(tx, [
        {
          userId: a,
          memoryId: older.id,
          subject: 'subject',
          predicate: 'predicate',
          value: 'secret value',
          memoryType: 'decision',
        },
      ]),
    )
    const fp = await ownerPool.query('SELECT id FROM fact_proposals WHERE user_id=$1', [a])
    const factProposalId = fp.rows[0].id as string
    await withTenant(a, (tx) => applyFactProposal(tx, a, factProposalId))
    await withTenant(a, (tx) => applyProposal(tx, a, proposalId, 'user_mcp'))
    const chain = memoryProvenanceSchema.parse((await read(a, [older.id])).get(older.id))
    expect(chain.proposals.items).toHaveLength(2)
    expect(chain.supersession.successors[0]?.sourceProposal).toEqual({
      proposalKind: 'edge',
      proposalId,
    })
    expect(chain.proposals.items.find((p) => p.id === proposalId)?.produced).toEqual({
      edgeIds: [chain.supersession.successors[0]?.edgeId],
      factIds: [],
      eventIds: [],
      truncated: false,
    })
    expect(chain.facts.items[0]?.sourceProposalId).toBe(factProposalId)
    expect(chain.proposals.items.find((p) => p.id === factProposalId)?.produced.factIds).toEqual([
      chain.facts.items[0]?.id,
    ])
    expect(JSON.stringify(chain)).not.toContain('secret value')
  })

  it('reads own origin separately from the event cap, without content or payload', async () => {
    const sessionRunId = await run(a)
    const m = await writeMemory({ ...input(a), sessionRunId })
    await ownerPool.query(
      `INSERT INTO memory_events (user_id,memory_id,event_kind,actor_kind,payload)
      SELECT $1,$2,'reaffirm','user_mcp','{"secret":"never return"}' FROM generate_series(1,51)`,
      [a, m.id],
    )
    const chain = (await read(a, [m.id])).get(m.id)
    expect(memoryProvenanceSchema.parse(chain)).toMatchObject({
      origin: { sessionRunId, actorKind: 'user_mcp', run: { agent: 'reported-agent' } },
      events: { truncated: true },
      facts: { items: [], truncated: false },
    })
    expect(chain?.events.items).toHaveLength(50)
    expect(JSON.stringify(chain)).not.toMatch(/private body|never return|payload|content/)
  })

  it('uses the import event as origin and never attributes imported keys', async () => {
    const sessionRunId = await run(a)
    const m = await writeImportedMemory({
      ...input(a),
      actorKind: 'importer',
      event: { payload: { sessionRunId, proposalKind: 'fact', proposalId: crypto.randomUUID() } },
    })
    const chain = (await read(a, [m.id])).get(m.id)
    expect(memoryProvenanceSchema.parse(chain).origin).toMatchObject({
      actorKind: 'importer',
      sessionRunId: null,
      run: null,
    })
    expect(chain?.events.items[0]).toMatchObject({ sessionRunId: null, sourceProposal: null })
  })

  it('bounds a long lineage and assigns each version only its own run', async () => {
    const sessionRunId = await run(a)
    const first = await writeMemory({ ...input(a), sessionRunId })
    let current = first.id
    for (let i = 0; i < 28; i++) {
      current = (
        await reviseMemory({
          ...input(a),
          sessionRunId: null,
          predecessorId: current,
          edgeType: 'updates',
        })
      ).id
    }
    const chain = memoryProvenanceSchema.parse((await read(a, [first.id, current])).get(first.id))
    expect(chain.supersession.truncated).toBe(true)
    expect(chain.supersession.successors).toHaveLength(24)
    expect(chain.supersession.predecessors).toEqual([])
    expect(chain.supersession.successors.every((r) => r.createdBySessionRunId === null)).toBe(true)
    expect(chain.origin?.sessionRunId).toBe(sessionRunId)
    expect(chain.supersession.successors.map((r) => r.depth)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    )
  })

  it('filters unknown and foreign roots even when the connection admits the foreign rows', async () => {
    const mine = await writeMemory(input(a))
    const foreign = await writeMemory(input(b))
    expect([...(await read(a, [mine.id, foreign.id, crypto.randomUUID()])).keys()]).toEqual([
      mine.id,
    ])
    expect(await withTenant(b, (tx) => getMemoriesProvenance(tx, a, [foreign.id]))).toEqual(
      new Map(),
    )
    expect((await read(b, [foreign.id])).has(foreign.id)).toBe(true)
  })

  it('does not resolve foreign or malformed event references', async () => {
    const foreignRun = await run(b)
    const mine = await writeMemory(input(a))
    await ownerPool.query(
      `UPDATE memory_events SET payload = jsonb_build_object('sessionRunId',$2::text,
      'proposalKind','fact','proposalId','not-a-uuid') WHERE memory_id=$1`,
      [mine.id, foreignRun],
    )
    const chain = memoryProvenanceSchema.parse((await read(a, [mine.id])).get(mine.id))
    expect(chain.origin).toMatchObject({ sessionRunId: null, run: null })
    expect(chain.events.items[0]).toMatchObject({ sessionRunId: null, sourceProposal: null })
    expect(JSON.stringify(chain)).not.toContain(foreignRun)
  })
})

it('preserves a spanning tree before truncating older dense cross-links', async () => {
  const root = await writeMemory(input(a))
  const near = []
  const far = []
  for (let i = 0; i < 11; i++) near.push((await writeMemory(input(a))).id)
  for (let i = 0; i < 13; i++) far.push((await writeMemory(input(a))).id)
  await withTenant(a, async (tx) => {
    const edge = (fromId: string, toId: string) =>
      insertEdge(tx, { userId: a, fromId, toId, edgeType: 'updates', createdBy: 'user_mcp' })
    for (let i = 0; i < near.length; i++)
      for (let j = i + 1; j < near.length; j++) await edge(near[i]!, near[j]!)
    for (const id of far) await edge(near[0]!, id)
    for (const id of near) await edge(root.id, id)
  })
  const chain = memoryProvenanceSchema.parse((await read(a, [root.id])).get(root.id))
  const edges = [...chain.supersession.predecessors, ...chain.supersession.successors]
  expect(chain.supersession.truncated).toBe(true)
  expect(edges).toHaveLength(50)
  const reached = new Set([root.id])
  for (let i = 0; i < 25; i++)
    for (const e of edges) {
      if (reached.has(e.fromId)) reached.add(e.toId)
      if (reached.has(e.toId)) reached.add(e.fromId)
    }
  expect([...reached].sort()).toEqual([root.id, ...near, ...far].sort())
})

it('finds a recorded resolution product after its commitment moved to a successor', async () => {
  const sessionRunId = await run(a)
  const older = await writeMemory({ ...input(a), memoryType: 'commitment' })
  const newer = await reviseMemory({
    ...input(a),
    memoryType: 'commitment',
    predecessorId: older.id,
    edgeType: 'updates',
  })
  // Acceptance may already have captured the commitment id before revise moves it.
  // Its proposal still names the older version, while the eventual event names the successor.
  const proposal = await ownerPool.query(
    `INSERT INTO resolution_proposals
    (user_id,memory_id,session_run_id,probability,status,decided_at)
    VALUES ($1,$2,$3,0.9,'applied',now()) RETURNING id`,
    [a, older.id, sessionRunId],
  )
  const proposalId = proposal.rows[0].id as string
  const event = await ownerPool.query(
    `INSERT INTO memory_events (user_id,memory_id,event_kind,actor_kind,payload)
    VALUES ($1,$2,'resolve','user_mcp',jsonb_build_object('proposalKind','resolution','proposalId',$3::text)) RETURNING id`,
    [a, newer.id, proposalId],
  )
  const chains = await read(a, [older.id, newer.id])
  expect(chains.get(older.id)?.proposals.items[0]?.produced.eventIds).toEqual([event.rows[0].id])
  expect(
    chains.get(newer.id)?.events.items.find((e) => e.id === event.rows[0].id)?.sourceProposal,
  ).toEqual({ proposalKind: 'resolution', proposalId })
})

it('caps facts, applied proposals and recorded products independently', async () => {
  const m = await writeMemory(input(a))
  await withTenant(a, (tx) =>
    insertFactProposals(
      tx,
      Array.from({ length: 26 }, (_, i) => ({
        userId: a,
        memoryId: m.id,
        subject: `subject-${i}`,
        predicate: 'fixture',
        value: 'fixture',
        memoryType: 'decision' as const,
      })),
    ),
  )
  const proposed = await ownerPool.query(
    'SELECT id FROM fact_proposals WHERE user_id=$1 ORDER BY created_at,id',
    [a],
  )
  for (const proposal of proposed.rows)
    await withTenant(a, (tx) => applyFactProposal(tx, a, proposal.id))
  const newest = proposed.rows[25]?.id as string
  // Stress the stored read contract beyond the normal one-fact acceptance cardinality.
  await ownerPool.query(
    `INSERT INTO facts (user_id,memory_id,subject,predicate,value,source_fact_proposal_id)
    SELECT $1,$2,'stress','fixture','fixture',$3 FROM generate_series(1,51)`,
    [a, m.id, newest],
  )
  const chain = memoryProvenanceSchema.parse((await read(a, [m.id])).get(m.id))
  expect(chain.facts.items).toHaveLength(25)
  expect(chain.facts.truncated).toBe(true)
  expect(chain.proposals.items).toHaveLength(25)
  expect(chain.proposals.truncated).toBe(true)
  const produced = chain.proposals.items.find((p) => p.id === newest)?.produced
  expect(produced?.factIds).toHaveLength(50)
  expect(produced?.truncated).toBe(true)
})
