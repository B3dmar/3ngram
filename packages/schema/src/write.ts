// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'
import { actorKindSchema, edgeTypeSchema, memoryTypeSchema } from './memory.js'
import { exceedsFractionalSecondPrecision } from './recorded-range.js'
import { scopeSchema } from './scope.js'

/**
 * Write-path input contracts. These are the validated
 * payloads the write path (`remember` / `revise`) accepts at the one validation
 * boundary (AGENTS.md hard rule 2): `packages/core` consumes parsed values and
 * never re-validates. The DB CHECK constraints these imply are listed in the PR
 * description for the 1A core slice — no migrations are added here.
 *
 * Field shapes mirror the `memories` columns (packages/db migration 0000):
 * topic/content/scope are NOT NULL, project is nullable, scope defaults to
 * 'personal'. The DB stores topic/content as unbounded `text`; the input
 * contract caps content at 2000 chars to honour the S5 capture-hook latency
 * budget — the same ceiling the Go
 * hook strips client-side. The cap is an input-contract concern, so no CHECK is
 * implied for it.
 */

/**
 * Per-write upper bound on raw content. One typed atom, not a session dump.
 * Originally the S5 capture-hook latency budget; capture is gone. Kept as the
 * native remember/revise ceiling so a debrief splits into several calls rather
 * than one 10k transcript (issue #166). Import uses a separate, larger bound.
 */
export const MAX_CONTENT_LENGTH = 2000
/** Topic is a short label, not a body — keep it scannable in lists. */
export const MAX_TOPIC_LENGTH = 256
/** Defensive ceiling on tag count; tags are categorisation, not payload. */
export const MAX_TAGS = 32
/** Per-tag length ceiling. */
export const MAX_TAG_LENGTH = 64

/**
 * A single categorisation tag. Free-form (unlike scope's closed-ish set) but
 * trimmed and bounded so callers can't smuggle a body into a tag.
 */
export const tagSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH)
export type Tag = z.infer<typeof tagSchema>

/**
 * Optional project label. Mirrors the nullable `memories.project` column.
 * A memory written WITHOUT a project lands with project=NULL and is
 * invisible to a project-scoped briefing (`project = $project` never matches
 * NULL) — so commitments and blockers meant to surface in a project briefing
 * MUST carry this. The MCP server cannot infer a project; the caller supplies it.
 */
export const projectSchema = z.string().trim().min(1).max(256)
export type Project = z.infer<typeof projectSchema>

const tagsSchema = z.array(tagSchema).max(MAX_TAGS)

/**
 * Fields shared by every write. `remember` uses these directly; `revise`
 * extends them with the predecessor reference and edge intent.
 *
 * Implied DB CHECKs (for the 1A core slice, NOT added here):
 *   - memory_type ∈ MEMORY_TYPES  (already in migration 0000)
 *   - scope/topic/content NOT NULL (already in migration 0000)
 * The content/topic/tag length caps are input-contract ceilings, not CHECKs.
 */
export const rememberInputSchema = z
  .object({
    memoryType: memoryTypeSchema,
    topic: z.string().trim().min(1).max(MAX_TOPIC_LENGTH),
    content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
    /** Defaults to 'personal', matching the `memories.scope` column default. */
    scope: scopeSchema.default('personal'),
    project: projectSchema.optional(),
    tags: tagsSchema.default([]),
  })
  .strict()
export type RememberInput = z.infer<typeof rememberInputSchema>

/**
 * Upper bound on facts asserted by a single write. A memory states a handful of
 * measurable things; a longer list is a sign the caller is using the write path
 * as a bulk fact importer, which is what the import contract is for.
 */
export const MAX_FACTS_PER_WRITE = 16

/**
 * Maximum fractional-second digits a fact's validity instant may carry.
 *
 * WHY 3 (the same ceiling, for the same reason, as
 * MAX_RECORDED_BOUND_FRACTION_DIGITS on the facts-range READ bounds —
 * recorded-range.ts):
 * core's `toFactWrite` converts each instant with `new Date(iso)` on the way to
 * the db, and a JS Date holds MILLISECOND precision — while Postgres stores
 * `facts.valid_from`/`valid_to` at MICROSECOND precision. `...T00:00:00.1234567Z`
 * would therefore land as `.123`, silently moving the boundary of a bi-temporal
 * window: a generation would appear to open or close at an instant the caller
 * never asked for, and a subsequent range read against the true instant would
 * disagree with what was written. Rejected loudly at the one validation
 * boundary (hard rule 2) rather than truncated, so the write surface and the
 * read bounds enforce ONE precision contract.
 */
export const MAX_FACT_WRITE_FRACTION_DIGITS = 3

/** Schema-visible bound description — refinements vanish from emitted JSON Schema, so the limit must be advertised in prose too. */
function factBoundDescription(bound: 'start' | 'end'): string {
  const role =
    bound === 'start'
      ? 'Inclusive START of the fact’s valid-time window'
      : 'Exclusive END of the fact’s valid-time window (requires validFrom)'
  return `${role}, as an ISO-8601 instant. Use at most ${MAX_FACT_WRITE_FRACTION_DIGITS} fractional-second digits (millisecond precision) — a finer instant is rejected, never truncated. Omit (or null) to leave it unset.`
}

/**
 * DB-NULL semantics for the optional validity instants: an ISO-8601 string,
 * with `null` and `undefined` both meaning ABSENT — never the 1970 epoch, which
 * on validTo would mark a live fact as already closed.
 *
 * PRECISION IS CAPPED, NOT TRUNCATED: see {@link MAX_FACT_WRITE_FRACTION_DIGITS}.
 *
 * ISO STRING, NOT `z.date()`: this contract is aliased onto the `remember` MCP
 * tool, and an MCP server publishes its input schema as JSON Schema in
 * tools/list. A `z.date()` leg is unrepresentable there (it throws at
 * generation), and JSON has no date type anyway. This matches asOfSchema
 * (mcp.ts), the existing tool-facing instant contract; the string is converted
 * to a Date once, in core, on the way to the db.
 *
 * The import path's nullableTimestampSchema DOES admit a Date because it is a
 * programmatic/SDK contract, not a tool surface.
 */
const factTimestampSchema = z.iso
  .datetime()
  .refine((value) => !exceedsFractionalSecondPrecision(value, MAX_FACT_WRITE_FRACTION_DIGITS), {
    message: `use at most ${MAX_FACT_WRITE_FRACTION_DIGITS} fractional-second digits (millisecond precision) — a finer instant would be silently truncated`,
  })
  .nullish()
  .transform((value) => value ?? undefined)

/**
 * One structured fact asserted by a write: the (subject, predicate, value)
 * projection of what the memory says, with an optional valid-time window.
 *
 * Shapes mirror importFactInputSchema minus `memoryId` (the memory is being
 * written in the same call) and `recordedAt` (knowledge time is now, by
 * definition, on a fresh write — only an importer replays it).
 *
 * The validity rules mirror the DB CHECK on the proposal table
 * (fact_proposals_validity_check) rather than the looser one on `facts`: a
 * `validTo` REQUIRES a `validFrom`, because an interval that ends but never
 * begins is unrepresentable downstream. Caught here, at the one validation
 * boundary, it is a field-level error instead of a constraint violation.
 */
export const factWriteSchema = z
  .object({
    subject: z.string().trim().min(1).max(256),
    predicate: z.string().trim().min(1).max(256),
    value: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
    confidence: z.number().min(0).max(1).optional(),
    validFrom: factTimestampSchema.describe(factBoundDescription('start')),
    validTo: factTimestampSchema.describe(factBoundDescription('end')),
  })
  .strict()
  .refine((fact) => fact.validTo === undefined || fact.validFrom !== undefined, {
    message: 'validTo requires a validFrom — a window cannot end before it begins',
    path: ['validFrom'],
  })
  // COMPARE INSTANTS, NOT STRINGS. The refine runs on the parsed ISO strings,
  // and `<=` on strings is LEXICOGRAPHIC: '.' (0x2E) sorts before 'Z' (0x5A),
  // so '2026-01-01T00:00:00Z' <= '2026-01-01T00:00:00.001Z' is false — a valid
  // 1ms window would be rejected, and the inverted pair accepted. Two
  // timestamps that differ only in precision are exactly what a model-written
  // call produces. z.iso.datetime() has already validated both, so Date.parse
  // cannot return NaN here.
  .refine(
    (fact) =>
      !(fact.validFrom && fact.validTo) || Date.parse(fact.validFrom) <= Date.parse(fact.validTo),
    {
      message: 'validFrom must not be after validTo',
      path: ['validTo'],
    },
  )
export type FactWriteInput = z.infer<typeof factWriteSchema>

/**
 * `remember` payload EXTENDED with the structured facts the memory asserts —
 * composed BESIDE {@link rememberInputSchema}, never replacing it (ADR-0011).
 *
 * That separation is load-bearing: {@link reviseInputSchema} extends the BASE,
 * so a `facts` key on a revise stays a strict-mode rejection. Facts belong to
 * the assertion that introduced them; a revision appends a NEW memory, and
 * silently carrying facts across would attribute them to the wrong row.
 *
 * An empty array is equivalent to omitting the key — the write path returns no
 * `factIds` for either.
 */
export const rememberWithFactsInputSchema = rememberInputSchema.safeExtend({
  facts: z.array(factWriteSchema).max(MAX_FACTS_PER_WRITE).optional(),
})
export type RememberWithFactsInput = z.infer<typeof rememberWithFactsInputSchema>

/**
 * Native-only session provenance field. NOT on {@link rememberInputSchema} —
 * import extends that schema, and `sessionRunId` is reserved for native writes
 * (docs/concepts/session-continuity.mdx). JSON key spelling matches
 * sessionProvenancePayloadSchema.
 */
const sessionRunIdField = z
  .uuid()
  .optional()
  .describe(
    'Opaque id of the current agent session run. Pass through from SessionStart. Omit to attach the single leased-open session for this project, if any. A run id not owned by this tenant fails the write.',
  )

/**
 * Canonical native remember input (ADR-0011): facts-capable remember PLUS
 * optional sessionRunId. Core's single parse must accept this shape so
 * session provenance does not regress structured fact writes.
 */
export const nativeRememberInputSchema = rememberWithFactsInputSchema.safeExtend({
  sessionRunId: sessionRunIdField,
})
export type NativeRememberInput = z.infer<typeof nativeRememberInputSchema>

/**
 * `revise` appends a successor and links it to its predecessor with a typed
 * edge — never an in-place content UPDATE (docs/concepts/memory-model.mdx append-and-supersede, hard
 * rule 1). The edge intent is constrained to the supersession family: a revise
 * expresses that the new memory `supersedes` or `updates` the old one. `extends`
 * / `derives` are additive relationships created via the edge-creation contract,
 * not a revision, so they are excluded here.
 */
export const reviseEdgeIntentSchema = z.enum(['supersedes', 'updates'])
export type ReviseEdgeIntent = z.infer<typeof reviseEdgeIntentSchema>

/**
 * `revise` payload: a full successor memory plus the predecessor reference and
 * the edge intent. `predecessorId` is the memory being superseded; the core
 * slice closes its `valid_to` and writes the typed edge in one transaction
 * (docs/concepts/data-model.mdx §5).
 */
export const reviseInputSchema = rememberInputSchema
  .extend({
    predecessorId: z.uuid(),
    edgeIntent: reviseEdgeIntentSchema.default('supersedes'),
  })
  .strict()
export type ReviseInput = z.infer<typeof reviseInputSchema>

/** Native revise: same optional sessionRunId as {@link nativeRememberInputSchema}. */
export const nativeReviseInputSchema = reviseInputSchema.safeExtend({
  sessionRunId: sessionRunIdField,
})
export type NativeReviseInput = z.infer<typeof nativeReviseInputSchema>

/**
 * Edge-creation input (typed edges: supersedes/updates/extends/derives). The
 * full edge-type set is allowed here, unlike `revise`'s restricted intent.
 *
 * Implied DB CHECKs (already present in migration 0000's `memory_edges`):
 *   - edge_type ∈ EDGE_TYPES
 *   - from_id <> to_id (no self-edge)
 *   - created_by ∈ actor kinds
 * The unique index (user_id, from_id, to_id, edge_type) makes edges idempotent.
 */
export const edgeInputSchema = z
  .object({
    fromId: z.uuid(),
    toId: z.uuid(),
    edgeType: edgeTypeSchema,
    /** Actor class that created the edge (memory_edges.created_by). */
    createdBy: actorKindSchema,
  })
  .strict()
  .refine((edge) => edge.fromId !== edge.toId, {
    message: 'an edge cannot point a memory at itself',
    path: ['toId'],
  })
export type EdgeInput = z.infer<typeof edgeInputSchema>
