// SPDX-License-Identifier: Apache-2.0
// Typed-edge persistence for the memory graph (docs/concepts/memory-model.mdx).
//
// memory_edges links two memories with a typed relationship
// (supersedes/updates/extends/derives — edgeTypeSchema). Both endpoints are
// tenant-qualified via composite FKs, so a cross-tenant edge is unrepresentable
// at the schema level; this helper only ever runs inside a withTenant() tx
// (RLS binds app.user_id), so it never references user_id beyond the row value.
//
// EDGE DIRECTION IS LOAD-BEARING (search.ts): supersession ranking keys on
// EXISTS(edge WHERE e.to_id = m.id AND e.edge_type = 'supersedes') — "m is a
// superseded predecessor". A revision therefore writes the edge FROM the
// successor TO the predecessor. revise() (memory-revise.ts) owns that direction;
// this helper is direction-agnostic and just persists what it is given.
//
// Append-only: this only ever INSERTs. The runtime role has no DELETE on
// memory_edges (provision-roles.sql / append-only.int.test.ts).
import type { ActorKind, EdgeType } from '@3ngram/schema'
import type { TenantTx } from './client.js'
import { isUniqueViolation } from './pg-errors.js'
import { memoryEdges } from './schema/memory.js'

/**
 * Thrown when an edge with the same (user_id, from_id, to_id, edge_type) already
 * exists — the `memory_edges_unique_idx` unique violation, mapped to a typed
 * domain error so callers never inspect pg internals. Carries the edge
 * coordinates (ids + type, never content — observability hard rule 6).
 */
export class EdgeConflictError extends Error {
  readonly fromId: string
  readonly toId: string
  readonly edgeType: EdgeType
  constructor(fromId: string, toId: string, edgeType: EdgeType) {
    super('an edge of this type already links these memories for this tenant')
    this.name = 'EdgeConflictError'
    this.fromId = fromId
    this.toId = toId
    this.edgeType = edgeType
  }
}

/** A typed edge to persist. `userId` scopes the row; RLS binds the tenant. */
export interface EdgeWrite {
  userId: string
  fromId: string
  toId: string
  edgeType: EdgeType
  /** Actor class recorded on memory_edges.created_by. */
  createdBy: ActorKind
}

/**
 * Insert a typed edge inside the caller's tenant-scoped transaction. Composes
 * into a larger tx (revise() writes the successor row, closes the predecessor,
 * and inserts the supersedes edge atomically).
 *
 * The unique index (user_id, from_id, to_id, edge_type) makes edges idempotent
 * at the DB; a re-insert raises a unique violation, mapped here to a typed
 * {@link EdgeConflictError}. The catch is scoped to THIS INSERT so it cannot
 * misattribute an unrelated unique violation (e.g. the memories partial-hash
 * index) raised elsewhere in the same transaction.
 */
export async function insertEdge(tx: TenantTx, edge: EdgeWrite): Promise<void> {
  try {
    await tx.insert(memoryEdges).values({
      userId: edge.userId,
      fromId: edge.fromId,
      toId: edge.toId,
      edgeType: edge.edgeType,
      createdBy: edge.createdBy,
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new EdgeConflictError(edge.fromId, edge.toId, edge.edgeType)
    }
    throw error
  }
}
