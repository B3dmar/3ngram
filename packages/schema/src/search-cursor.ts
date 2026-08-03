// SPDX-License-Identifier: Apache-2.0
// search cursor pagination + compact projection (issue #49, epic #42).
//
// The MCP search continuation contract: V3 composes cursor + projection onto
// the shipped V2 query schema, and the V2 output envelope composes
// nextCursor/hasMore onto the shipped output. A SEPARATE module from mcp.ts
// (which is past the 500-line file cap) so the contract stays bounded and
// reviewable (same precedent as get-memories.ts) — same one-validation-boundary
// rules (hard rule 2), same composed-schema pattern (ADR-0011: successor
// schemas compose over shipped ones; shipped fields stay byte-identical).
//
// The cursor VALUE is opaque here: its decoded payload shape is
// cursorPayloadSchema (cursor.ts) and the base64url codec is Node-side in
// apps/server (apps/server/src/cursor.ts, shared by REST and MCP). This module
// only carries the transport-level string field.
import { z } from 'zod'
import { MAX_SEARCH_LIMIT, searchHitSchema, searchQueryV2Schema } from './mcp.js'

/**
 * Per-hit output projection. `full` (the default — byte-identical to the
 * shipped V2 behavior) returns the excerpt triple on every hit; `compact`
 * omits `content`/`contentLength`/`truncated`, cutting a broad scan's token
 * cost ~5x. The workflow compact enables: scan compact, then batch-fetch the
 * interesting ids with get_memories (get-memories.ts).
 */
export const searchProjectionSchema = z.enum(['full', 'compact']).default('full')
export type SearchProjection = z.infer<typeof searchProjectionSchema>

/**
 * The V3 search query contract: the shipped {@link searchQueryV2Schema}
 * EXTENDED with continuation + projection — the same composition pattern as
 * V2-over-V1, one validation boundary (hard rule 2). V2's superRefine
 * constraints (memoryType/memoryTypes mutual exclusion, recorded_at range
 * sanity) carry through the composition — Zod 4 stores refinements inside the
 * schema, and the tests pin that they still reject through V3.
 *
 * `cursor` is the opaque continuation token a previous page returned as
 * `nextCursor` (frozen-ordering v2 cursor, cursor.ts): a continuation pages BY
 * POSITION within the ordering frozen at page 1, so mid-session corpus drift
 * can neither duplicate nor skip a hit. Absent on the first page. The token is
 * validated ON DECODE in apps/server (a garbled token is a loud validation
 * error, never a silent page-1 restart); here it is a non-empty string.
 */
export const searchQueryV3Schema = searchQueryV2Schema
  .extend({
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Opaque continuation token from a previous page’s nextCursor. Omit for the first page. Keep query and filters identical across pages of one walk.',
      ),
    projection: searchProjectionSchema.describe(
      'Per-hit output shape: full (default) includes the content excerpt; compact omits content/contentLength/truncated for cheap broad scans — batch-fetch interesting ids with get_memories.',
    ),
  })
  .strict()
export type SearchQueryV3Input = z.infer<typeof searchQueryV3Schema>
/**
 * Caller-side (pre-parse) shape: `z.input` where the defaulted `limit` and
 * `projection` are OPTIONAL. See RememberToolArgs (mcp.ts) for the pattern.
 */
export type SearchQueryV3Args = z.input<typeof searchQueryV3Schema>

/**
 * A compact-projection hit: the shipped {@link searchHitSchema} MINUS the
 * excerpt triple (`content`/`contentLength`/`truncated`). id/type/topic/score
 * are enough to decide what to read; get_memories fetches the bodies.
 */
export const searchHitCompactSchema = searchHitSchema.omit({
  content: true,
  contentLength: true,
  truncated: true,
})
export type SearchHitCompactOutput = z.infer<typeof searchHitCompactSchema>

/**
 * The V2 search output envelope: the shipped hits+count PLUS the continuation
 * pair. `hits` admits both projections (full hits under `full`, compact hits
 * under `compact` — one projection per response, chosen by the input).
 *
 * CONSISTENCY (enforced, not advisory): `count` must equal `hits.length`, and
 * `nextCursor` is present IFF `hasMore` is true — a page that advertises more
 * always carries the token to get it, and a final page never dangles one.
 */
export const searchToolOutputV2Schema = z
  .object({
    hits: z.array(z.union([searchHitSchema, searchHitCompactSchema])).max(MAX_SEARCH_LIMIT),
    count: z.number().int().min(0),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).optional(),
  })
  .strict()
  .refine((o) => o.count === o.hits.length, {
    message: 'count must equal hits.length',
    path: ['count'],
  })
  .refine((o) => (o.nextCursor !== undefined) === o.hasMore, {
    message: 'nextCursor must be present exactly when hasMore is true',
    path: ['nextCursor'],
  })
export type SearchToolOutputV2 = z.infer<typeof searchToolOutputV2Schema>
