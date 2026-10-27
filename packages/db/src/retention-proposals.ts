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
// DELETE, so every verdict survives as its own audit trail. Listing and
// deciding proposals arrive with the review_proposals `retention` kind.
//
// Observability (hard rule 6): ids, probabilities, enum states and a model
// name only. The table has no user text, and this module logs nothing.
import type { RetentionAction, RetentionProposalStatus } from '@3ngram/schema'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { TenantTx } from './client.js'
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
}

/**
 * A choice key is an action name, optionally with an item ref
 * (`keep`, `archive_older`, `supersede_by:s0n0`). Never memory text: the table
 * must hold no user text, which is why account erasure can leave it alone.
 */
const PROBABILITY_KEY = /^[a-z_]+(:[a-z0-9]+)?$/

/** A keep verdict is recorded but never listed; every other verdict waits for review. */
function statusFor(action: RetentionAction): RetentionProposalStatus {
  return action === 'keep' ? 'dismissed' : 'proposed'
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
 * A keep verdict is stored `dismissed` with no `decided_at`, since no reviewer
 * decided it. Dismissed rows are not deduplicated; the pass's candidate query
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
        status: statusFor(v.action),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: retentionProposals.id })
  return rows.length
}
