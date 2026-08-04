// SPDX-License-Identifier: Apache-2.0
// get_memories — batched full-content read ("read what I found").
//
// The MCP tool I/O contract for the follow-up read of ids a search/handoff
// surfaced with `truncated: true`. A SEPARATE module from mcp.ts (which is
// already past the 500-line file cap) so the contract stays bounded and
// reviewable — same one-validation-boundary rules as mcp.ts (hard rule 2),
// same output size discipline (docs/concepts/mcp-design.mdx).
import { z } from 'zod'
import { commitmentStatusSchema } from './commitment.js'
import { MAX_IMPORT_CONTENT_LENGTH } from './import.js'
import { MAX_EXCERPT_LENGTH } from './mcp.js'
import { memoryStatusSchema, memoryTypeSchema } from './memory.js'
import { scopeSchema } from './scope.js'
import { projectSchema } from './write.js'

/**
 * Upper bound on a get_memories id batch. A follow-up read fans out over the
 * ids a search/handoff surfaced — MAX_SEARCH_LIMIT is 25 hits, and a caller
 * chasing full bodies wants a handful, not a page dump. 20 keeps the worst-case
 * result (jointly bounded with {@link MAX_GET_TOTAL_CHARS}) while covering any
 * realistic "expand these hits" turn.
 */
export const MAX_GET_MEMORIES_IDS = 20
/**
 * Floor for the per-item content bound a caller may request: exactly
 * {@link MAX_EXCERPT_LENGTH}. A get_memories call EXPANDS a truncated
 * search/handoff excerpt — a floor below the excerpt cap would let a "full
 * content" read return LESS than the excerpt the caller already holds, which
 * is never the JTBD.
 */
export const MIN_GET_CONTENT_CHARS = MAX_EXCERPT_LENGTH
/**
 * Ceiling for the per-item content bound. Import rows reach
 * MAX_IMPORT_CONTENT_LENGTH (262,144 chars) — echoing one verbatim into an MCP
 * result is the firehose the output discipline exists to prevent
 * (docs/concepts/mcp-design.mdx). 65,536 covers every natively-written row
 * (write cap 2,000) and all but the extreme import tail; a caller needing the
 * unbounded body reads GET /api/v1/memories/:id (unbounded by design).
 */
export const MAX_GET_CONTENT_CHARS = 65536
/**
 * Default per-item content bound: ~10K chars carries a full document-scale
 * memory without ballooning a multi-id result. `truncated` + `contentLength`
 * tell the caller when to raise `maxContentChars` (or go to REST) for the rest.
 */
export const DEFAULT_GET_CONTENT_CHARS = 10000
/**
 * Aggregate response budget: `ids.length × maxContentChars` may not exceed
 * this. The per-item ceiling alone still admits a 20 × 65,536 = 1.31M-char
 * response — an order of magnitude past any bounded-output intent. Pinned to
 * MAX_IMPORT_CONTENT_LENGTH (262,144): "one worst-case import row per call" —
 * the largest single body the system ever stores is the most a single
 * batched read may return in total. The default (20 × 10,000 = 200,000) fits;
 * a caller wanting the 65,536 ceiling narrows the batch to ≤ 4 ids.
 */
export const MAX_GET_TOTAL_CHARS = MAX_IMPORT_CONTENT_LENGTH

/**
 * `get_memories` input — fetch FULL (bounded) content for ids the caller
 * already holds, the follow-up read for a search/handoff line that came back
 * `truncated: true`. `ids` is a non-empty, bounded batch (no-firehose);
 * `maxContentChars` is the caller-tunable per-item content bound, defaulted at
 * this ONE validation boundary (hard rule 2) so every surface shares the same
 * bound. The cross-field refinement bounds the AGGREGATE response
 * ({@link MAX_GET_TOTAL_CHARS}); `.strict()` rejects unknown keys.
 */
export const getMemoriesInputSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(MAX_GET_MEMORIES_IDS),
    maxContentChars: z
      .number()
      .int()
      .min(MIN_GET_CONTENT_CHARS)
      .max(MAX_GET_CONTENT_CHARS)
      .default(DEFAULT_GET_CONTENT_CHARS),
  })
  .strict()
  .refine((input) => input.ids.length * input.maxContentChars <= MAX_GET_TOTAL_CHARS, {
    message: `ids.length × maxContentChars must not exceed ${MAX_GET_TOTAL_CHARS} — request fewer ids or a smaller maxContentChars`,
    path: ['maxContentChars'],
  })
export type GetMemoriesInput = z.infer<typeof getMemoriesInputSchema>
/**
 * Caller-side (pre-parse) shape: `z.input` where the defaulted `maxContentChars`
 * is OPTIONAL. See RememberToolArgs (mcp.ts) for the pattern.
 */
export type GetMemoriesArgs = z.input<typeof getMemoriesInputSchema>

/**
 * One fetched memory — the REST memoryDetailSchema field set (rest.ts) with the
 * SAME excerpting triple every bounded read surface carries: `content` is cut
 * to the requested `maxContentChars` (schema bound: the ceiling,
 * {@link MAX_GET_CONTENT_CHARS}), `contentLength` is the FULL stored length,
 * and `truncated` flags a cut (the text then ends with EXCERPT_MARKER, mcp.ts).
 * `commitmentStatus` is present only for a commitment-type memory (REST
 * detail parity).
 */
export const getMemoriesItemSchema = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string(),
    content: z.string().max(MAX_GET_CONTENT_CHARS),
    contentLength: z.number().int().min(0),
    truncated: z.boolean(),
    scope: scopeSchema,
    project: projectSchema.nullable(),
    status: memoryStatusSchema,
    commitmentStatus: commitmentStatusSchema.optional(),
    tags: z.array(z.string()),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    recordedAt: z.iso.datetime(),
  })
  .strict()
export type GetMemoriesItemOutput = z.infer<typeof getMemoriesItemSchema>

/**
 * `get_memories` output envelope. `memories` carries the found rows (bounded by
 * the input batch size); `count` mirrors `memories.length` — ENFORCED by the
 * refinement, so a drifting count can never reach a caller; `notFound` lists
 * the requested ids that resolved to no row for THIS tenant — unknown and
 * cross-tenant ids land here identically (RLS + the caller-bound predicate
 * collapse them), so the result never leaks whether a foreign id exists. A
 * miss is DATA, never an error: one bad id must not fail the batch.
 */
export const getMemoriesOutputSchema = z
  .object({
    memories: z.array(getMemoriesItemSchema).max(MAX_GET_MEMORIES_IDS),
    count: z.number().int().min(0),
    notFound: z.array(z.uuid()).max(MAX_GET_MEMORIES_IDS),
  })
  .strict()
  .refine((output) => output.count === output.memories.length, {
    message: 'count must equal memories.length',
    path: ['count'],
  })
export type GetMemoriesOutput = z.infer<typeof getMemoriesOutputSchema>
