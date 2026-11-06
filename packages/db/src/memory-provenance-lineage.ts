// SPDX-License-Identifier: Apache-2.0
import { MAX_PROVENANCE_EDGES, MAX_PROVENANCE_NODES, type MemoryProvenance } from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { eventUuid } from './memory-provenance-queries.js'

export interface ProvenanceNode {
  root_id: string
  id: string
  depth: number
  identity: Omit<
    MemoryProvenance['supersession']['predecessors'][number],
    'edgeId' | 'fromId' | 'toId' | 'edgeType' | 'createdBy' | 'sourceProposal'
  >
}

export async function readProvenanceNodes(tx: TenantTx, userId: string, ids: string[]) {
  const result = await tx.execute(sql`
    WITH RECURSIVE walk(root_id, id, depth) AS (
      SELECT id, id, 0 FROM memories WHERE user_id = ${userId}::uuid AND id = ANY(${sql.param(ids)}::uuid[])
      UNION
      SELECT walk.root_id, next.id, walk.depth + 1 FROM walk
      JOIN memory_edges e ON e.user_id = ${userId}::uuid
        AND e.edge_type IN ('supersedes', 'updates') AND (e.from_id = walk.id OR e.to_id = walk.id)
      JOIN memories next ON next.user_id = ${userId}::uuid
        AND next.id = CASE WHEN e.from_id = walk.id THEN e.to_id ELSE e.from_id END
      WHERE walk.depth < ${MAX_PROVENANCE_NODES}
    ), nearest AS (
      SELECT root_id, id, min(depth) AS depth FROM walk GROUP BY root_id, id
    ), ranked AS (
      SELECT n.*, row_number() OVER (PARTITION BY root_id ORDER BY depth, m.created_at, n.id) AS rank
      FROM nearest n JOIN memories m ON m.user_id = ${userId}::uuid AND m.id = n.id
    )
    SELECT r.root_id, r.id, r.depth, jsonb_build_object(
      'id', m.id, 'memoryType', m.memory_type, 'topic', m.topic, 'scope', m.scope, 'project', m.project,
      'status', m.status, 'validFrom', m.valid_from, 'validTo', m.valid_to,
      'recordedAt', m.recorded_at, 'createdAt', m.created_at, 'depth', r.depth,
      'createdBySessionRunId', origin.session_run_id
    ) AS identity FROM ranked r
    JOIN memories m ON m.user_id = ${userId}::uuid AND m.id = r.id
    LEFT JOIN LATERAL (
      SELECT s.id AS session_run_id FROM memory_events e
      LEFT JOIN agent_sessions s ON s.user_id = ${userId}::uuid AND s.id = ${eventUuid('sessionRunId')}
      WHERE e.user_id = ${userId}::uuid AND e.memory_id = m.id AND e.event_kind = 'create'
        AND e.actor_kind <> 'importer'
      ORDER BY e.created_at, e.id LIMIT 1
    ) origin ON true
    WHERE r.rank <= ${MAX_PROVENANCE_NODES + 1} ORDER BY r.root_id, r.rank
  `)
  return result.rows as unknown as ProvenanceNode[]
}

interface ProvenanceEdge {
  root_id: string
  edge: Pick<
    MemoryProvenance['supersession']['predecessors'][number],
    'edgeId' | 'fromId' | 'toId' | 'edgeType' | 'createdBy' | 'sourceProposal'
  >
}

export async function readProvenanceEdges(tx: TenantTx, userId: string, nodes: ProvenanceNode[]) {
  if (nodes.length === 0) return []
  const input = JSON.stringify(nodes.map((n) => ({ root_id: n.root_id, id: n.id, depth: n.depth })))
  const result = await tx.execute(sql`
    WITH nodes AS (SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS n(root_id uuid, id uuid, depth integer)),
    candidates AS (
      SELECT a.root_id, e.*, c.id AS consolidation_id, r.id AS retention_id,
        least(a.depth, b.depth) AS near_depth, greatest(a.depth, b.depth) AS far_depth,
        row_number() OVER (
          PARTITION BY a.root_id, CASE WHEN a.depth > b.depth THEN a.id ELSE b.id END
          ORDER BY least(a.depth, b.depth), e.created_at, e.id
        ) AS parent_rank
      FROM memory_edges e
      JOIN nodes a ON a.id = e.from_id JOIN nodes b ON b.root_id = a.root_id AND b.id = e.to_id
      LEFT JOIN consolidation_proposals c ON c.user_id = ${userId}::uuid AND c.id = e.source_consolidation_proposal_id
      LEFT JOIN retention_proposals r ON r.user_id = ${userId}::uuid AND r.id = e.source_retention_proposal_id
      WHERE e.user_id = ${userId}::uuid AND e.edge_type IN ('supersedes', 'updates')
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY root_id ORDER BY
        (near_depth < far_depth AND parent_rank = 1) DESC,
        far_depth, near_depth, created_at, id) AS rank FROM candidates
    ) SELECT root_id, jsonb_build_object(
      'edgeId', id, 'fromId', from_id, 'toId', to_id, 'edgeType', edge_type, 'createdBy', created_by,
      'sourceProposal', CASE
        WHEN consolidation_id IS NOT NULL THEN jsonb_build_object('proposalKind', 'edge', 'proposalId', consolidation_id)
        WHEN retention_id IS NOT NULL THEN jsonb_build_object('proposalKind', 'retention', 'proposalId', retention_id)
      END
    ) AS edge FROM ranked WHERE rank <= ${MAX_PROVENANCE_EDGES + 1} ORDER BY root_id, rank
  `)
  return result.rows as unknown as ProvenanceEdge[]
}
