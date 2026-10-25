// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/**
 * Commitment lifecycle FSM (docs/concepts/data-model.mdx, schema-PR DoD §4).
 * Commitments are their own entity with an explicit state machine — never
 * staged columns on memories (legacy-system tangle #2).
 */
export const commitmentStatusSchema = z.enum(['open', 'waiting', 'resolved', 'expired'])
export type CommitmentStatus = z.infer<typeof commitmentStatusSchema>

/**
 * Legal transitions. This map is the single source of truth: the DB CHECK /
 * trigger is generated from it, and services call canTransition — they never
 * re-encode the rules.
 *
 * resolved → open is `unresolve`; expired → open is a revival.
 */
export const COMMITMENT_TRANSITIONS = {
  open: ['waiting', 'resolved', 'expired'],
  waiting: ['open', 'resolved', 'expired'],
  resolved: ['open'],
  expired: ['open'],
} as const satisfies Record<CommitmentStatus, readonly CommitmentStatus[]>

export function canTransition(from: CommitmentStatus, to: CommitmentStatus): boolean {
  return (COMMITMENT_TRANSITIONS[from] as readonly CommitmentStatus[]).includes(to)
}

/**
 * Upper bound (characters) on the optional `reason` a `resolve` call may carry
 * (issue #234) — "PR #123", "superseded by <id>". The DB length CHECK on
 * `commitments.last_resolution_reason` is generated from this constant, so the
 * two cannot drift.
 */
export const MAX_RESOLUTION_REASON_LENGTH = 500

/**
 * The evidence for ONE commitment transition (issue #234): trimmed, non-empty,
 * at most {@link MAX_RESOLUTION_REASON_LENGTH} characters. It is memory CONTENT
 * (hard rule 6): it is stored on the commitment row and read back only through
 * the authenticated, tenant-scoped history read — never logged, traced or
 * metered (only its length may be).
 */
export const resolutionReasonSchema = z.string().trim().min(1).max(MAX_RESOLUTION_REASON_LENGTH)
