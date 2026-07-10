// SPDX-License-Identifier: Apache-2.0
// Memory history read model for the dashboard detail surface.
// This module is read-only and identity-only: it never selects memory content,
// tags, content hashes, embeddings, raw event payloads, or arbitrary payload
// keys. It runs inside withTenant(); RLS scopes all rows to the caller. The raw
// SQL reads + raw row shapes live in ./memory-history-queries.ts (500-line cap).
import type { TenantTx } from './client.js'
import {
  MEMORY_HISTORY_DIRECT_RELATIONSHIP_LIMIT,
  MEMORY_HISTORY_EVENT_LIMIT,
  MEMORY_HISTORY_LINEAGE_EDGE_LIMIT,
  MEMORY_HISTORY_LINEAGE_NODE_LIMIT,
  type RawDirectRelationshipRow,
  type RawEdgeRow,
  type RawEventRow,
  type RawIdentityRow,
  type RawLineageNodeRow,
  readAuditEvents,
  readDirectRelationships,
  readInspectedMemory,
  readLineageEdges,
  readLineageNodes,
  withSavepoint,
} from './memory-history-queries.js'

export {
  MEMORY_HISTORY_DIRECT_RELATIONSHIP_LIMIT,
  MEMORY_HISTORY_EVENT_LIMIT,
  MEMORY_HISTORY_LINEAGE_EDGE_LIMIT,
  MEMORY_HISTORY_LINEAGE_NODE_LIMIT,
} from './memory-history-queries.js'

export type MemoryHistoryLifecycleState = 'current' | 'superseded' | 'archived' | 'historical'

export interface MemoryHistoryIdentityRow {
  id: string
  memoryType: string
  topic: string
  project: string | null
  scope: string
  status: string
  validFrom: Date
  validTo: Date | null
  recordedAt: Date
  createdAt: Date
  isCurrent: boolean
  lifecycleState: MemoryHistoryLifecycleState
}

export interface MemoryHistoryEdgeRow {
  id: string
  fromId: string
  toId: string
  edgeType: string
  createdBy: string
  createdAt: Date
}

export interface MemoryHistoryRelationshipRow {
  memory: MemoryHistoryIdentityRow
  edge: MemoryHistoryEdgeRow
}

export interface MemoryHistoryPayloadMetadataRow {
  present: boolean
  jsonType: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | null
  byteLength: number
}

export interface MemoryHistoryEventRow {
  id: string
  eventKind: string
  actorKind: string
  createdAt: Date
  payloadMetadata: MemoryHistoryPayloadMetadataRow
}

export type MemoryHistorySectionStatus = 'ok' | 'unavailable'

export interface MemoryHistorySections {
  lineage: MemoryHistorySectionStatus
  events: MemoryHistorySectionStatus
}

export interface MemoryHistoryRead {
  memory: MemoryHistoryIdentityRow
  lineage: {
    nodes: MemoryHistoryIdentityRow[]
    edges: MemoryHistoryEdgeRow[]
    truncated: boolean
  }
  directRelationships: {
    predecessors: MemoryHistoryRelationshipRow[]
    successors: MemoryHistoryRelationshipRow[]
    truncated: boolean
  }
  auditEvents: MemoryHistoryEventRow[]
  eventsTruncated: boolean
  /** Per-section load status. A readable identity never aborts the whole read. */
  sections: MemoryHistorySections
  /**
   * Content-free diagnostic: the error class name per failed section (omitted
   * when the section is `ok`). NOT part of the wire contract — surfaced so the
   * transport can log a content-free degradation signal.
   */
  sectionErrors?: { lineage?: string; events?: string }
}

const REVISION_EDGE_TYPES = new Set(['supersedes', 'updates'])

// `tx.execute(sql\`...\`)` returns timestamp columns as raw strings (e.g.
// "2026-06-23 18:57:13.340892+00"), not Date objects, so the Date-typed read
// model must coerce them itself — otherwise a downstream `.toISOString()`
// throws (every history request 500'd, masked by Date-returning
// route-test mocks). Idempotent for inputs that are already Date.
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function lifecycleState(
  row: Pick<RawIdentityRow, 'id' | 'status' | 'valid_to'>,
  supersededIds: ReadonlySet<string>,
): MemoryHistoryLifecycleState {
  if (row.status === 'archived') return 'archived'
  if (row.status === 'active' && row.valid_to === null) return 'current'
  if (row.valid_to !== null && supersededIds.has(row.id)) return 'superseded'
  return 'historical'
}

function mapIdentity(
  row: RawIdentityRow,
  supersededIds: ReadonlySet<string>,
): MemoryHistoryIdentityRow {
  const isCurrent = row.status === 'active' && row.valid_to === null
  return {
    id: row.id,
    memoryType: row.memory_type,
    topic: row.topic,
    project: row.project ?? null,
    scope: row.scope,
    status: row.status,
    validFrom: toDate(row.valid_from),
    validTo: row.valid_to === null ? null : toDate(row.valid_to),
    recordedAt: toDate(row.recorded_at),
    createdAt: toDate(row.created_at),
    isCurrent,
    lifecycleState: lifecycleState(row, supersededIds),
  }
}

function mapEdge(row: RawEdgeRow): MemoryHistoryEdgeRow {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    edgeType: row.edge_type,
    createdBy: row.created_by,
    createdAt: toDate(row.created_at),
  }
}

function directRelatedIdentity(row: RawDirectRelationshipRow): RawIdentityRow {
  return {
    id: row.related_id,
    memory_type: row.related_memory_type,
    topic: row.related_topic,
    project: row.related_project,
    scope: row.related_scope,
    status: row.related_status,
    valid_from: row.related_valid_from,
    valid_to: row.related_valid_to,
    recorded_at: row.related_recorded_at,
    created_at: row.related_created_at,
  }
}

function collectSupersededIds(edgeRows: ReadonlyArray<RawEdgeRow>): Set<string> {
  const ids = new Set<string>()
  for (const edge of edgeRows) {
    if (REVISION_EDGE_TYPES.has(edge.edge_type)) ids.add(edge.to_id)
  }
  return ids
}

function mergeSupersededIds(...sets: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  const merged = new Set<string>()
  for (const set of sets) {
    for (const id of set) merged.add(id)
  }
  return merged
}

function payloadJsonType(value: string | null): MemoryHistoryPayloadMetadataRow['jsonType'] {
  if (
    value === 'object' ||
    value === 'array' ||
    value === 'string' ||
    value === 'number' ||
    value === 'boolean' ||
    value === 'null'
  ) {
    return value
  }
  return null
}

/** Group bounded predecessor/successor rows into the identity-only relationship view. */
function assembleDirectRelationships(
  boundedDirectRows: RawDirectRelationshipRow[],
  supersededIds: Set<string>,
  truncated: boolean,
): MemoryHistoryRead['directRelationships'] {
  const predecessors: MemoryHistoryRelationshipRow[] = []
  const successors: MemoryHistoryRelationshipRow[] = []
  for (const row of boundedDirectRows) {
    const relationship = {
      memory: mapIdentity(directRelatedIdentity(row), supersededIds),
      edge: mapEdge(row),
    }
    if (row.relationship === 'predecessor') predecessors.push(relationship)
    else successors.push(relationship)
  }
  return { predecessors, successors, truncated }
}

/** Map bounded event rows to identity + payload-metadata-only audit events. */
function mapAuditEvents(boundedAuditRows: RawEventRow[]): MemoryHistoryEventRow[] {
  return boundedAuditRows.map((row) => ({
    id: row.id,
    eventKind: row.event_kind,
    actorKind: row.actor_kind,
    createdAt: toDate(row.created_at),
    payloadMetadata: {
      present: row.payload_present === true,
      jsonType: payloadJsonType(row.payload_json_type),
      byteLength: Number(row.payload_byte_length ?? 0),
    },
  }))
}

/** Bounded raw rows + derived flags for the lineage group, read as one unit. */
interface LineageGroupRead {
  boundedDirectRows: RawDirectRelationshipRow[]
  directTruncated: boolean
  boundedLineageNodeRows: RawLineageNodeRow[]
  boundedLineageEdgeRows: RawEdgeRow[]
  lineageTruncated: boolean
  supersededIds: Set<string>
}

/** Read the lineage + direct-relationship group (`sections.lineage`) as one unit. */
async function readLineageGroup(tx: TenantTx, memoryId: string): Promise<LineageGroupRead> {
  const directRows = await readDirectRelationships(tx, memoryId)
  const boundedDirectRows = directRows.slice(0, MEMORY_HISTORY_DIRECT_RELATIONSHIP_LIMIT)
  const directTruncated = directRows.length > MEMORY_HISTORY_DIRECT_RELATIONSHIP_LIMIT

  const lineageNodeRows = await readLineageNodes(tx, memoryId)
  const boundedLineageNodeRows = lineageNodeRows.slice(0, MEMORY_HISTORY_LINEAGE_NODE_LIMIT)
  const lineageNodeIds = boundedLineageNodeRows.map((row) => row.id)
  const lineageNodeTruncated = lineageNodeRows.length > MEMORY_HISTORY_LINEAGE_NODE_LIMIT

  const lineageEdgeRows = await readLineageEdges(tx, lineageNodeIds)
  const boundedLineageEdgeRows = lineageEdgeRows.slice(0, MEMORY_HISTORY_LINEAGE_EDGE_LIMIT)
  const lineageEdgeTruncated = lineageEdgeRows.length > MEMORY_HISTORY_LINEAGE_EDGE_LIMIT

  return {
    boundedDirectRows,
    directTruncated,
    boundedLineageNodeRows,
    boundedLineageEdgeRows,
    lineageTruncated: lineageNodeTruncated || lineageEdgeTruncated,
    supersededIds: mergeSupersededIds(
      collectSupersededIds(directRows),
      collectSupersededIds(lineageEdgeRows),
    ),
  }
}

/** Assemble the lineage + direct-relationship views from a successful group read. */
function assembleLineageSection(
  group: LineageGroupRead,
  memory: MemoryHistoryIdentityRow,
): Pick<MemoryHistoryRead, 'lineage' | 'directRelationships'> {
  const lineageNodes = group.boundedLineageNodeRows.map((row) =>
    mapIdentity(row, group.supersededIds),
  )
  return {
    lineage: {
      nodes: lineageNodes.length > 0 ? lineageNodes : [memory],
      edges: group.boundedLineageEdgeRows.map(mapEdge),
      truncated: group.lineageTruncated,
    },
    directRelationships: assembleDirectRelationships(
      group.boundedDirectRows,
      group.supersededIds,
      group.directTruncated,
    ),
  }
}

/** Empty lineage + relationships used when the lineage group is `unavailable`. */
function emptyLineageSection(): Pick<MemoryHistoryRead, 'lineage' | 'directRelationships'> {
  return {
    lineage: { nodes: [], edges: [], truncated: false },
    directRelationships: { predecessors: [], successors: [], truncated: false },
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}

/**
 * Read the history view for one memory id. Returns undefined for absent or
 * cross-tenant ids (RLS collapses those cases). Output is bounded and
 * identity-only except for audit payload metadata.
 *
 * Graceful degradation: the lineage group and the events group are
 * read independently; a failure in one is captured as `sections.<x> =
 * 'unavailable'` (empty arrays) instead of aborting the whole read. Only an
 * absent identity (the precondition) yields undefined → 404. A readable identity
 * never throws here, so the transport never turns it into a 500 (root fix).
 */
export async function getMemoryHistory(
  tx: TenantTx,
  memoryId: string,
): Promise<MemoryHistoryRead | undefined> {
  const inspected = await readInspectedMemory(tx, memoryId)
  if (inspected === undefined) return undefined

  const sectionErrors: { lineage?: string; events?: string } = {}

  // Each section reads inside its own SAVEPOINT so a real DB error (e.g. a query
  // timeout) aborts only that section and rolls back cleanly, leaving the shared
  // withTenant() transaction usable for the other section. Without this,
  // a lineage failure would poison the events read on the same aborted tx.
  let lineageGroup: LineageGroupRead | undefined
  let lineageStatus: MemoryHistorySectionStatus = 'ok'
  try {
    lineageGroup = await withSavepoint(tx, 'history_lineage', () => readLineageGroup(tx, memoryId))
  } catch (error) {
    lineageStatus = 'unavailable'
    sectionErrors.lineage = errorName(error)
  }

  let auditRows: RawEventRow[] | undefined
  let eventsStatus: MemoryHistorySectionStatus = 'ok'
  try {
    auditRows = await withSavepoint(tx, 'history_events', () => readAuditEvents(tx, memoryId))
  } catch (error) {
    eventsStatus = 'unavailable'
    sectionErrors.events = errorName(error)
  }

  const supersededIds = lineageGroup?.supersededIds ?? new Set<string>()
  const memory = mapIdentity(inspected, supersededIds)
  const lineageView =
    lineageGroup !== undefined
      ? assembleLineageSection(lineageGroup, memory)
      : emptyLineageSection()
  const boundedAuditRows = auditRows?.slice(0, MEMORY_HISTORY_EVENT_LIMIT) ?? []

  return {
    memory,
    lineage: lineageView.lineage,
    directRelationships: lineageView.directRelationships,
    auditEvents: mapAuditEvents(boundedAuditRows),
    eventsTruncated: auditRows !== undefined && auditRows.length > MEMORY_HISTORY_EVENT_LIMIT,
    sections: { lineage: lineageStatus, events: eventsStatus },
    ...(sectionErrors.lineage !== undefined || sectionErrors.events !== undefined
      ? { sectionErrors }
      : {}),
  }
}
