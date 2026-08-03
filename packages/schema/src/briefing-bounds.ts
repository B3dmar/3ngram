// SPDX-License-Identifier: Apache-2.0
// briefing/handoff BOUNDS V2 — caller-tunable sectionLimit + section selection
// (issue #45, epic #42).
//
// A SEPARATE module from mcp.ts (already past the 500-line file cap) so the
// successor contracts stay bounded and reviewable — the same split get-memories.ts
// made. Same one-validation-boundary rules (hard rule 2): the ceilings and the
// section-name enum live HERE and nowhere else.
//
// COMPOSED SUCCESSORS (ADR-0011, the searchQueryV2Schema pattern): every V2
// schema EXTENDS its shipped V1 schema in mcp.ts — the shipped fields stay
// byte-identical, the additions are optional, and everything stays `.strict()`.
// A legacy input parses IDENTICALLY through V1 and V2 (byte-stability, pinned by
// test), so shipping the successor can never move an existing caller.
//
// POLICY RECONCILIATION (no-firehose, docs/concepts/mcp-design.mdx): the rule's
// substance is (1) a REQUIRED selector and (2) a hard SERVER-SIDE ceiling — both
// preserved. A bounded caller-tunable limit is already house style on this exact
// surface (get_facts 50/200, review_proposals 25/100, search 5/25);
// briefing/handoff were the outliers, and their fixed 25 cap is demonstrably
// lossy (a 58-commitment corpus cannot be enumerated). Section SELECTION strictly
// reduces output — more size-disciplined than today. NO per-section cursors: the
// ceiling covers observed corpora; beyond it the answer is search + get_memories
// per the existing "page via search" doctrine.
import { z } from 'zod'
import {
  briefingCommitmentSchema,
  briefingMemoryItemSchema,
  briefingModeSchema,
  briefingSelectorSchema,
  briefingToolInputSchema,
  handoffToolInputSchema,
  handoffToolOutputSchema,
} from './mcp.js'

/**
 * The hard SERVER-SIDE ceiling on a caller-requested briefing `sectionLimit`.
 * The no-firehose bound that replaces the fixed MAX_BRIEFING_SECTION=25 fetch
 * cap as the outer limit: a caller may tune UP TO here, never past it. 100
 * covers every observed corpus (the motivating one holds 58 open commitments);
 * beyond it the answer is `search` + `get_memories`, not a bigger briefing.
 */
export const MAX_BRIEFING_SECTION_CEILING = 100
/**
 * The hard SERVER-SIDE ceiling on a caller-requested handoff `sectionLimit`.
 * Same reconciliation as {@link MAX_BRIEFING_SECTION_CEILING}; kept as its OWN
 * constant because a handoff line carries CONTENT (a bounded excerpt), so its
 * ceiling may need to diverge from the topic-only briefing's in a later slice.
 */
export const MAX_HANDOFF_SECTION_CEILING = 100

/**
 * The six briefing sections, in output order. The single source of truth for
 * the `sections` selection axis — each name is exactly an output key of the
 * briefing envelope, so a requested name always maps to a section.
 */
export const BRIEFING_SECTION_NAMES = [
  'commitments',
  'overdue',
  'blockers',
  'staleCandidates',
  'recentDecisions',
  'preferences',
] as const

/** One briefing section name (a key of the briefing output envelope). */
export const briefingSectionNameSchema = z.enum(BRIEFING_SECTION_NAMES)
export type BriefingSectionName = z.infer<typeof briefingSectionNameSchema>

/**
 * `briefing` input V2 — the shipped {@link briefingToolInputSchema} (selector +
 * mode, both untouched) EXTENDED with two OPTIONAL knobs:
 *
 *   - `sections`  : a non-empty SUBSET of {@link BRIEFING_SECTION_NAMES} to
 *     compute. Absent = all six (today's behavior). An un-requested section is
 *     SKIPPED ENTIRELY (its query never runs and its key is OMITTED from the
 *     output) — selection strictly REDUCES output, never widens it. Duplicate
 *     names are ambiguous (a set, not a list) and are REJECTED loudly rather
 *     than silently deduplicated.
 *   - `sectionLimit` : per-section item bound, 1..{@link
 *     MAX_BRIEFING_SECTION_CEILING}. Absent = the mode default (3 brief /
 *     25 full). The effective fetch limit is min(sectionLimit ?? modeDefault,
 *     CEILING) — the server-side ceiling always wins.
 *
 * Both absent ⇒ V2 parses a legacy input to the byte-identical V1 result.
 */
export const briefingToolInputV2Schema = briefingToolInputSchema
  .extend({
    sections: z
      .array(briefingSectionNameSchema)
      .min(1)
      .max(BRIEFING_SECTION_NAMES.length)
      .describe(
        'Subset of sections to compute (unique names). Absent = all sections. Un-requested sections are skipped entirely and omitted from the result.',
      )
      .optional(),
    sectionLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_BRIEFING_SECTION_CEILING)
      .describe(
        `Per-section item bound (1..${MAX_BRIEFING_SECTION_CEILING}). Absent = the mode default (3 brief / 25 full).`,
      )
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.sections !== undefined && new Set(v.sections).size !== v.sections.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: 'sections must be unique — a duplicate section name is a caller error',
      })
    }
  })
export type BriefingToolInputV2 = z.infer<typeof briefingToolInputV2Schema>
/**
 * Caller-side (pre-parse) shape: `z.input` where the defaulted `mode` is
 * OPTIONAL. See RememberToolArgs (mcp.ts) for the pattern.
 */
export type BriefingToolArgsV2 = z.input<typeof briefingToolInputV2Schema>

/**
 * `handoff` input V2 — the shipped {@link handoffToolInputSchema} (selector +
 * generatedFor, untouched) EXTENDED with the same OPTIONAL `sectionLimit` knob
 * (1..{@link MAX_HANDOFF_SECTION_CEILING}; absent = the shipped default of 25).
 * No `sections` axis: a handoff's three lists ARE its purpose — a receiver
 * needing a narrower slice uses search/get_memories.
 */
export const handoffToolInputV2Schema = handoffToolInputSchema
  .extend({
    sectionLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_HANDOFF_SECTION_CEILING)
      .describe(
        `Per-section item bound (1..${MAX_HANDOFF_SECTION_CEILING}). Absent = the default of 25.`,
      )
      .optional(),
  })
  .strict()
export type HandoffToolInputV2 = z.infer<typeof handoffToolInputV2Schema>
export type HandoffToolArgsV2 = z.input<typeof handoffToolInputV2Schema>

/**
 * One V2 briefing section: the shipped count+items envelope PLUS `hasMore` —
 * the explicit truncation signal (`count > items.length`) callers previously
 * had to derive by hand. The refinement ENFORCES the identity (and that the
 * exact window `count` can never under-report the returned slice), so a
 * drifting flag can never reach a caller. `items` is BOUNDED at
 * {@link MAX_BRIEFING_SECTION_CEILING}: no caller can request past the ceiling,
 * so a longer slice is a producer bug the contract rejects rather than relays.
 */
function briefingSectionV2Schema<T extends z.ZodType>(item: T) {
  return z
    .object({
      count: z.number().int().min(0),
      items: z.array(item).max(MAX_BRIEFING_SECTION_CEILING),
      hasMore: z.boolean(),
    })
    .strict()
    .refine((s) => s.count >= s.items.length && s.hasMore === s.count > s.items.length, {
      message: 'hasMore must equal count > items.length (and count must cover the slice)',
      path: ['hasMore'],
    })
}

/**
 * `briefing` output V2 — the same envelope keys as the shipped V1 output, with
 * every section upgraded to the {@link briefingSectionV2Schema} shape (adds
 * `hasMore`) and made OPTIONAL: a section is PRESENT exactly when it was
 * requested (all six when `sections` is absent — the legacy shape plus
 * `hasMore`), and OMITTED when the caller excluded it (its query never ran, so
 * there is no count to report — an omitted key, never a fabricated zero).
 * Composed field-by-field rather than via `.extend()` overrides so each
 * section's succession (V1 envelope → V2 + hasMore) is explicit; the
 * selector/mode/generatedAt trio reuses the exact shipped schemas.
 *
 * AT LEAST ONE section must be present: every valid V2 input computes ≥ 1
 * section (`sections` is absent = all six, or a non-empty subset), so an
 * all-metadata envelope with zero sections is a producer bug the group
 * refinement rejects rather than relays.
 */
export const briefingToolOutputV2Schema = z
  .object({
    selector: briefingSelectorSchema,
    mode: briefingModeSchema,
    generatedAt: z.iso.datetime(),
    commitments: briefingSectionV2Schema(briefingCommitmentSchema).optional(),
    overdue: briefingSectionV2Schema(briefingCommitmentSchema).optional(),
    blockers: briefingSectionV2Schema(briefingMemoryItemSchema).optional(),
    staleCandidates: briefingSectionV2Schema(briefingMemoryItemSchema).optional(),
    recentDecisions: briefingSectionV2Schema(briefingMemoryItemSchema).optional(),
    preferences: briefingSectionV2Schema(briefingMemoryItemSchema).optional(),
  })
  .strict()
  .refine((v) => BRIEFING_SECTION_NAMES.some((name) => v[name] !== undefined), {
    message:
      'at least one briefing section must be present — every valid input computes one or more sections',
  })
export type BriefingToolOutputV2 = z.infer<typeof briefingToolOutputV2Schema>

/** The three handoff sections (fixed — a handoff has no section selection). */
export const HANDOFF_SECTION_NAMES = ['decisions', 'commitments', 'preferences'] as const

/** Exact per-section totals for a handoff (the window counts core already reads). */
export const handoffCountsSchema = z
  .object({
    decisions: z.number().int().min(0),
    commitments: z.number().int().min(0),
    preferences: z.number().int().min(0),
  })
  .strict()
export type HandoffCountsOutput = z.infer<typeof handoffCountsSchema>

/**
 * Per-SECTION truncation flags for a handoff (`counts.X > X.length`). Named
 * apart from the per-ITEM `truncated` flag on a handoff line (an excerpt cut):
 * THIS one says "the section list itself is incomplete — more rows exist than
 * were exported".
 */
export const handoffTruncatedSchema = z
  .object({
    decisions: z.boolean(),
    commitments: z.boolean(),
    preferences: z.boolean(),
  })
  .strict()
export type HandoffTruncatedOutput = z.infer<typeof handoffTruncatedSchema>

/**
 * `handoff` output V2 — the shipped {@link handoffToolOutputSchema} EXTENDED
 * with the totals core ALREADY computes but V1 discarded: `counts` (exact
 * per-section window totals) + `truncated` (per-section incompleteness flags).
 * The refinement enforces both identities per section — the count covers the
 * exported slice and the flag equals `count > length` — so neither can drift
 * from the lists they describe. The three inherited lists keep the exact V1
 * item schemas but gain a {@link MAX_HANDOFF_SECTION_CEILING} bound on the V2
 * successor ONLY (V1 untouched): no caller can request past the ceiling, so a
 * longer list is a producer bug the contract rejects rather than relays.
 */
export const handoffToolOutputV2Schema = handoffToolOutputSchema
  .extend({
    decisions: handoffToolOutputSchema.shape.decisions.max(MAX_HANDOFF_SECTION_CEILING),
    commitments: handoffToolOutputSchema.shape.commitments.max(MAX_HANDOFF_SECTION_CEILING),
    preferences: handoffToolOutputSchema.shape.preferences.max(MAX_HANDOFF_SECTION_CEILING),
    counts: handoffCountsSchema,
    truncated: handoffTruncatedSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const name of HANDOFF_SECTION_NAMES) {
      if (v.counts[name] < v[name].length) {
        ctx.addIssue({
          code: 'custom',
          path: ['counts', name],
          message: `counts.${name} must cover the exported slice (count >= items length)`,
        })
      }
      if (v.truncated[name] !== v.counts[name] > v[name].length) {
        ctx.addIssue({
          code: 'custom',
          path: ['truncated', name],
          message: `truncated.${name} must equal counts.${name} > ${name}.length`,
        })
      }
    }
  })
export type HandoffToolOutputV2 = z.infer<typeof handoffToolOutputV2Schema>
