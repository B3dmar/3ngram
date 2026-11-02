// SPDX-License-Identifier: Apache-2.0
// `review_proposals` V4: retention proposals join the review surface as a
// FOURTH kind, beside edge, fact and resolution proposals
// (docs/concepts/forgetting-pass.mdx).
//
// A retention proposal is the forgetting pass saying that a memory is
// finished: archive it, let a newer memory supersede it, or decide a conflict
// between two live memories. Accepting applies the verdict as the reviewer.
// Keep verdicts and verdicts below their threshold are stored dismissed and
// never appear here.
//
// THE INPUT AND THE DESCRIPTION ARE UNCHANGED (the V3 reasoning holds):
// accept and reject take a bare proposalId, and ids are uuidv7 and disjoint
// across all four tables, so the id alone says which kind it is. The OUTPUT
// grows additively: `retentionProposals` appears on a list page only when it is
// non-empty, `counts` and `totals` gain a `retention` key, and the decisions
// get their own discriminator literals. V1 to V3 stay untouched (ADR-0011).
import { z } from 'zod'
import { proposalStatusSchema } from './consolidation.js'
import { isoDateTime } from './iso-datetime.js'
import { OPEN_OUTPUT_META } from './output-openness.js'
import { retentionActionSchema } from './retention.js'
import { PROBABILITY_BOUNDS, reviewProposalsOutputV3Schema } from './review-resolution-proposals.js'

/**
 * One retention proposal in a tool result: the judged memory, the verdict, the
 * related memory for supersede (the newer one) and conflict (the other side),
 * the judge's probability and model, and the lifecycle. No content: the
 * reviewer reads the memories with `get_memories`.
 */
export const retentionProposalRecordSchema = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    action: retentionActionSchema,
    relatedMemoryId: z.uuid().nullable(),
    probability: z.number().min(PROBABILITY_BOUNDS.min).max(PROBABILITY_BOUNDS.max),
    model: z.string(),
    status: proposalStatusSchema,
    decidedAt: isoDateTime().nullable(),
    createdAt: isoDateTime(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type RetentionProposalRecordOutput = z.infer<typeof retentionProposalRecordSchema>

const kindCount = z.number().int().min(0)

/** Per-kind counts across all four kinds (`counts` on the page, `totals` live). */
export const proposalKindCountsV4Schema = z
  .object({ edge: kindCount, fact: kindCount, resolution: kindCount, retention: kindCount })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ProposalKindCountsV4 = z.infer<typeof proposalKindCountsV4Schema>

const [listV3, ...decisionsV3] = reviewProposalsOutputV3Schema.options

/**
 * `review_proposals` V4 output: V3 plus the retention kind. Every V3 rule still
 * holds, extended to the fourth kind.
 */
export const reviewProposalsOutputV4Schema = z.discriminatedUnion('action', [
  listV3
    .safeExtend({
      retentionProposals: z.array(retentionProposalRecordSchema).optional(),
      counts: proposalKindCountsV4Schema,
      totals: proposalKindCountsV4Schema,
    })
    .meta(OPEN_OUTPUT_META)
    .refine((o) => o.counts.retention === (o.retentionProposals?.length ?? 0), {
      message: 'counts.retention must equal retentionProposals.length (0 when omitted)',
      path: ['counts', 'retention'],
    })
    .refine((o) => o.retentionProposals === undefined || o.retentionProposals.length > 0, {
      message: 'retentionProposals is omitted, never empty',
      path: ['retentionProposals'],
    }),
  ...decisionsV3,
  z
    .object({ action: z.literal('rejected_retention'), proposal: retentionProposalRecordSchema })
    .strict()
    .meta(OPEN_OUTPUT_META),
  z
    .object({ action: z.literal('applied_retention'), proposal: retentionProposalRecordSchema })
    .strict()
    .meta(OPEN_OUTPUT_META),
])
export type ReviewProposalsOutputV4 = z.infer<typeof reviewProposalsOutputV4Schema>
