// SPDX-License-Identifier: Apache-2.0
// `review_proposals` V3: resolution proposals join the review surface (issue
// #229) as a THIRD kind, beside edge (consolidation) and fact proposals.
//
// A resolution proposal is the session closer saying "this run plausibly
// completed this briefed commitment" when its typed judgment lands in the mid
// band (LOW <= P(completed) < HIGH): plausible, not certain enough to resolve on
// its own. Accepting one resolves the commitment through the same path a user's
// `resolve` takes; rejecting leaves it open.
//
// THE INPUT IS UNCHANGED (V2's reasoning holds): accept/reject take a bare
// proposalId, ids are uuidv7 and disjoint across all three tables, so the id
// alone says which kind it is. The OUTPUT grows additively: `resolutionProposals`
// appears on a list page only when it is non-empty, `counts`/`totals` gain a
// `resolution` key, and the decisions get their own discriminator literals so a
// client matching on `applied`/`applied_fact` keeps the payload it was written
// against. V1/V2 schemas stay untouched (ADR-0011).
import { z } from 'zod'
import { commitmentStatusSchema } from './commitment.js'
import { proposalStatusSchema } from './consolidation.js'
import { isoDateTime } from './iso-datetime.js'
import { reviewProposalsOutputSchema } from './mcp.js'
import { OPEN_OUTPUT_META } from './output-openness.js'
import { factProposalRecordSchema } from './review-fact-proposals.js'

/** Bounds of a judged probability; the DB CHECK on resolution_proposals is generated from these. */
export const PROBABILITY_BOUNDS = { min: 0, max: 1 } as const

/**
 * One resolution proposal in a tool result. It carries the commitment's memory
 * id (`memoryId`, what `resolve` and `get_memories` key on), the run that
 * produced it, the judged probability, and its lifecycle. No content: the
 * reviewer reads the commitment with `get_memories`.
 */
export const resolutionProposalRecordSchema = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    sessionRunId: z.uuid(),
    probability: z.number().min(PROBABILITY_BOUNDS.min).max(PROBABILITY_BOUNDS.max),
    status: proposalStatusSchema,
    decidedAt: isoDateTime().nullable(),
    createdAt: isoDateTime(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ResolutionProposalRecordOutput = z.infer<typeof resolutionProposalRecordSchema>

const kindCount = z.number().int().min(0)

/** Per-kind counts across all three kinds (`counts` on the page, `totals` live). */
export const proposalKindCountsV3Schema = z
  .object({ edge: kindCount, fact: kindCount, resolution: kindCount })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ProposalKindCountsV3 = z.infer<typeof proposalKindCountsV3Schema>

const [listVariant, rejectedVariant, appliedVariant] = reviewProposalsOutputSchema.options

/**
 * `review_proposals` V3 output: V2 plus the resolution kind. Every V2 rule
 * still holds (`count` is the EDGE count on this page, an empty kind's array is
 * omitted, `nextCursor` exactly when `hasMore`), extended to the third kind.
 */
export const reviewProposalsOutputV3Schema = z.discriminatedUnion('action', [
  listVariant
    .safeExtend({
      factProposals: z.array(factProposalRecordSchema).optional(),
      resolutionProposals: z.array(resolutionProposalRecordSchema).optional(),
      counts: proposalKindCountsV3Schema,
      totals: proposalKindCountsV3Schema,
      hasMore: z.boolean(),
      nextCursor: z.string().min(1).optional(),
    })
    .meta(OPEN_OUTPUT_META)
    .refine((o) => o.count === o.proposals.length && o.counts.edge === o.proposals.length, {
      message: 'count and counts.edge must equal proposals.length',
      path: ['counts', 'edge'],
    })
    .refine((o) => o.counts.fact === (o.factProposals?.length ?? 0), {
      message: 'counts.fact must equal factProposals.length (0 when omitted)',
      path: ['counts', 'fact'],
    })
    .refine((o) => o.counts.resolution === (o.resolutionProposals?.length ?? 0), {
      message: 'counts.resolution must equal resolutionProposals.length (0 when omitted)',
      path: ['counts', 'resolution'],
    })
    .refine((o) => o.factProposals === undefined || o.factProposals.length > 0, {
      message: 'factProposals is omitted, never empty',
      path: ['factProposals'],
    })
    .refine((o) => o.resolutionProposals === undefined || o.resolutionProposals.length > 0, {
      message: 'resolutionProposals is omitted, never empty',
      path: ['resolutionProposals'],
    })
    .refine((o) => (o.nextCursor !== undefined) === o.hasMore, {
      message: 'nextCursor must be present exactly when hasMore is true',
      path: ['nextCursor'],
    }),
  rejectedVariant,
  appliedVariant,
  z
    .object({ action: z.literal('rejected_fact'), proposal: factProposalRecordSchema })
    .strict()
    .meta(OPEN_OUTPUT_META),
  z
    .object({
      action: z.literal('applied_fact'),
      proposal: factProposalRecordSchema,
      factId: z.uuid(),
    })
    .strict()
    .meta(OPEN_OUTPUT_META),
  z
    .object({ action: z.literal('rejected_resolution'), proposal: resolutionProposalRecordSchema })
    .strict()
    .meta(OPEN_OUTPUT_META),
  z
    .object({
      action: z.literal('applied_resolution'),
      proposal: resolutionProposalRecordSchema,
      // The commitment the accept resolved, and the status it now holds.
      commitmentId: z.uuid(),
      commitmentStatus: commitmentStatusSchema,
    })
    .strict()
    .meta(OPEN_OUTPUT_META),
])
export type ReviewProposalsOutputV3 = z.infer<typeof reviewProposalsOutputV3Schema>
