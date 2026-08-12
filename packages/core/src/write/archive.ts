// SPDX-License-Identifier: Apache-2.0
// archiveMemory(): the generic ARCHIVE lifecycle write path (adoption-gate
// Decision D — REST-only: NO MCP tool mirrors this surface. Archiving is an
// operator action, not an agent JTBD, so it never met hard rule 8's bar for a
// tool description competing in `tools/list`).
//
// apps -> core -> db layering (hard rule 5): a THIN orchestration over the db
// status flip (which runs withTenant internally, hard rule 3). The only policy
// here is the error contract: the db layer's typed miss
// (ActiveMemoryNotFoundError) is re-keyed to core's MemoryNotFoundError so the
// REST mapper's existing 404 branch covers it — mirroring how resolveByMemoryId
// maps BlockerNotFoundError to CommitmentNotFoundError.
//
// Unlike revise, ARCHIVE takes no content: there is nothing to validate at the
// schema boundary beyond the id the transport already bounds, and nothing to
// embed. Append-only (hard rule 1) holds: the row's status flips, valid_to stays
// NULL (the archived bucket is status='archived' AND valid_to IS NULL — see the
// db-layer doc), and no row is ever deleted.
//
// Observability (hard rule 6): this module logs nothing; the typed errors carry
// ids only, never content.
import { ActiveMemoryNotFoundError, archiveMemory as dbArchiveMemory } from '@3ngram/db'
import type { ActorKind } from '@3ngram/schema'
import { MemoryNotFoundError } from '../read/memory.js'

/**
 * Archive an ACTIVE memory of any type for `userId`: status
 * 'active' -> 'archived', audited with an 'archive' memory event in the same
 * transaction. valid_to stays NULL — the row moves to the archived bucket
 * (status='archived' AND valid_to IS NULL), NOT the superseded bucket.
 *
 * @param userId     Tenant whose RLS context the write runs under.
 * @param memoryId   The memory to archive.
 * @param actorKind  Actor class recorded on the audit event.
 * @throws {@link MemoryNotFoundError} no ACTIVE memory by this id for the tenant
 *   (RLS hides cross-tenant rows; an already-archived or superseded row is the
 *   same miss — there is no active memory to archive).
 */
export async function archiveMemory(
  userId: string,
  memoryId: string,
  actorKind: ActorKind,
): Promise<{ id: string; status: 'archived' }> {
  try {
    return await dbArchiveMemory(userId, memoryId, actorKind)
  } catch (error) {
    if (error instanceof ActiveMemoryNotFoundError) throw new MemoryNotFoundError(memoryId)
    throw error
  }
}
