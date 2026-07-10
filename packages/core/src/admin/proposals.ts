// SPDX-License-Identifier: Apache-2.0
// review_proposals policy surface — the human-in-the-loop side of background
// consolidation. apps -> core -> db
// (hard rule 5): thin policy over the db read/reject helpers, wrapping every
// access in withTenant() (hard rule 3) and re-exporting the typed db errors.
//
// ACCEPT: applyProposal materializes the proposed
// typed edge and, for a supersedes/updates edge, closes the predecessor's validity
// per docs/concepts/memory-model.mdx append-and-supersede — a DEDICATED path (NOT reviseMemory: there is
// no successor memory to append), all in one withTenant tx (db proposals-apply.ts).
import {
  type AppliedProposalRow,
  applyProposal as applyProposalDb,
  listProposals as listProposalsDb,
  type ProposalRow,
  rejectProposal as rejectProposalDb,
  withTenant,
} from '@3ngram/db'
import type { ActorKind } from '@3ngram/schema'

export {
  type AppliedProposalRow,
  EpisodicSupersessionError,
  ProposalNotFoundError,
  SuccessorNotLiveError,
} from '@3ngram/db'

/** A consolidation-proposal record returned to a transport. */
export type ProposalRecord = ProposalRow

/**
 * List-mode query: optional status filter + a bounded window (caller defaults
 * it). `status` admits `undefined` explicitly (exactOptionalPropertyTypes) so a
 * transport can forward an absent filter without a conditional object build.
 */
export interface ProposalsListQuery {
  status?: string | undefined
  limit: number
}

/** List the tenant's proposals (most-recent first), bounded. Runs under withTenant/RLS. */
export function listProposals(
  userId: string,
  query: ProposalsListQuery,
): Promise<ProposalRecord[]> {
  // Build the db query without an undefined `status` key (exactOptionalPropertyTypes):
  // omit the filter entirely when absent so listProposalsDb lists all statuses.
  const dbQuery =
    query.status === undefined
      ? { limit: query.limit }
      : { status: query.status, limit: query.limit }
  return withTenant(userId, (tx) => listProposalsDb(tx, dbQuery))
}

/**
 * Reject an open proposal (proposed -> rejected, an UPDATE — append-only grant).
 * Already-decided or missing -> ProposalNotFoundError. Runs under withTenant/RLS.
 */
export function rejectProposal(userId: string, proposalId: string): Promise<ProposalRecord> {
  return withTenant(userId, (tx) => rejectProposalDb(tx, proposalId))
}

/**
 * Apply (accept) an open proposal: in ONE withTenant tx, materialize the proposed
 * typed edge (from_id -> to_id, edge_type) and — for a supersedes/updates edge —
 * close the predecessor (to_id, per the load-bearing edge convention) bi-temporal
 * validity (valid_to = now, content NEVER touched, docs/concepts/memory-model.mdx) plus an audit
 * `supersede` event, then mark the proposal applied + decided_at. A DEDICATED
 * path, not reviseMemory: there is no successor memory to append. An event-type
 * supersedes/updates proposal is refused (EpisodicSupersessionError, docs/concepts/memory-model.mdx "Consolidation is advisory"),
 * and a fresh supersedes/updates apply whose proposed SUCCESSOR (from_id) is no
 * longer live is refused too (SuccessorNotLiveError — the proposal went stale
 * while queued and must be re-proposed against the live successor chain; it
 * stays `proposed` for the existing reject path). Already-decided or missing ->
 * ProposalNotFoundError (no double-apply). Runs under withTenant/RLS.
 */
export function applyProposal(
  userId: string,
  proposalId: string,
  actorKind: ActorKind,
): Promise<AppliedProposalRow> {
  return withTenant(userId, (tx) => applyProposalDb(tx, userId, proposalId, actorKind))
}
