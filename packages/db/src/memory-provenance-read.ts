// SPDX-License-Identifier: Apache-2.0
import {
  MAX_PROVENANCE_EDGES,
  MAX_PROVENANCE_EVENTS,
  MAX_PROVENANCE_FACTS,
  MAX_PROVENANCE_NODES,
  MAX_PROVENANCE_PRODUCTS,
  MAX_PROVENANCE_PROPOSALS,
  type MemoryProvenance,
} from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import {
  type ProvenanceNode,
  readProvenanceEdges,
  readProvenanceNodes,
} from './memory-provenance-lineage.js'
import {
  eventsQuery,
  factsQuery,
  originQuery,
  proposalProductsQuery,
} from './memory-provenance-queries.js'

/** Raw PostgreSQL JSON timestamps need the same UTC normalization as history rows. */
function timestamps<T>(value: T): T {
  if (Array.isArray(value)) return value.map(timestamps) as T
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      item !== null &&
      ['createdAt', 'openedAt', 'recordedAt', 'decidedAt', 'validFrom', 'validTo'].includes(key)
        ? new Date(item as string).toISOString()
        : timestamps(item),
    ]),
  ) as T
}

function bounded<T>(items: T[], limit: number) {
  return { items: items.slice(0, limit), truncated: items.length > limit }
}

type SectionsRow = {
  id: string
  origin: MemoryProvenance['origin']
  events: MemoryProvenance['events']['items']
  facts: MemoryProvenance['facts']['items']
  proposals: MemoryProvenance['proposals']['items']
}

async function readSections(tx: TenantTx, userId: string, ids: string[]) {
  const result = await tx.execute(sql`
    SELECT root.id, origin.value AS origin,
      COALESCE(events.items, '[]') AS events, COALESCE(facts.items, '[]') AS facts,
      COALESCE(proposals.items, '[]') AS proposals
    FROM memories root
    LEFT JOIN LATERAL (${originQuery(userId)}) origin ON true
    CROSS JOIN LATERAL (SELECT jsonb_agg(value) AS items FROM (${eventsQuery(userId)}) q) events
    CROSS JOIN LATERAL (SELECT jsonb_agg(value) AS items FROM (${factsQuery(userId)}) q) facts
    CROSS JOIN LATERAL (SELECT jsonb_agg(value) AS items FROM (${proposalProductsQuery(userId)}) q) proposals
    WHERE root.user_id = ${userId}::uuid AND root.id = ANY(${sql.param(ids)}::uuid[])
  `)
  return timestamps(result.rows as unknown as SectionsRow[])
}

function proposalsSection(items: SectionsRow['proposals']): MemoryProvenance['proposals'] {
  const section = bounded(items, MAX_PROVENANCE_PROPOSALS)
  for (const proposal of section.items) {
    const products = proposal.produced
    products.truncated = [products.edgeIds, products.factIds, products.eventIds].some(
      (ids) => ids.length > MAX_PROVENANCE_PRODUCTS,
    )
    products.edgeIds = products.edgeIds.slice(0, MAX_PROVENANCE_PRODUCTS)
    products.factIds = products.factIds.slice(0, MAX_PROVENANCE_PRODUCTS)
    products.eventIds = products.eventIds.slice(0, MAX_PROVENANCE_PRODUCTS)
  }
  return section
}

/** Three batched statements for up to five roots, inside the caller's single tenant transaction. */
export async function getMemoriesProvenance(tx: TenantTx, userId: string, ids: string[]) {
  const sections = await readSections(tx, userId, ids)
  const nodes = await readProvenanceNodes(
    tx,
    userId,
    sections.map((r) => r.id),
  )
  const byRoot = new Map<string, ProvenanceNode[]>()
  for (const row of sections)
    byRoot.set(
      row.id,
      nodes.filter((n) => n.root_id === row.id),
    )
  const edges = await readProvenanceEdges(
    tx,
    userId,
    [...byRoot.values()].flatMap((group) => group.slice(0, MAX_PROVENANCE_NODES)),
  )
  const result = new Map<string, MemoryProvenance>()
  for (const row of sections) {
    const group = byRoot.get(row.id) ?? []
    const graphEdges = edges.filter((e) => e.root_id === row.id)
    const supersession: MemoryProvenance['supersession'] = {
      predecessors: [],
      successors: [],
      truncated: group.length > MAX_PROVENANCE_NODES || graphEdges.length > MAX_PROVENANCE_EDGES,
    }
    const identities = new Map(group.map((n) => [n.id, n]))
    for (const { edge } of graphEdges.slice(0, MAX_PROVENANCE_EDGES)) {
      const from = identities.get(edge.fromId)
      const to = identities.get(edge.toId)
      if (!from || !to) continue
      // Orient each relationship away from the root. Every bounded edge appears once,
      // including branches of the undirected history walk, without duplicating its root.
      const predecessor = to.depth >= from.depth
      const relative = predecessor ? to : from
      supersession[predecessor ? 'predecessors' : 'successors'].push({
        ...timestamps(relative.identity),
        ...edge,
      })
    }
    for (const relatives of [supersession.predecessors, supersession.successors]) {
      relatives.sort(
        (a, b) =>
          a.depth - b.depth ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id) ||
          a.edgeId.localeCompare(b.edgeId),
      )
    }
    result.set(row.id, {
      origin: row.origin,
      supersession,
      events: bounded(row.events, MAX_PROVENANCE_EVENTS),
      proposals: proposalsSection(row.proposals),
      facts: bounded(row.facts, MAX_PROVENANCE_FACTS),
    })
  }
  return result
}
