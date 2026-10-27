// SPDX-License-Identifier: Apache-2.0
// Retention verdicts of the forgetting pass (docs/concepts/forgetting-pass.mdx).
//
// The judge's typed verdict about one memory, and the lifecycle of the
// retention proposal that stores it. The CHECKs on `retention_proposals` are
// generated from these enums, so the table and the schema cannot drift.
import { z } from 'zod'

/**
 * What the judge says about one memory:
 * - `keep`: still valid as a standing memory;
 * - `archive`: no longer true, or no longer useful as a standing memory;
 * - `supersede`: a newer live memory states the same thing more currently;
 * - `conflict`: two live memories contradict, and a human must choose.
 */
export const retentionActionSchema = z.enum(['keep', 'archive', 'supersede', 'conflict'])
export type RetentionAction = z.infer<typeof retentionActionSchema>

/** The actions that name a second memory, stored as `related_memory_id`. */
export const RETENTION_ACTIONS_WITH_RELATED = [
  'supersede',
  'conflict',
] as const satisfies readonly RetentionAction[]

/**
 * A retention proposal's lifecycle: `proposed`, `applied` and `rejected` as for
 * every proposal kind, plus `dismissed` for a keep verdict. A dismissed row is
 * never listed for review. It only stops the pass from judging the memory again
 * until the memory's freshness moves past the verdict.
 */
export const retentionProposalStatusSchema = z.enum([
  'proposed',
  'applied',
  'rejected',
  'dismissed',
])
export type RetentionProposalStatus = z.infer<typeof retentionProposalStatusSchema>
