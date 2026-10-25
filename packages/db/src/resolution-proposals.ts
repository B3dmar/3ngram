// SPDX-License-Identifier: Apache-2.0
// Resolution-proposal review layer (issue #229): insert (the closer's side),
// read one open proposal, and decide (apply/reject).
//
// SQL ONLY (hard rule 5): which commitments to propose, and what accepting one
// means (a commitment transition through core's resolve path), are policy in
// packages/core. Every query runs inside the caller's withTenant() transaction
// AND binds the caller's user_id (the fact-proposals.ts discipline).
//
// A decision flips `status` and stamps `decided_at`; the runtime role has
// INSERT, SELECT and UPDATE on resolution_proposals and NO DELETE, so the row
// survives as its own audit trail.
//
// Observability (hard rule 6): ids, probabilities and enum states only — this
// table has no text columns, and this module logs nothing.
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { ProposalNotFoundError } from './proposals-read.js'
import { commitments, resolutionProposals } from './schema/memory.js'

/** A resolution proposal as returned to a reviewer. */
export interface ResolutionProposalRow {
  id: string
  memoryId: string
  sessionRunId: string
  probability: number
  status: string
  decidedAt: Date | null
  createdAt: Date
}

/** Shared projection so every read and decision returns the identical row shape. */
export const RESOLUTION_PROPOSAL_COLUMNS = {
  id: resolutionProposals.id,
  memoryId: resolutionProposals.memoryId,
  sessionRunId: resolutionProposals.sessionRunId,
  probability: resolutionProposals.probability,
  status: resolutionProposals.status,
  decidedAt: resolutionProposals.decidedAt,
  createdAt: resolutionProposals.createdAt,
} as const

/** One candidate: the commitment's memory id and the judged P(completed). */
export interface ResolutionProposalWrite {
  memoryId: string
  probability: number
}

/** Commitment states a proposal can still be accepted from (resolved is reachable). */
const PROPOSABLE_COMMITMENT_STATUSES = ['open', 'waiting'] as const

/**
 * Stage proposals for one closed run, in the caller's transaction.
 *
 * Only candidates whose COMMITMENT is still open or waiting are staged: the
 * closer's judgment can be stale by the time it returns (another session may
 * have resolved or expired the commitment), and a proposal over an expired
 * commitment could never be accepted. A memory with no commitment (a blocker)
 * is never staged at all. Then a candidate is skipped if the commitment already
 * has an OPEN proposal (`resolution_proposals_open_idx`) or this run already
 * proposed it in any state (`resolution_proposals_run_memory_uq`, so a retried
 * pass cannot re-stage what a reviewer decided in between): the target-less
 * ON CONFLICT DO NOTHING covers both unique indexes. Returns rows inserted.
 */
export async function insertResolutionProposals(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
  candidates: readonly ResolutionProposalWrite[],
): Promise<number> {
  if (candidates.length === 0) return 0
  const live = await tx
    .select({ memoryId: commitments.memoryId })
    .from(commitments)
    .where(
      and(
        eq(commitments.userId, userId),
        inArray(
          commitments.memoryId,
          candidates.map((c) => c.memoryId),
        ),
        inArray(commitments.status, [...PROPOSABLE_COMMITMENT_STATUSES]),
      ),
    )
  const proposable = new Set(live.map((row) => row.memoryId))
  const staged = candidates.filter((c) => proposable.has(c.memoryId))
  if (staged.length === 0) return 0
  const rows = await tx
    .insert(resolutionProposals)
    .values(
      staged.map((c) => ({
        userId,
        memoryId: c.memoryId,
        sessionRunId,
        probability: c.probability,
        status: 'proposed' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: resolutionProposals.id })
  return rows.length
}

/** The OPEN proposal with this id, or ProposalNotFoundError (missing, decided, other tenant). */
export async function getOpenResolutionProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
): Promise<ResolutionProposalRow> {
  const [row] = await tx
    .select(RESOLUTION_PROPOSAL_COLUMNS)
    .from(resolutionProposals)
    .where(
      and(
        eq(resolutionProposals.userId, userId),
        eq(resolutionProposals.id, proposalId),
        eq(resolutionProposals.status, 'proposed'),
      ),
    )
    .limit(1)
  if (row === undefined) throw new ProposalNotFoundError(proposalId)
  return row
}

/**
 * Decide an OPEN proposal: proposed -> applied | rejected, a compare-and-set on
 * `status`. Missing, already-decided or another tenant's -> ProposalNotFoundError,
 * so two concurrent decisions cannot both succeed.
 */
export async function decideResolutionProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
  status: 'applied' | 'rejected',
): Promise<ResolutionProposalRow> {
  const [row] = await tx
    .update(resolutionProposals)
    .set({ status, decidedAt: sql`now()` })
    .where(
      and(
        eq(resolutionProposals.userId, userId),
        eq(resolutionProposals.id, proposalId),
        eq(resolutionProposals.status, 'proposed'),
      ),
    )
    .returning(RESOLUTION_PROPOSAL_COLUMNS)
  if (row === undefined) throw new ProposalNotFoundError(proposalId)
  return row
}

/**
 * Undo an accept's claim (applied -> proposed) when the commitment transition it
 * claimed for then failed, so the proposal is open again for a reviewer to
 * reject or retry. A compare-and-set: a no-op unless this row is `applied`.
 */
export async function reopenResolutionProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
): Promise<void> {
  await tx
    .update(resolutionProposals)
    .set({ status: 'proposed', decidedAt: null })
    .where(
      and(
        eq(resolutionProposals.userId, userId),
        eq(resolutionProposals.id, proposalId),
        eq(resolutionProposals.status, 'applied'),
      ),
    )
}

/** Count the tenant's resolution proposals matching an optional status filter. */
export async function countResolutionProposals(
  tx: TenantTx,
  userId: string,
  status?: string,
): Promise<number> {
  const t = resolutionProposals
  const [row] = await tx
    .select({ n: count() })
    .from(t)
    .where(and(eq(t.userId, userId), status === undefined ? undefined : eq(t.status, status)))
  return row?.n ?? 0
}
