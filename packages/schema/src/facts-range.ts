// SPDX-License-Identifier: Apache-2.0
// get_facts range read (time-series reads over bi-temporal facts). A
// SEPARATE module from mcp.ts (past the 500-line file cap) so the composed
// contract stays bounded and reviewable — same precedent as search-cursor.ts
// and briefing-bounds.ts: successor schemas compose beside the shipped one
// (ADR-0011), never edit the shipped shape in place.
import { z } from 'zod'
import { factsQueryInputSchema } from './mcp.js'
import {
  exceedsRecordedBoundPrecision,
  MAX_RECORDED_BOUND_FRACTION_DIGITS,
} from './recorded-range.js'

/**
 * A half-open VALID-TIME window `[from, to)` for a time-series `get_facts`
 * read. Both bounds are individually optional, but an EMPTY `range: {}` is
 * REJECTED — mirrors `asOfSchema`'s "at least one coordinate" refine
 * (mcp.ts): an empty object would silently lift the live-only default while
 * supplying no window at all, the same footgun asOfSchema already guards
 * against. `from`/`to` are each inclusive-of-their-side-of-the-window ISO
 * datetimes; the db layer's overlap predicate treats `to` as exclusive
 * (half-open), matching how valid_to itself works on the facts row.
 *
 * PRECISION (issue #58 item 2, same bug class as the search recorded-range
 * fix — recorded-range.ts): a bound with more than
 * {@link MAX_RECORDED_BOUND_FRACTION_DIGITS} fractional-second digits is
 * REJECTED rather than silently truncated. Both transports convert a bound to
 * a JS `Date` before it reaches SQL, and JS Dates hold millisecond precision
 * while Postgres stores `valid_from`/`valid_to` at microsecond precision — a
 * sub-ms `from` would truncate UP to the next whole millisecond, so a
 * generation that ended a few microseconds earlier could leak back into the
 * window (the half-open guarantee only holds on ms-aligned instants). Reuses
 * {@link exceedsRecordedBoundPrecision} from recorded-range.ts (the check
 * itself is field-name-agnostic); `recordedRangeIssues` is NOT reused because
 * it's hardcoded to the recordedAfter/recordedBefore field pair and that
 * module's inclusive-both-bounds range semantics, both of which differ here.
 */
export const factsRangeSchema = z
  .object({
    from: z.iso
      .datetime()
      .describe(
        `Inclusive lower bound on valid_from (valid-time window). Use at most ${MAX_RECORDED_BOUND_FRACTION_DIGITS} fractional-second digits (millisecond precision). Must not be later than \`to\` when both are given.`,
      ),
    to: z.iso
      .datetime()
      .describe(
        `Exclusive upper bound on the valid-time window [from, to). Use at most ${MAX_RECORDED_BOUND_FRACTION_DIGITS} fractional-second digits (millisecond precision). Must not be earlier than \`from\` when both are given.`,
      ),
  })
  .partial()
  .strict()
  .superRefine((v, ctx) => {
    if (v.from === undefined && v.to === undefined) {
      ctx.addIssue({ code: 'custom', message: 'range requires from or to' })
      return
    }
    for (const path of ['from', 'to'] as const) {
      const bound = v[path]
      if (bound !== undefined && exceedsRecordedBoundPrecision(bound)) {
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message: `${path} precision exceeds milliseconds — use at most ${MAX_RECORDED_BOUND_FRACTION_DIGITS} fractional-second digits`,
        })
      }
    }
    if (v.from !== undefined && v.to !== undefined && Date.parse(v.from) > Date.parse(v.to)) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from must not be later than to — inverted range',
      })
    }
  })
export type FactsRangeInput = z.infer<typeof factsRangeSchema>

/**
 * The V2 `get_facts` input: the shipped {@link factsQueryInputSchema} EXTENDED
 * with `range` — the same composition pattern as searchQueryV2Schema over
 * searchQuerySchema (mcp.ts), one validation boundary (hard rule 2). V1 has no
 * refine, so a plain `.extend()` applies (unlike the V2→V3 search composition,
 * which needs `.safeExtend()` because V2 itself carries a superRefine).
 *
 * MUTUAL EXCLUSION: `range` and `asOf` are two different time-travel modes —
 * range replaces the live-only default with a valid-time WINDOW (surfacing
 * superseded generations inside it); asOf pins a single INSTANT. Combining
 * them is ambiguous, so it is REJECTED at the boundary (issue #58 precedent:
 * a caller error, never silently resolved). This is the ONLY check left at
 * this level — precision and inverted-range sanity live on
 * {@link factsRangeSchema} itself (they only ever need `range`'s own fields,
 * not `asOf`), and run automatically when this schema parses the nested
 * `range` field.
 */
export const factsQueryInputV2Schema = factsQueryInputSchema
  .extend({ range: factsRangeSchema.optional() })
  .strict()
  .superRefine((v, ctx) => {
    if (v.range !== undefined && v.asOf !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['range'],
        message: 'range is mutually exclusive with asOf — pass one or the other',
      })
    }
  })
export type FactsQueryInputV2 = z.infer<typeof factsQueryInputV2Schema>
/**
 * Caller-side (pre-parse) shape: `z.input` where the defaulted `limit` is
 * OPTIONAL. See {@link RememberToolArgs} (mcp.ts) for the pattern.
 */
export type FactsQueryArgsV2 = z.input<typeof factsQueryInputV2Schema>
