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
  type AppliedFactProposal,
  type AppliedProposalRow,
  applyFactProposal as applyFactProposalDb,
  applyProposal as applyProposalDb,
  type FactProposalRow,
  listFactProposals as listFactProposalsDb,
  listProposals as listProposalsDb,
  ProposalNotFoundError,
  type ProposalRow,
  rejectFactProposal as rejectFactProposalDb,
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

/** An extracted-fact proposal record returned to a transport. */
export type FactProposalRecord = FactProposalRow

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

/** Both proposal kinds for one tenant, each bounded by the SAME per-source limit. */
export interface AllProposals {
  proposals: ProposalRecord[]
  factProposals: FactProposalRecord[]
}

/**
 * List BOTH proposal kinds for the tenant, most-recent first within each.
 *
 * `limit` is PER SOURCE, not a shared budget: the two kinds are independent
 * review queues, and splitting one budget across them would let a burst of
 * extracted facts hide every edge proposal (or the reverse) instead of showing
 * a bounded window of each. The caller still gets at most 2 x limit records, so
 * the no-firehose rule holds.
 *
 * One withTenant transaction covers both reads, so the two lists are a
 * consistent snapshot rather than two round-trips a decision could land between.
 */
export function listAllProposals(userId: string, query: ProposalsListQuery): Promise<AllProposals> {
  const dbQuery =
    query.status === undefined
      ? { limit: query.limit }
      : { status: query.status, limit: query.limit }
  return withTenant(userId, async (tx) => ({
    proposals: await listProposalsDb(tx, dbQuery),
    factProposals: await listFactProposalsDb(tx, userId, dbQuery),
  }))
}

/**
 * The outcome of deciding a proposal whose KIND the caller did not state.
 * `kind` tells the transport which output variant to build; `factId` is present
 * only when applying a fact proposal materialized one.
 */
export type DecidedProposal =
  | { kind: 'edge'; proposal: ProposalRecord }
  | { kind: 'edge_applied'; proposal: AppliedProposalRow }
  | { kind: 'fact'; proposal: FactProposalRecord }
  | { kind: 'fact_applied'; proposal: FactProposalRecord; factId: string }

/**
 * Probe the edge table first, then the fact table, and report not-found only
 * after BOTH miss.
 *
 * The id alone is enough to disambiguate: both tables key on uuidv7, so an id
 * that exists in one cannot collide with the other and a hit is unambiguous.
 * That is what lets accept/reject keep their shipped single-id input instead of
 * making every caller state which kind it holds.
 *
 * The probe is ordered edge-first because edge proposals are the shipped,
 * higher-volume kind; the fact lookup is only reached when the first misses.
 * A ProposalNotFoundError from the FIRST probe is a "not this kind" signal, not
 * a failure — only the second one propagates.
 */
async function decideAnyKind<T>(onEdge: () => Promise<T>, onFact: () => Promise<T>): Promise<T> {
  try {
    return await onEdge()
  } catch (error) {
    if (!(error instanceof ProposalNotFoundError)) throw error
    return onFact()
  }
}

/**
 * Reject an open proposal of EITHER kind (proposed -> rejected). Missing or
 * already-decided in both tables -> ProposalNotFoundError. Runs under
 * withTenant/RLS, which is also what makes a cross-tenant id indistinguishable
 * from a missing one.
 */
export function rejectProposalAnyKind(
  userId: string,
  proposalId: string,
): Promise<DecidedProposal> {
  return decideAnyKind<DecidedProposal>(
    async () => ({
      kind: 'edge',
      proposal: await withTenant(userId, (tx) => rejectProposalDb(tx, proposalId)),
    }),
    async () => ({
      kind: 'fact',
      proposal: await withTenant(userId, (tx) => rejectFactProposalDb(tx, userId, proposalId)),
    }),
  )
}

/**
 * Accept an open proposal of EITHER kind. An edge proposal materializes its
 * typed edge (and closes the predecessor for a supersedes/updates edge); a fact
 * proposal writes the fact it proposed and returns its id. Missing or
 * already-decided in both tables -> ProposalNotFoundError.
 */
export function acceptProposalAnyKind(
  userId: string,
  proposalId: string,
  actorKind: ActorKind,
): Promise<DecidedProposal> {
  return decideAnyKind<DecidedProposal>(
    async () => ({
      kind: 'edge_applied',
      proposal: await withTenant(userId, (tx) =>
        applyProposalDb(tx, userId, proposalId, actorKind),
      ),
    }),
    async () => {
      const applied: AppliedFactProposal = await withTenant(userId, (tx) =>
        applyFactProposalDb(tx, userId, proposalId),
      )
      return { kind: 'fact_applied', proposal: applied.proposal, factId: applied.factId }
    },
  )
}
