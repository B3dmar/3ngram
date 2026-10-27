// SPDX-License-Identifier: Apache-2.0
// Retention-proposal staging for the forgetting pass
// (docs/concepts/forgetting-pass.mdx): the pass's insert, and the projection
// that reads and the export share.
//
// SQL ONLY (hard rule 5): which memories to judge, and what a verdict means,
// are policy in packages/core. Every query runs inside the caller's
// withTenant() transaction AND binds the caller's user_id.
//
// The runtime role has INSERT, SELECT and UPDATE on retention_proposals and NO
// DELETE, so every verdict survives as its own audit trail. A decision flips
// `status` and stamps `decided_at`. Accepting applies the verdict in the SAME
// transaction as the claim, so a refused action leaves the proposal open.
//
// Observability (hard rule 6): ids, probabilities, enum states and a model
// name only. The table has no user text, and this module logs nothing.
import type { ActorKind, RetentionAction, RetentionProposalStatus } from '@3ngram/schema'
import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { archiveMemoryIn } from './memory-disposition.js'
import { materializeEdgeIn } from './proposals-apply.js'
import { ProposalNotFoundError } from './proposals-read.js'
import { memories, retentionProposals } from './schema/memory.js'

/** A retention proposal row, minus the tenant id. */
export interface RetentionProposalRow {
  id: string
  memoryId: string
  action: string
  relatedMemoryId: string | null
  probability: number
  probabilities: Record<string, number>
  model: string
  status: string
  decidedAt: Date | null
  createdAt: Date
}

/** Shared projection so every read and the export return the identical row shape. */
export const RETENTION_PROPOSAL_COLUMNS = {
  id: retentionProposals.id,
  memoryId: retentionProposals.memoryId,
  action: retentionProposals.action,
  relatedMemoryId: retentionProposals.relatedMemoryId,
  probability: retentionProposals.probability,
  probabilities: retentionProposals.probabilities,
  model: retentionProposals.model,
  status: retentionProposals.status,
  decidedAt: retentionProposals.decidedAt,
  createdAt: retentionProposals.createdAt,
} as const

/**
 * One verdict to stage. `relatedMemoryId` names the newer memory (supersede) or
 * the other side (conflict), and is absent for keep and archive; the table's
 * CHECK enforces the pairing.
 */
export interface RetentionVerdictWrite {
  memoryId: string
  action: RetentionAction
  relatedMemoryId?: string | undefined
  /** The chosen key's probability, in [0, 1]. */
  probability: number
  /** The judge's full choice distribution, kept for calibration. */
  probabilities: Record<string, number>
  /** The pinned judge model. */
  model: string
  /**
   * Store the verdict `dismissed` even though its action is not keep: it did
   * not clear its threshold. It is recorded for calibration and stops the pass
   * from judging the memory again until it changes, but is never listed.
   */
  dismissed?: boolean | undefined
}

/**
 * A choice key is an action name, optionally with an item ref
 * (`keep`, `archive_older`, `supersede_by:s0n0`). Never memory text: the table
 * must hold no user text, which is why account erasure can leave it alone.
 */
const PROBABILITY_KEY = /^[a-z_]+(:[a-z0-9]+)?$/

/** A keep or below-threshold verdict is recorded but never listed; every other verdict waits for review. */
function statusFor(verdict: RetentionVerdictWrite): RetentionProposalStatus {
  return verdict.action === 'keep' || verdict.dismissed === true ? 'dismissed' : 'proposed'
}

/**
 * Stage verdicts in the caller's transaction. Returns the number of rows inserted.
 *
 * A verdict is staged only while every memory it names is still live
 * (`valid_to IS NULL` and status `active`): the judgment can be stale by the
 * time it returns, and accepting a proposal over a superseded or archived
 * memory is refused anyway. The live rows are read FOR SHARE, so a concurrent
 * revise or archive of them waits for this transaction (the commitments.ts
 * precedent).
 *
 * A keep verdict, or one marked `dismissed`, is stored `dismissed` with no
 * `decided_at`, since no reviewer decided it. Dismissed rows are not deduplicated; the pass's candidate query
 * skips a memory whose verdict is newer than its freshness. A proposed verdict
 * is skipped when its memory already has an OPEN proposal for the same action
 * (`retention_proposals_open_idx`, ON CONFLICT DO NOTHING), so later passes
 * cannot stack duplicates before a reviewer decides.
 *
 * Throws, naming no key, when a probabilities key is not an action name or item ref.
 */
export async function insertRetentionProposals(
  tx: TenantTx,
  userId: string,
  verdicts: readonly RetentionVerdictWrite[],
): Promise<number> {
  if (verdicts.length === 0) return 0
  for (const v of verdicts) {
    if (!Object.keys(v.probabilities).every((key) => PROBABILITY_KEY.test(key))) {
      throw new Error(
        'insertRetentionProposals: a probabilities key is not an action name or item ref',
      )
    }
  }
  const named = [
    ...new Set(
      verdicts.flatMap((v) =>
        v.relatedMemoryId === undefined ? [v.memoryId] : [v.memoryId, v.relatedMemoryId],
      ),
    ),
  ]
  const live = await tx
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        inArray(memories.id, named),
        isNull(memories.validTo),
        eq(memories.status, 'active'),
      ),
    )
    .for('share')
  const liveIds = new Set(live.map((row) => row.id))
  const staged = verdicts.filter(
    (v) =>
      liveIds.has(v.memoryId) &&
      (v.relatedMemoryId === undefined || liveIds.has(v.relatedMemoryId)),
  )
  if (staged.length === 0) return 0
  const rows = await tx
    .insert(retentionProposals)
    .values(
      staged.map((v) => ({
        userId,
        memoryId: v.memoryId,
        action: v.action,
        relatedMemoryId: v.relatedMemoryId ?? null,
        probability: v.probability,
        probabilities: v.probabilities,
        model: v.model,
        status: statusFor(v),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: retentionProposals.id })
  return rows.length
}

/**
 * Raised when an accepted retention proposal can no longer be applied: the
 * memory left the live set, or the archive disposition refuses it (a blocker,
 * or an open or waiting commitment). The transaction rolls back, so the
 * proposal stays open for a reviewer to reject. Ids and a reason only.
 */
export class RetentionProposalNotApplicableError extends Error {
  constructor(
    readonly proposalId: string,
    readonly reason: string,
  ) {
    super(`retention proposal ${proposalId} cannot be applied: ${reason}`)
    this.name = 'RetentionProposalNotApplicableError'
  }
}

/**
 * Decide an OPEN proposal: proposed -> applied | rejected, a compare-and-set on
 * `status`. Missing, already decided, dismissed, or another tenant's ->
 * ProposalNotFoundError, so two concurrent decisions cannot both succeed.
 */
export async function decideRetentionProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
  status: 'applied' | 'rejected',
): Promise<RetentionProposalRow> {
  const [row] = await tx
    .update(retentionProposals)
    .set({ status, decidedAt: sql`now()` })
    .where(
      and(
        eq(retentionProposals.userId, userId),
        eq(retentionProposals.id, proposalId),
        eq(retentionProposals.status, 'proposed'),
      ),
    )
    .returning(RETENTION_PROPOSAL_COLUMNS)
  if (row === undefined) throw new ProposalNotFoundError(proposalId)
  return row
}

/**
 * Accept an OPEN retention proposal as the reviewer, in the caller's ONE
 * transaction: claim it (proposed -> applied), then apply its verdict.
 *
 * - **archive:** the revise archive disposition (`archiveMemoryIn`, policy
 *   `disposition`), with its audited `archive` event. An already archived
 *   memory counts as applied; any refusal throws
 *   {@link RetentionProposalNotApplicableError}.
 * - **supersede:** a `supersedes` edge from the newer memory to the older one,
 *   closing the older one exactly as an edge proposal does
 *   (`materializeEdgeIn`): event-type memories and a superseded successor are
 *   refused there, and an older memory that is no longer live is refused here.
 *   As with any predecessor close, an open commitment on the older memory moves
 *   to the newer one or is resolved.
 * - **conflict:** records the review only. The reviewer resolves the conflict
 *   with `revise`.
 *
 * Any throw rolls the claim back with everything else, so a refused verdict
 * leaves the proposal open.
 *
 * LOCK ORDER: the judged memory is locked FOR UPDATE before the proposal is
 * claimed. Staging locks the memory (FOR SHARE) before it inserts a proposal,
 * so both take the memory first and cannot deadlock on each other.
 */
export async function acceptRetentionProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
  actorKind: ActorKind,
): Promise<RetentionProposalRow> {
  const [open] = await tx
    .select({ memoryId: retentionProposals.memoryId })
    .from(retentionProposals)
    .where(
      and(
        eq(retentionProposals.userId, userId),
        eq(retentionProposals.id, proposalId),
        eq(retentionProposals.status, 'proposed'),
      ),
    )
    .limit(1)
  if (open === undefined) throw new ProposalNotFoundError(proposalId)
  const [memory] = await tx
    .select({ status: memories.status, validTo: memories.validTo })
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.id, open.memoryId)))
    .limit(1)
    .for('update')
  // The compare-and-set still decides a race between two reviewers.
  const proposal = await decideRetentionProposal(tx, userId, proposalId, 'applied')
  if (proposal.action === 'archive') {
    const archived = await archiveMemoryIn(tx, {
      userId,
      memoryId: proposal.memoryId,
      actorKind,
      policy: 'disposition',
    })
    if (archived.outcome === 'rejected') {
      throw new RetentionProposalNotApplicableError(proposalId, archived.reason)
    }
  } else if (proposal.action === 'supersede') {
    if (proposal.relatedMemoryId === null) {
      throw new RetentionProposalNotApplicableError(proposalId, 'no_related_memory')
    }
    // The edge path only checks that the older memory is not yet superseded;
    // an archived one must not be moved into the superseded bucket.
    if (memory?.status !== 'active' || memory.validTo !== null) {
      throw new RetentionProposalNotApplicableError(proposalId, 'memory_not_live')
    }
    await materializeEdgeIn(
      tx,
      userId,
      { fromId: proposal.relatedMemoryId, toId: proposal.memoryId, edgeType: 'supersedes' },
      actorKind,
      proposalId,
    )
  }
  return proposal
}

/**
 * Count the tenant's reviewable retention proposals matching an optional status
 * filter. Dismissed rows are never counted: they are not for review.
 */
export async function countRetentionProposals(
  tx: TenantTx,
  userId: string,
  status?: string,
): Promise<number> {
  const t = retentionProposals
  const [row] = await tx
    .select({ n: count() })
    .from(t)
    .where(
      and(
        eq(t.userId, userId),
        ne(t.status, 'dismissed'),
        status === undefined ? undefined : eq(t.status, status),
      ),
    )
  return row?.n ?? 0
}
