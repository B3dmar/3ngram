// SPDX-License-Identifier: Apache-2.0
// `review_proposals` V2: the shipped review surface EXTENDED so extracted-fact
// proposals are reviewed through the same flow as edge proposals.
//
// Lives beside mcp.ts for the reason remember-facts.ts does: mcp.ts is well past
// the 500-line budget (hard rule 5) and a composed successor is exactly the seam
// where a new module costs nothing. The V1 schemas stay untouched (ADR-0011).
//
// THE DECISION INPUT IS UNCHANGED. accept/reject already take a bare
// proposalId, and ids are uuidv7 and disjoint across the two tables, so the id
// alone says which kind it is — asking the caller to also name the kind would
// be a contract change that buys nothing. (The list input gained an optional
// `cursor` for pagination, issue #320 — see proposals-page.ts.)
import { z } from 'zod'
import { proposalStatusSchema } from './consolidation.js'
import { isoDateTime } from './iso-datetime.js'
import { reviewProposalsOutputSchema } from './mcp.js'
import { memoryTypeSchema } from './memory.js'
import { OPEN_OUTPUT_META } from './output-openness.js'
import { proposalKindCountsSchema } from './proposals-page.js'

/**
 * One extracted-fact proposal in a tool result — what a REVIEWER needs to
 * decide, and nothing else.
 *
 * It carries the claim (`subject`/`predicate`/`value`), where it came from
 * (`memoryId`), how sure the extractor was (`confidence`), when the claim is
 * meant to hold (`validFrom`/`validTo`), and its lifecycle (`status`,
 * `decidedAt`, `createdAt`). `memoryType` and `rationale` mirror the edge
 * record: per-type precision has to stay auditable, and the rationale is the
 * extractor's own justification.
 *
 * `userId` is deliberately absent — RLS already scopes every row to the caller,
 * so echoing the tenant back would be noise. So is the source memory's CONTENT:
 * a reviewer who wants the prose reads it with `get_memories`, and inlining it
 * would make every list response carry an unbounded body.
 */
export const factProposalRecordSchema = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
    memoryType: memoryTypeSchema,
    confidence: z.number().nullable(),
    validFrom: isoDateTime().nullable(),
    validTo: isoDateTime().nullable(),
    rationale: z.string().nullable(),
    status: proposalStatusSchema,
    decidedAt: isoDateTime().nullable(),
    createdAt: isoDateTime(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type FactProposalRecordOutput = z.infer<typeof factProposalRecordSchema>

// The shipped variants, reused rather than restated: deriving them from the V1
// union means a change there cannot silently skip V2.
const [listVariant, rejectedVariant, appliedVariant] = reviewProposalsOutputSchema.options

/**
 * `review_proposals` V2 output.
 *
 * `list` grows an OPTIONAL `factProposals` array. Optional is load-bearing: a
 * page with no fact proposals carries no `factProposals` key at all, so an
 * edge-only client never sees an empty array appear.
 *
 * `list` also carries the pagination envelope (issue #320), additively:
 * `count` KEEPS its shipped meaning — the number of EDGE proposals on this page,
 * never a total. `counts` breaks the page down per kind, `totals` is the live
 * per-kind count of every proposal matching the status filter (as of this
 * page's read, not frozen across pages), `hasMore` says whether rows remain
 * after this page in the merged `created_at DESC, id DESC` order, and
 * `nextCursor` (present exactly when `hasMore`) continues the walk. `limit`
 * bounds the page across BOTH kinds. See proposals-page.ts for the full
 * contract, including concurrent create/decide behaviour.
 *
 * The decision variants are NEW discriminator literals (`rejected_fact` /
 * `applied_fact`) rather than a widened payload on the shipped `rejected` /
 * `applied`. A discriminated union cannot carry two payload shapes under one
 * literal, and a client matching on `applied` must keep getting the edge shape
 * it was written against. `applied_fact` also returns `factId`: applying is the
 * step that materializes a real fact, and the reviewer should not need a second
 * call to find out what it wrote.
 */
export const reviewProposalsOutputV2Schema = z.discriminatedUnion('action', [
  // The openness marker is REAPPLIED on the extended list variant (issue #154):
  // `.safeExtend()` builds a fresh object that does not inherit the base's
  // metadata. The two reused variants already carry it.
  listVariant
    .safeExtend({
      factProposals: z.array(factProposalRecordSchema).optional(),
      // Pagination (issue #320; contract + live-view semantics: proposals-page.ts).
      counts: proposalKindCountsSchema,
      totals: proposalKindCountsSchema,
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
    .refine((o) => o.factProposals === undefined || o.factProposals.length > 0, {
      message: 'factProposals is omitted, never empty',
      path: ['factProposals'],
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
])
export type ReviewProposalsOutputV2 = z.infer<typeof reviewProposalsOutputV2Schema>

/**
 * REGISTRATION output shape for the SDK (permissive: admits every variant). The
 * HANDLER builds and validates the exact result with the strict union above,
 * exactly as the V1 register shape does.
 */
export const reviewProposalsRegisterOutputShapeV2 = {
  action: z.enum(['list', 'rejected', 'applied', 'rejected_fact', 'applied_fact']),
  proposals: z.array(listVariant.shape.proposals.element).optional(),
  factProposals: z.array(factProposalRecordSchema).optional(),
  count: z.number().int().min(0).optional(),
  counts: proposalKindCountsSchema.optional(),
  totals: proposalKindCountsSchema.optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().min(1).optional(),
  proposal: z.union([listVariant.shape.proposals.element, factProposalRecordSchema]).optional(),
  factId: z.uuid().optional(),
} as const
