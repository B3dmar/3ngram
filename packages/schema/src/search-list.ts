// SPDX-License-Identifier: Apache-2.0
// Chronological list mode on `search` (exhaustive/chronological retrieval):
// an `order` axis plus a conditionally-optional `query`. A SEPARATE module
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
 * computed) — so `query` becomes conditionally optional there.
 */
export const searchOrderSchema = z.enum(['relevance', 'chronological']).default('relevance')
export type SearchOrder = z.infer<typeof searchOrderSchema>

/** Every candidate-narrowing filter axis `search` accepts (V1 + V2), for the query-optional check below. */
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
 * with `query` relaxed to optional and V2's refinements manually re-applied:
 * `recordedRangeIssues` is the SAME shared, zod-free helper V2 calls (issue
 * #58), so the range-sanity rule can never drift between the two query
 * schemas; the memoryType/memoryTypes mutual-exclusion check is duplicated
 * inline (V2's own superRefine is not reusable as a standalone function, only
 * as a schema method, unlike the extracted range-issue helper).
 */
export const searchQueryV4ChronologicalSchema = z
  .object({
    ...searchQueryV3Schema.shape,
    query: searchQueryV3Schema.shape.query
      .optional()
      .describe(
        'Optional IF at least one filter narrows the candidate set — omitting both query and every filter is rejected (nothing bounds the scan).',
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
    if (v.query === undefined && !FILTER_KEYS.some((key) => v[key] !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message:
          'query is required when order is chronological with no filters — an unfiltered exhaustive scan has nothing bounding it',
      })
    }
  })
export type SearchQueryV4ChronologicalInput = z.infer<typeof searchQueryV4ChronologicalSchema>

/**
 * The V4 search query contract: relevance (query required, the shipped
 * default) or chronological (query optional given >=1 filter). A caller that
 * passes `order: 'chronological'` with neither `query` nor any filter is
 * rejected by the chronological variant with a clear message, so the union's
 * failure mode is a targeted error, not a "no variant matched" dump.
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
