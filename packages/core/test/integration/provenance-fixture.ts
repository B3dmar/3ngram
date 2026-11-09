// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import {
  insertFactProposals,
  insertProposals,
  insertResolutionProposals,
  insertRetentionProposals,
  withTenant,
} from '@3ngram/db'
import type { MemoryProvenance, MemoryType } from '@3ngram/schema'
import { ownerPool, seedUser } from '../../../db/test/integration/helpers.js'
import { acceptProposalAnyKind } from '../../src/admin/proposals.js'
import { openAgentSession } from '../../src/session/lifecycle.js'
import { remember } from '../../src/write/remember.js'
import { revise } from '../../src/write/revise.js'
import { reviseDisposition } from '../../src/write/revise-disposition.js'

type Kind = 'edge' | 'fact' | 'resolution' | 'retention'
interface Proposal {
  kind: Kind
  label: string
  memory: string
  relatedMemory?: string
}
interface Fixture {
  _meta: {
    targets: {
      provenance_chain_recall: number
      provenance_chain_precision: number
      provenance_foreign_ids: number
    }
  }
  tenants: string[]
  project: string
  chain: { label: string; versions: number }
  memories: { label: string; memoryType: MemoryType }[]
  filing: { memory: string; steps: ('move' | 'reaffirm' | 'archive')[]; destinationProject: string }
  proposals: Proposal[]
  probes: {
    memory: string
    expected: Record<keyof MemoryProvenance, string[]>
    lineageTruncated: boolean
  }[]
}
export const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../eval/fixtures/provenance-synthetic.json', import.meta.url),
    'utf8',
  ),
) as Fixture
export interface Seed {
  userId: string
  prefix: string
  labels: Map<string, string>
}
export function id(seed: Seed, label: string): string {
  const value = seed.labels.get(`${seed.prefix}.${label}`)
  if (!value) throw new Error(`fixture label missing: ${seed.prefix}.${label}`)
  return value
}
function label(seed: Seed, name: string, value: string) {
  const key = `${seed.prefix}.${name}`
  if (seed.labels.has(key)) throw new Error(`duplicate fixture label: ${key}`)
  seed.labels.set(key, value)
}
const ACTOR = 'user_mcp'
const TABLES = {
  edge: 'consolidation_proposals',
  fact: 'fact_proposals',
  resolution: 'resolution_proposals',
  retention: 'retention_proposals',
} as const

async function seedProposal(seed: Seed, p: Proposal) {
  const memoryId = id(seed, p.memory)
  await withTenant(seed.userId, async (tx) => {
    if (p.kind === 'edge')
      await insertProposals(tx, [
        {
          userId: seed.userId,
          fromId: id(seed, p.relatedMemory ?? ''),
          toId: memoryId,
          edgeType: 'supersedes',
          memoryType: 'decision',
          similarity: 0.95,
        },
      ])
    if (p.kind === 'fact')
      await insertFactProposals(tx, [
        {
          userId: seed.userId,
          memoryId,
          subject: 'fixture',
          predicate: 'outcome',
          value: 'synthetic',
          memoryType: 'decision',
        },
      ])
    if (p.kind === 'resolution')
      await insertResolutionProposals(tx, seed.userId, id(seed, 'run'), [
        { memoryId, probability: 0.8 },
      ])
    if (p.kind === 'retention')
      await insertRetentionProposals(tx, seed.userId, [
        {
          memoryId,
          action: 'archive',
          probability: 0.95,
          probabilities: { archive: 0.95, keep: 0.05 },
          model: 'synthetic-fixture',
        },
      ])
  })
  const rows = await ownerPool.query<{ id: string }>(
    `SELECT id FROM ${TABLES[p.kind]} WHERE user_id=$1 AND status='proposed'`,
    [seed.userId],
  )
  const proposed = rows.rows[0]
  if (rows.rows.length !== 1 || !proposed) throw new Error('expected one staged fixture proposal')
  label(seed, p.label, proposed.id)
  await acceptProposalAnyKind(seed.userId, proposed.id, ACTOR)
}

/** Map stored identities, never producer references or provenance output, to fixture labels. */
async function captureProducts(seed: Seed) {
  const names = new Map(
    [...seed.labels].map(([name, value]) => [value, name.slice(seed.prefix.length + 1)]),
  )
  const events = await ownerPool.query<{ id: string; memory_id: string; event_kind: string }>(
    'SELECT id,memory_id,event_kind FROM memory_events WHERE user_id=$1',
    [seed.userId],
  )
  for (const event of events.rows)
    label(seed, `${names.get(event.memory_id)}.${event.event_kind}`, event.id)
  const edges = await ownerPool.query<{ id: string; from_id: string }>(
    'SELECT id,from_id FROM memory_edges WHERE user_id=$1',
    [seed.userId],
  )
  for (const edge of edges.rows) label(seed, `${names.get(edge.from_id)}.edge`, edge.id)
  const facts = await ownerPool.query<{ id: string; memory_id: string }>(
    'SELECT id,memory_id FROM facts WHERE user_id=$1',
    [seed.userId],
  )
  for (const fact of facts.rows) label(seed, `${names.get(fact.memory_id)}.fact`, fact.id)
}

export async function seedFixture(prefix: string): Promise<Seed> {
  const seed: Seed = {
    userId: await seedUser(`provenance-synthetic-${prefix}@test.local`),
    prefix,
    labels: new Map(),
  }
  const session = await openAgentSession(seed.userId, {
    agent: 'synthetic-fixture',
    sessionId: `run-${prefix}-${crypto.randomUUID()}`,
    source: 'startup',
    project: fixture.project,
  })
  label(seed, 'run', session.row.id)
  const base = { scope: 'work', project: fixture.project, sessionRunId: session.row.id }
  for (const m of fixture.memories) {
    const row = await remember(
      seed.userId,
      {
        ...base,
        memoryType: m.memoryType,
        topic: `Synthetic ${m.label}`,
        content: `Synthetic body ${m.label}`,
      },
      ACTOR,
    )
    label(seed, m.label, row.id)
  }
  let previous: string | undefined
  for (let v = 0; v < fixture.chain.versions; v++) {
    const name = `${fixture.chain.label}.v${v}`
    const input = {
      ...base,
      memoryType: 'decision',
      topic: 'Synthetic revision chain',
      content: `Synthetic revision ${v}`,
    }
    const row = previous
      ? await revise(
          seed.userId,
          { ...input, predecessorId: previous, edgeIntent: 'updates' },
          ACTOR,
        )
      : await remember(seed.userId, input, ACTOR)
    label(seed, name, row.id)
    previous = row.id
  }
  for (const step of fixture.filing.steps) {
    const memoryId = id(seed, fixture.filing.memory)
    if (step === 'move')
      await revise(
        seed.userId,
        {
          kind: 'move',
          predecessorId: memoryId,
          project: fixture.filing.destinationProject,
          sessionRunId: session.row.id,
        },
        ACTOR,
      )
    else
      await reviseDisposition(
        seed.userId,
        { kind: step, memoryIds: [memoryId], sessionRunId: session.row.id },
        ACTOR,
      )
  }
  for (const p of fixture.proposals) await seedProposal(seed, p)
  await captureProducts(seed)
  return seed
}
