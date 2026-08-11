// SPDX-License-Identifier: Apache-2.0
// Chronological list mode on `search` (exhaustive/chronological retrieval):
// an `order` axis plus a `query` that is required on the ranked variant and
// rejected on the chronological one. A SEPARATE module
// from search-cursor.ts (which owns the V2->V3 cursor + projection contract,
// a distinct concern) and from mcp.ts (already past the 500-line file cap) —
// same one-validation-boundary rule (hard rule 2), same composed-schema
// pattern (ADR-0011: successor schemas compose over shipped ones; shipped
// fields stay byte-identical — V3 is untouched, V4 composes on top of it).
//
// WHY A UNION, NOT ONE OBJECT WITH A CONDITIONALLY-OPTIONAL FIELD (ADR-0011:
// "unions grow by variant"): relaxing `query` from required to optional is a
// WIDENING override, and Zod 4's `.safeExtend()` deliberately REJECTS that at
// compile time — it only allows overriding an existing key with an
// ASSIGNABLE (narrower-or-equal) type, precisely to stop a composed schema
// from silently loosening a shipped constraint. `.omit()` was the other
// candidate for dropping `query` before re-adding it optionally, but Zod 4's
// `.omit()` THROWS AT RUNTIME on any schema carrying refinements — and V3
// inherits V2's superRefine (memoryType/memoryTypes exclusion + recorded-range
// sanity). So `query` is relaxed only inside a SEPARATE chronological-order
// variant schema (built independently, not via extend/omit on V3), unioned
// with a relevance-order variant that stays query-required and inherits V3
// untouched via safeExtend (a plain field ADD, which safeExtend allows freely).
import { z } from 'zod'
import { recordedRangeIssues } from './recorded-range.js'
import { searchQueryV3Schema } from './search-cursor.js'

/**
 * Retrieval order for `search`. `relevance` (default) is the shipped fused
 * ranking (query required). `chronological` is an EXHAUSTIVE, unranked
 * enumeration in `recorded_at DESC` order — no fusion, no embedding call, no
 * abstention signal (nothing gates on a cosine score that was never
 * computed) — so `query` is not merely optional there but REJECTED, and at
 * least one filter is required in its place.
 */
export const searchOrderSchema = z.enum(['relevance', 'chronological']).default('relevance')
export type SearchOrder = z.infer<typeof searchOrderSchema>

/** Every candidate-narrowing filter axis `search` accepts (V1 + V2); chronological order requires at least one of them. */
const FILTER_KEYS = [
  'memoryType',
  'memoryTypes',
  'scope',
  'project',
  'status',
  'asOf',
  'recordedAfter',
  'recordedBefore',
] as const

/**
 * Relevance-order V4: the shipped {@link searchQueryV3Schema} plus `order`
 * pinned to the `'relevance'` literal (defaulted, so an absent `order` still
 * means relevance — byte-identical to the pre-V4 caller experience). `order`
 * is a BRAND NEW field, not an override of an existing one, so `.safeExtend()`
 * applies cleanly and every V2/V3 refinement (cursor/projection shape,
 * memoryType/memoryTypes exclusion, recorded-range sanity) carries through
 * the composition unchanged.
 */
export const searchQueryV4RelevanceSchema = searchQueryV3Schema.safeExtend({
  order: z
    .literal('relevance')
    .default('relevance')
    .describe(
      "Retrieval order: 'relevance' (default) is the fused ranked search — query required.",
    ),
})
export type SearchQueryV4RelevanceInput = z.infer<typeof searchQueryV4RelevanceSchema>

/**
 * Chronological-order V4: an INDEPENDENT object built over the SAME per-field
 * schemas as V3 (spread from `searchQueryV3Schema.shape` — a plain object
 * read, not a Zod `.extend()`/`.omit()` call, so neither's guard applies),
 * with `query` relaxed to optional in the SHAPE only (so the refine below can
 * reject it by name rather than as an unrecognized key) and V2's refinements
 * manually re-applied:
 * `recordedRangeIssues` is the SAME shared, zod-free helper V2 calls (issue
 * #58), so the range-sanity rule can never drift between the two query
 * schemas; the memoryType/memoryTypes mutual-exclusion check is duplicated
 * inline (V2's own superRefine is not reusable as a standalone function, only
 * as a schema method, unlike the extracted range-issue helper).
 */
export const searchQueryV4ChronologicalSchema = z
  .object({
    ...searchQueryV3Schema.shape,
    // KEPT IN THE SHAPE, THEN REJECTED BY THE REFINE — deliberately not dropped.
    // `.strict()` would turn a passed `query` into an "unrecognized key"
    // error, and inside a union that surfaces as an unreadable no-variant-matched
    // dump. Declaring the key optional and rejecting it in the superRefine below
    // buys a targeted, actionable message on the `query` path instead.
    query: searchQueryV3Schema.shape.query
      .optional()
      .describe(
        'NOT ACCEPTED in chronological order — this mode never ranks, so a query would be silently ignored. Omit it and narrow with at least one filter, or use order: "relevance" for ranked search.',
      ),
    order: z
      .literal('chronological')
      .describe(
        'Retrieval order: chronological is an exhaustive, unranked recorded_at DESC listing — no embedding call, no vector/abstention signal.',
      ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.memoryType !== undefined && v.memoryTypes !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['memoryTypes'],
        message: 'memoryTypes is mutually exclusive with memoryType — pass one or the other',
      })
    }
    for (const issue of recordedRangeIssues(v)) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message })
    }
    // A `query` here is REJECTED, never accepted-and-ignored. The chronological
    // core path (packages/core/src/read/search-list.ts) takes no query argument
    // at all — it is a filtered enumeration, not a ranked retrieval — so a
    // caller who passed one previously got the WHOLE live corpus back under the
    // impression it had been searched. Failing loudly is the only honest
    // outcome: silently discarding a caller's search term is a correctness bug,
    // not a convenience.
    if (v.query !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message:
          "query is not used in chronological order — remove it, or use order:'relevance' for ranked search",
      })
    }
    // With `query` no longer a legal bound, at least one filter is now
    // MANDATORY: it is the only thing left that can bound an exhaustive scan.
    if (!FILTER_KEYS.some((key) => v[key] !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['order'],
        message: `chronological order requires at least one filter (${FILTER_KEYS.join(', ')}) — an unfiltered exhaustive scan has nothing bounding it`,
      })
    }
  })
export type SearchQueryV4ChronologicalInput = z.infer<typeof searchQueryV4ChronologicalSchema>

/**
 * The V4 search query contract: relevance (query REQUIRED, the shipped
 * default) or chronological (query REJECTED, >=1 filter REQUIRED). The two
 * variants are disjoint on `order`, and the chronological one rejects both a
 * present `query` and a filter-less call with a targeted message on the
 * offending path, so the union's failure mode is an actionable error rather
 * than a "no variant matched" dump.
 */
export const searchQueryV4Schema = z.union([
  searchQueryV4RelevanceSchema,
  searchQueryV4ChronologicalSchema,
])
export type SearchQueryV4Input = z.infer<typeof searchQueryV4Schema>
/**
 * Caller-side (pre-parse) shape: `z.input` where the defaulted `limit`,
 * `projection`, and `order` are OPTIONAL. See RememberToolArgs (mcp.ts) for
 * the pattern.
 */
export type SearchQueryV4Args = z.input<typeof searchQueryV4Schema>
