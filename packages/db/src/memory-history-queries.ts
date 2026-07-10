// SPDX-License-Identifier: Apache-2.0
// Raw SQL reads + raw row shapes for the memory history view
// (graceful degradation). Split from memory-history-read.ts to keep that
// module under the 500-line cap. Read-only and identity-only:
// never selects memory content, tags, content hashes, embeddings, raw event
// payloads, or arbitrary payload keys. Runs inside withTenant(); RLS scopes rows.
import { sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'

export const MEMORY_HISTORY_LINEAGE_NODE_LIMIT = 25
export const MEMORY_HISTORY_LINEAGE_EDGE_LIMIT = 50
export const MEMORY_HISTORY_DIRECT_RELATIONSHIP_LIMIT = 50
export const MEMORY_HISTORY_EVENT_LIMIT = 50

export interface RawIdentityRow {
  id: string
  memory_type: string
  topic: string
  project: string | null
  scope: string
  status: string
  valid_from: Date
  valid_to: Date | null
  recorded_at: Date
  created_at: Date
}

export interface RawLineageNodeRow extends RawIdentityRow {
  depth: string | number
  total_count: string | number
}

export interface RawEdgeRow {
  id: string
  from_id: string
  to_id: string
  edge_type: string
  created_by: string
  created_at: Date
}

export interface RawDirectRelationshipRow extends RawEdgeRow {
  relationship: 'predecessor' | 'successor'
  related_id: string
  related_memory_type: string
  related_topic: string
  related_project: string | null
  related_scope: string
  related_status: string
  related_valid_from: Date
  related_valid_to: Date | null
  related_recorded_at: Date
  related_created_at: Date
}

export interface RawEventRow {
  id: string
  event_kind: string
  actor_kind: string
  created_at: Date
  payload_present: boolean
  payload_json_type: string | null
  payload_byte_length: string | number | null
}

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[]
}

/**
 * Run `fn` inside a SQL SAVEPOINT so a statement failure aborts only `fn`'s work,
 * not the surrounding withTenant() transaction. On error the savepoint is rolled
 * back — leaving the transaction usable for the next read — and the error is
 * rethrown. This is what lets one history section fail (e.g. a query timeout)
 * without poisoning the other section's read (graceful degradation).
 * `name` MUST be a trusted constant identifier, never user input.
 */
export async function withSavepoint<T>(
  tx: TenantTx,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SAVEPOINT ${sql.raw(name)}`)
  try {
    const result = await fn()
    await tx.execute(sql`RELEASE SAVEPOINT ${sql.raw(name)}`)
    return result
  } catch (error) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT ${sql.raw(name)}`)
    throw error
  }
}

export async function readInspectedMemory(
  tx: TenantTx,
  memoryId: string,
): Promise<RawIdentityRow | undefined> {
  const result = await tx.execute(sql`
    SELECT id, memory_type, topic, project, scope, status,
           valid_from, valid_to, recorded_at, created_at
    FROM memories
    WHERE id = ${memoryId}::uuid
    LIMIT 1
  `)
  return rowsOf<RawIdentityRow>(result)[0]
}

export async function readDirectRelationships(
  tx: TenantTx,
  memoryId: string,
): Promise<RawDirectRelationshipRow[]> {
  const result = await tx.execute(sql`
    SELECT e.id, e.from_id, e.to_id, e.edge_type, e.created_by, e.created_at,
           CASE WHEN e.from_id = ${memoryId}::uuid THEN 'predecessor' ELSE 'successor' END AS relationship,
           related.id AS related_id,
           related.memory_type AS related_memory_type,
           related.topic AS related_topic,
           related.project AS related_project,
           related.scope AS related_scope,
           related.status AS related_status,
           related.valid_from AS related_valid_from,
           related.valid_to AS related_valid_to,
           related.recorded_at AS related_recorded_at,
           related.created_at AS related_created_at
    FROM memory_edges e
    INNER JOIN memories related
      ON related.user_id = e.user_id
     AND related.id = CASE WHEN e.from_id = ${memoryId}::uuid THEN e.to_id ELSE e.from_id END
    WHERE e.from_id = ${memoryId}::uuid OR e.to_id = ${memoryId}::uuid
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${MEMORY_HISTORY_DIRECT_RELATIONSHIP_LIMIT + 1}
  `)
  return rowsOf<RawDirectRelationshipRow>(result)
}

export async function readLineageNodes(
  tx: TenantTx,
  memoryId: string,
): Promise<RawLineageNodeRow[]> {
  const result = await tx.execute(sql`
    WITH RECURSIVE walk(id, depth, path) AS (
      SELECT ${memoryId}::uuid, 0, ARRAY[${memoryId}::uuid]
      UNION ALL
      SELECT next.id, walk.depth + 1, walk.path || next.id
      FROM walk
      INNER JOIN memory_edges e
        ON e.edge_type IN ('supersedes', 'updates')
       AND (e.from_id = walk.id OR e.to_id = walk.id)
      CROSS JOIN LATERAL (
        SELECT CASE WHEN e.from_id = walk.id THEN e.to_id ELSE e.from_id END AS id
      ) next
      WHERE walk.depth < ${MEMORY_HISTORY_LINEAGE_NODE_LIMIT}
        AND NOT next.id = ANY(walk.path)
    ),
    dedup AS (
      SELECT id, min(depth) AS depth
      FROM walk
      GROUP BY id
    ),
    ranked AS (
      SELECT id, depth, count(*) over() AS total_count
      FROM dedup
      ORDER BY depth ASC, id ASC
      LIMIT ${MEMORY_HISTORY_LINEAGE_NODE_LIMIT + 1}
    )
    SELECT m.id, m.memory_type, m.topic, m.project, m.scope, m.status,
           m.valid_from, m.valid_to, m.recorded_at, m.created_at,
           ranked.depth, ranked.total_count
    FROM ranked
    INNER JOIN memories m ON m.id = ranked.id
    ORDER BY ranked.depth ASC, m.created_at ASC, m.id ASC
  `)
  return rowsOf<RawLineageNodeRow>(result)
}

export async function readLineageEdges(tx: TenantTx, nodeIds: string[]): Promise<RawEdgeRow[]> {
  if (nodeIds.length === 0) return []
  const lineageIdList = sql.join(
    nodeIds.map((nodeId) => sql`${nodeId}::uuid`),
    sql`, `,
  )
  const result = await tx.execute(sql`
    SELECT id, from_id, to_id, edge_type, created_by, created_at
    FROM memory_edges
    WHERE edge_type IN ('supersedes', 'updates')
      AND from_id IN (${lineageIdList})
      AND to_id IN (${lineageIdList})
    ORDER BY created_at ASC, id ASC
    LIMIT ${MEMORY_HISTORY_LINEAGE_EDGE_LIMIT + 1}
  `)
  return rowsOf<RawEdgeRow>(result)
}

export async function readAuditEvents(tx: TenantTx, memoryId: string): Promise<RawEventRow[]> {
  const result = await tx.execute(sql`
    SELECT e.id, e.event_kind, e.actor_kind, e.created_at,
           (e.payload IS NOT NULL) AS payload_present,
           jsonb_typeof(e.payload) AS payload_json_type,
           CASE WHEN e.payload IS NULL THEN 0 ELSE octet_length(e.payload::text) END AS payload_byte_length
    FROM memory_events e
    WHERE e.memory_id = ${memoryId}::uuid
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${MEMORY_HISTORY_EVENT_LIMIT + 1}
  `)
  return rowsOf<RawEventRow>(result)
}
