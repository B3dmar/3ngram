// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'
import type { EdgeType, MemoryType } from './memory.js'

/** Lifecycle of a background-worker consolidation proposal (docs/concepts/memory-model.mdx "Consolidation is advisory"). */
export const proposalStatusSchema = z.enum(['proposed', 'applied', 'rejected'])
export type ProposalStatus = z.infer<typeof proposalStatusSchema>

export interface ConsolidationPolicy {
  /**
   * May proposals for this memory type ever be auto-applied (above the
   * per-type precision bar proven on the golden set)? When false, every
   * proposal requires explicit review.
   */
  readonly autoEdgeEligible: boolean
  /** Edge types the worker may propose for this memory type. */
  readonly proposableEdges: readonly EdgeType[]
}

/**
 * Type-aware consolidation policy (docs/concepts/memory-model.mdx "Consolidation is advisory").
 *
 * Episodic memories (`event`) are NEVER auto-edge eligible, regardless of
 * similarity: recurring entries (daily digests, session debriefs) are
 * textually near-identical by construction — a large share of the legacy
 * system's destructive merges hit exactly this class. They may at most receive
 * advisory `extends` proposals.
 *
 * Auto-edge eligibility starts true only for semantic types (fact,
 * preference) and remains gated at runtime by the measured per-type
 * precision bar.
 */
export const CONSOLIDATION_POLICIES = {
  fact: {
    autoEdgeEligible: true,
    proposableEdges: ['supersedes', 'updates', 'extends', 'derives'],
  },
  preference: { autoEdgeEligible: true, proposableEdges: ['supersedes', 'updates'] },
  decision: {
    autoEdgeEligible: false,
    proposableEdges: ['supersedes', 'updates', 'extends', 'derives'],
  },
  commitment: { autoEdgeEligible: false, proposableEdges: ['supersedes', 'updates', 'extends'] },
  blocker: { autoEdgeEligible: false, proposableEdges: ['supersedes', 'updates', 'extends'] },
  pattern: {
    autoEdgeEligible: false,
    proposableEdges: ['supersedes', 'updates', 'extends', 'derives'],
  },
  note: {
    autoEdgeEligible: false,
    proposableEdges: ['supersedes', 'updates', 'extends', 'derives'],
  },
  event: { autoEdgeEligible: false, proposableEdges: ['extends'] },
} as const satisfies Record<MemoryType, ConsolidationPolicy>

/** The S1 invariant, type-level: `event` can never become auto-eligible without breaking the build. */
type EventNeverAutoEdges =
  (typeof CONSOLIDATION_POLICIES)['event']['autoEdgeEligible'] extends false ? true : never
const _eventNeverAutoEdges: EventNeverAutoEdges = true
void _eventNeverAutoEdges
