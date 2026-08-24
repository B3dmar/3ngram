// SPDX-License-Identifier: Apache-2.0
// MCP tool I/O contracts (docs/concepts/mcp-design.mdx).
//
// THE one validation boundary (AGENTS.md hard rule 2): every MCP tool declares a
// Zod INPUT schema AND an `outputSchema` here, and NOWHERE else. The MCP
// transport registers `.shape` of these with the SDK (which validates inbound
// args and the structured result against them); the forthcoming REST API and
// TS SDK reuse the SAME schemas, so the surfaces cannot drift.
//
// `searchInputSchema` and `factsQueryInputSchema` are authored here — the home
// for the search input contract. The core `search()` / `getFacts()` policy layers
// can adopt these in place of their inline boundary checks in a later slice.
//
// Output discipline (docs/concepts/mcp-design.mdx "output size discipline"): outputs are
// STRUCTURED and BOUNDED. Search hits cap content length and the result count is
// limited at the input boundary, so a tool result never balloons into a
// legacy-style 50KB firehose. No schema here echoes more than the tool returns
// by design.
//
// ADVERTISE OPEN, PARSE STRICT (issue #154): every OUTPUT object node carries
// {@link OPEN_OUTPUT_META}, so the JSON Schema clients cache says
// `additionalProperties: true` while the object keeps parsing `.strict()`.
// Rationale and the composition rules in output-openness.ts. INPUT schemas are
// deliberately NOT marked — an unknown arg key stays a loud rejection.
import { z } from 'zod'
import { commitmentStatusSchema } from './commitment.js'
import { proposalStatusSchema } from './consolidation.js'
import { edgeTypeSchema, memoryStatusSchema, memoryTypeSchema } from './memory.js'
import { OPEN_OUTPUT_META } from './output-openness.js'
import { recordedBoundDescription, recordedRangeIssues } from './recorded-range.js'
import { scopeSchema } from './scope.js'
import { sessionRunIdSchema } from './session-run-id.js'
import { nativeReviseInputSchema, projectSchema, rememberInputSchema } from './write.js'

/** Upper bound on a search result window — the no-firehose ceiling (docs/concepts/mcp-design.mdx). */
export const MAX_SEARCH_LIMIT = 25
/** Default search window. Matches the core search default (K=5). */
export const DEFAULT_SEARCH_LIMIT = 5
/**
 * THE excerpt cap: per-item content bound in a read RESULT. Frozen
 * HERE — the one validation boundary (hard rule 2) — and consumed by the core
 * read-path excerpting policy (packages/core/src/read/excerpt.ts; docs/concepts/architecture.mdx:
 * excerpting is read-path policy, never transport logic).
 *
 * WHY an excerpt, not the write cap: native writes are bounded at
 * MAX_CONTENT_LENGTH (write.ts, 2,000), but the IMPORT path deliberately admits up
 * to MAX_IMPORT_CONTENT_LENGTH (262,144) — the migration landed hundreds of
 * rows over 2,000 chars (max ~245K). An output schema capped at the write bound
 * therefore REJECTS legitimately stored content and fails the whole read. Read
 * surfaces instead return a bounded EXCERPT; stored content is untouched
 * (docs/concepts/memory-model.mdx — read-side shaping only).
 *
 * WHY 600: a search hit / handoff line is an orientation payload, not a document
 * read (output size discipline, docs/concepts/mcp-design.mdx). ~500-700 chars
 * carries enough context to act on or to decide to fetch more; the dashboard
 * imposes no constraint (it drops `content` before the browser). A caller needing the
 * full body reads the memory by id (the REST memory detail is unbounded by
 * design).
 */
export const MAX_EXCERPT_LENGTH = 600
/**
 * Marker appended to a truncated excerpt so the TEXT itself signals the cut
 * (the item also carries `truncated` + `contentLength` for programmatic use).
 * Fits WITHIN the {@link MAX_EXCERPT_LENGTH} budget.
 */
export const EXCERPT_MARKER = '…'

// ---------------------------------------------------------------------------
// remember
// ---------------------------------------------------------------------------

/**
 * `remember` input. A thin MCP-facing alias of the canonical write contract
 * ({@link rememberInputSchema}) so the tool, REST, and SDK validate the SAME
 * shape — the MCP transport hands the parsed value straight to core remember().
 */
export const rememberToolInputSchema = rememberInputSchema
export type RememberToolInput = z.infer<typeof rememberToolInputSchema>
/**
 * Caller-side (pre-parse) shape: the `z.input` side where server-defaulted
 * fields (`scope`, `tags`) are OPTIONAL. Use this for request bodies a client
 * sends (a transport `.parse()` applies the defaults); {@link RememberToolInput}
 * is the post-parse output where those fields are present.
 */
export type RememberToolArgs = z.input<typeof rememberToolInputSchema>

/**
 * The created-memory view a write tool returns (structured output). The id is
 * the only field core remember() returns directly; the rest echo the NORMALIZED
 * write input (scope default applied, project null when absent) so the caller
 * gets the canonical stored shape without a follow-up read.
 */
export const writtenMemorySchema = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string(),
    scope: scopeSchema,
    project: projectSchema.nullable(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type WrittenMemoryOutput = z.infer<typeof writtenMemorySchema>

/**
 * Embed status reported by the `remember` tool (ack-before-embed advisory).
 * The tool ACKs the durable write WITHOUT awaiting the embed (a gateway call is
 * up to 30s — blocking the response on it would re-couple the MCP turn to the
 * gateway and defeat core's ack-before-embed). So the tool can only ever report
 * the embed as not-yet-resolved at response time:
 *   - `pending` — a gateway is configured; a background embed was kicked and is
 *      in flight (its outcome lands asynchronously, never blocks this response).
 *   - `off`     — no gateway is configured; no embed was attempted.
 * `done`/`failed` are reserved for a future surface that can report a settled
 * outcome (e.g. a follow-up read); the synchronous tool never returns them.
 * A settled-outcome read surface was evaluated and deliberately NOT scheduled
 * (2026-06-09 scoping audit): YAGNI until the worker layer ships and a client
 * demonstrates the need. No tracking issue, by decision.
 */
export const embedStatusSchema = z.enum(['pending', 'done', 'failed', 'off'])
export type EmbedStatus = z.infer<typeof embedStatusSchema>

/**
 * `remember` output. The created memory plus the advisory embed status
 * (ack-before-embed: the write is already durable; embedding is best-effort and
 * runs in the background — this flag never signals a write failure).
 *
 * `commitmentId` is present ONLY for a commitment-type memory: core remember()
 * auto-creates an 'open' commitment in the same transaction, and the id is
 * surfaced so the caller can later `resolve` it without a
 * follow-up lookup. Omitted (undefined) for every other memory type.
 */
export const rememberToolOutputSchema = z
  .object({
    memory: writtenMemorySchema,
    embedded: embedStatusSchema,
    commitmentId: z.uuid().optional(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type RememberToolOutput = z.infer<typeof rememberToolOutputSchema>

// ---------------------------------------------------------------------------
// revise
// ---------------------------------------------------------------------------

/**
 * `revise` input. A thin MCP-facing alias of the canonical native revise
 * contract ({@link nativeReviseInputSchema}: successor memory + `predecessorId`
 * + supersession-family `edgeIntent` + optional sessionRunId) so the tool, REST,
 * and SDK validate the SAME shape. The MCP transport hands the parsed value
 * straight to core revise(); the edge intent is NOT widened beyond what core
 * admits ('extends'/'derives' are additive edges, not a revision).
 */
export const reviseToolInputSchema = nativeReviseInputSchema
export type ReviseToolInput = z.infer<typeof reviseToolInputSchema>
/**
 * Caller-side (pre-parse) shape: `z.input` where server-defaulted fields
 * (`scope`, `tags`, `edgeIntent`) are OPTIONAL. See {@link RememberToolArgs}.
 */
export type ReviseToolArgs = z.input<typeof reviseToolInputSchema>

/**
 * `revise` output. The created SUCCESSOR memory plus the advisory embed status
 * (same ack-before-embed semantics as remember: the supersede+append is durable;
 * the successor's embed runs in the background). The successor's id lets the
 * caller chain further operations without a follow-up read.
 */
export const reviseToolOutputSchema = z
  .object({
    memory: writtenMemorySchema,
    embedded: embedStatusSchema,
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ReviseToolOutput = z.infer<typeof reviseToolOutputSchema>

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

/**
 * `resolve` input — settle the obligation a memory carries, keyed on the MEMORY
 * id an agent already holds (from remember / search), not a commitment id.
 *
 * For a COMMITMENT memory: transition the commitment riding it to a target FSM
 * status; core resolves memory -> commitment via the unique (user_id, memory_id)
 * index. `status` is the full {@link commitmentStatusSchema} enum so the ONE tool
 * serves resolve AND unresolve (resolved -> open) — legality is the FSM's concern
 * (COMMITMENT_TRANSITIONS), so an illegal pair is a typed runtime rejection.
 *
 * For a BLOCKER memory: blockers are deliberately MEMORY-ONLY (no
 * commitment FSM), so resolving one ARCHIVES the blocker memory (status
 * 'active' -> 'archived'), dropping it from the briefing's active blockers. The
 * `status` you pass is IGNORED for a blocker — resolve and expire both mean
 * "archived" — so any valid value satisfies the schema; the result reports
 * 'archived'.
 *
 * PROJECT SCOPING: a blocker (and a commitment) only appears in a
 * PROJECT-scoped briefing if it was written WITH that `project` — a NULL-project
 * row never matches `project = $project`. Pass `project` on remember to make a
 * blocker/commitment resolvable from inside a project briefing.
 */
export const resolveToolInputSchema = z
  .object({
    memoryId: z.uuid(),
    status: commitmentStatusSchema,
    sessionRunId: sessionRunIdSchema
      .optional()
      .describe(
        'Opaque id of the current agent session run. Pass through from SessionStart. Omit to attach the single leased-open session for this project, if any.',
      ),
  })
  .strict()
export type ResolveToolInput = z.infer<typeof resolveToolInputSchema>

/**
 * The post-resolve status a `resolve` settles on: a commitment FSM status for a
 * commitment, or 'archived' for a blocker (blockers leave the active
 * set via a memory-status archive, not an FSM transition). memoryStatusSchema is
 * ['active','archived']; only 'archived' is a resolve outcome (you never resolve
 * INTO 'active'), so we admit the single 'archived' literal alongside the
 * commitment statuses rather than the whole memory-status enum.
 */
export const resolveOutcomeStatusSchema = z.union([
  commitmentStatusSchema,
  memoryStatusSchema.extract(['archived']),
])
export type ResolveOutcomeStatus = z.infer<typeof resolveOutcomeStatusSchema>

/**
 * `resolve` output: the resolved entity's id + its new status. `commitmentId`
 * carries the commitment id for a commitment resolve, OR the BLOCKER memory id
 * for a blocker archive (both are uuids; the field name is kept for back-compat
 * with REST/SDK consumers — the id IS the resolved entity). `status` is the
 * commitment's new FSM status, or 'archived' for a blocker.
 */
export const resolveToolOutputSchema = z
  .object({
    commitmentId: z.uuid(),
    status: resolveOutcomeStatusSchema,
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ResolveToolOutput = z.infer<typeof resolveToolOutputSchema>

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * The NARROW query+limit BASE — a non-empty query plus a `limit` bounded by
 * {@link MAX_SEARCH_LIMIT} (no-firehose). A `.strict()` object REJECTS unknown
 * keys, so a caller that passes a key not on the (wider) shape gets a clear
 * validation error rather than having it silently dropped (a silent drop on a
 * `scope` filter reads as a scope leak).
 *
 * This is the BASE that {@link searchQuerySchema} extends with the canonical
 * {@link searchFiltersSchema} filters. The MCP `search` tool
 * registers `searchQuerySchema` (query + limit + the five optional filters), and
 * REST/SDK/core consume the same wider shape — ONE validation boundary for the
 * filters (hard rule 2). This base schema is kept for code that needs the
 * filter-free query+limit slice (and as the extension point below).
 */
export const searchInputSchema = z
  .object({
    query: z.string().trim().min(1),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  })
  .strict()
export type SearchInput = z.infer<typeof searchInputSchema>

/**
 * One scored, supersession-aware hit (docs/concepts/memory-model.mdx: live first). `content` is the
 * core-produced bounded EXCERPT ({@link MAX_EXCERPT_LENGTH}):
 * `contentLength` is the FULL stored length and `truncated` flags whether the
 * excerpt was cut (the text then ends with {@link EXCERPT_MARKER}), so a caller
 * can fetch the full memory by id when it needs the body. `superseded` marks a
 * demoted predecessor row (docs/concepts/memory-model.mdx: ranked below its
 * successor, never filtered) so a caller can label it rather than receive it
 * unmarked.
 */
export const searchHitSchema = z
  .object({
    id: z.uuid(),
    memoryType: z.string(),
    topic: z.string(),
    content: z.string().max(MAX_EXCERPT_LENGTH),
    contentLength: z.number().int().min(0),
    truncated: z.boolean(),
    score: z.number(),
    superseded: z.boolean(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type SearchHitOutput = z.infer<typeof searchHitSchema>

/** `search` output: the bounded hit list plus the returned count (envelope). */
export const searchToolOutputSchema = z
  .object({
    hits: z.array(searchHitSchema).max(MAX_SEARCH_LIMIT),
    count: z.number().int().min(0),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type SearchToolOutput = z.infer<typeof searchToolOutputSchema>

// ---------------------------------------------------------------------------
// get_facts
// ---------------------------------------------------------------------------

/**
 * Default get_facts result window. List mode (no subject/predicate) would
 * otherwise return EVERY current fact — an unbounded firehose violating output
 * discipline (docs/concepts/mcp-design.mdx). 50 is generous for the "what's currently true"
 * JTBD while staying small enough to never balloon a tool result.
 */
export const DEFAULT_FACTS_LIMIT = 50
/** Upper bound a caller may request — the no-firehose ceiling for facts reads. */
export const MAX_FACTS_LIMIT = 200

/**
 * A bi-temporal point-in-time coordinate (valid time / transaction time).
 *
 * REQUIRES AT LEAST ONE COORDINATE (Codex P2, comment 3372942604). Both fields
 * are individually optional, but an EMPTY `asOf:{}` is rejected: an empty object
 * would request time-travel (lifting the active-only default in the db layer)
 * while supplying NO temporal predicate, silently returning an UNFILTERED read
 * that INCLUDES archived/superseded rows. The refine makes `{}` unreachable so
 * core never sees an empty asOf (belt-and-suspenders with the db-layer guard in
 * rowEligibility, which only lifts the active default when a coordinate is set).
 */
export const asOfSchema = z
  .object({
    validAt: z.iso.datetime().optional(),
    asKnownAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine((v) => v.validAt !== undefined || v.asKnownAt !== undefined, {
    message: 'asOf requires validAt or asKnownAt',
  })
export type AsOfInput = z.infer<typeof asOfSchema>

// ---------------------------------------------------------------------------
// search FILTERS — the CORE/DB-facing query contract
// ---------------------------------------------------------------------------

/**
 * The CANONICAL search FILTER set. This is the SINGLE
 * validation boundary for the filters core search() honours — REST and the SDK
 * validate against {@link searchQuerySchema} (which embeds these), so every
 * surface that can filter consumes ONE shape (hard rule 2). Every field reuses
 * the SAME contract its column is written against, so a filter value is always a
 * value a memory could actually carry:
 *   - `memoryType` → {@link memoryTypeSchema} (memories.memory_type)
 *   - `scope`      → {@link scopeSchema}      (memories.scope)
 *   - `project`    → {@link projectSchema}    (memories.project)
 *   - `status`     → {@link memoryStatusSchema} (memories.status)
 *   - `asOf`       → {@link asOfSchema}        (bi-temporal valid/transaction time)
 *
 * FIELD NAME (Codex P2, comment 3372942608): the type filter is named
 * `memoryType` — CANONICAL end-to-end. The core/db filter object
 * ({@link SearchFilters} / rowEligibility in packages/db search.ts) reads
 * `filters.memoryType`; naming it `type` here would let a parsed
 * `{query, type:'decision'}` be ACCEPTED while the narrowing is SILENTLY DROPPED
 * downstream (a scope-leak failure mode). One name, parse→filter, no drop.
 *
 * Kept on a SEPARATE schema from the {@link searchInputSchema} base so the
 * filter set is one reusable shape: {@link searchQuerySchema} extends the base
 * with these, and the MCP `search` tool registers that wider
 * shape (filters now exposed on the tool). REST/SDK/core consume the same shape —
 * ONE validation boundary for the filters (hard rule 2).
 *
 * `.partial()` (every field optional) is the point: a filter is a NARROWING the
 * caller opts into. An ABSENT filter is "do not narrow on this axis"; it is NOT
 * a default value. `asOf` defaults (no asOf) to the supersession-aware live view
 * (docs/concepts/memory-model.mdx); supplying it surfaces history (time-travel).
 */
export const searchFiltersSchema = z
  .object({
    memoryType: memoryTypeSchema,
    scope: scopeSchema,
    project: projectSchema,
    status: memoryStatusSchema,
    asOf: asOfSchema,
  })
  .partial()
  .strict()
export type SearchFiltersInput = z.infer<typeof searchFiltersSchema>

/**
 * The WIDER search query contract: the query+limit base ({@link
 * searchInputSchema}) EXTENDED with the canonical {@link searchFiltersSchema}
 * filters. Every filtering surface consumes THIS — core search(), REST, the SDK,
 * and the MCP `search` tool, which registers this schema's
 * `.shape` so a caller can narrow by memoryType/scope/project/status/asOf. One
 * validation boundary for the filters (hard rule 2): the filter constraints live
 * here, not re-checked in core. `.strict()` rejects unknown keys end-to-end.
 */
export const searchQuerySchema = searchInputSchema.extend(searchFiltersSchema.shape).strict()
export type SearchQueryInput = z.infer<typeof searchQuerySchema>
/**
 * Caller-side (pre-parse) shape: `z.input` where the defaulted `limit` is
 * OPTIONAL. See {@link RememberToolArgs}.
 */
export type SearchQueryArgs = z.input<typeof searchQuerySchema>

/**
 * `get_facts` input — currently-valid facts for a subject, bi-temporally
 * (authored here alongside searchInputSchema). subject/predicate narrow the
 * key space; `asOf` time-travels along either axis. subject/predicate/asOf are
 * optional: with none, it lists current facts by recency, BOUNDED by `limit`
 * (default {@link DEFAULT_FACTS_LIMIT}, max {@link MAX_FACTS_LIMIT}) so list mode
 * never returns the whole table (no-firehose, docs/concepts/mcp-design.mdx). ISO-8601 strings
 * are coerced to Date at the transport boundary before core getFacts() runs.
 */
export const factsQueryInputSchema = z
  .object({
    subject: z.string().trim().min(1).optional(),
    predicate: z.string().trim().min(1).optional(),
    asOf: asOfSchema.optional(),
    limit: z.number().int().min(1).max(MAX_FACTS_LIMIT).default(DEFAULT_FACTS_LIMIT),
  })
  .strict()
export type FactsQueryInput = z.infer<typeof factsQueryInputSchema>
/**
 * Caller-side (pre-parse) shape: `z.input` where the defaulted `limit` is
 * OPTIONAL. See {@link RememberToolArgs}.
 */
export type FactsQueryArgs = z.input<typeof factsQueryInputSchema>

/**
 * One currently-valid (or as-of / range) fact row, structured.
 *
 * `recordedAt` (transaction-time: when we LEARNED the fact) is an
 * OUTPUT-ONLY widening — additive, `.strict()`-safe (a wider output never
 * breaks a caller parsing a subset). Range-mode (time-series) reads return rows
 * spanning multiple valid-time generations, several possibly recorded at
 * different instants, so a time-series consumer needs recordedAt on every row
 * to tell them apart — the default single-row read already had this on
 * {@link FactRow} (packages/db), it just never reached the wire.
 */
export const factSchema = z
  .object({
    id: z.uuid(),
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
    confidence: z.number().nullable(),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    recordedAt: z.iso.datetime(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type FactOutput = z.infer<typeof factSchema>

/** `get_facts` output: the fact list plus the returned count (envelope). */
export const factsToolOutputSchema = z
  .object({
    facts: z.array(factSchema),
    count: z.number().int().min(0),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type FactsToolOutput = z.infer<typeof factsToolOutputSchema>

// ===========================================================================
// MCP admin tools: configure_scope, describe_environment,
// review_proposals. THE one validation boundary (hard rule 2) — appended block.
// ===========================================================================

// ---------------------------------------------------------------------------
// configure_scope
// ---------------------------------------------------------------------------

/** Upper bound on a scope's alias list — a registry label set, not a firehose. */
export const MAX_SCOPE_ALIASES = 16

/**
 * A scope NAME / alias — reuses {@link scopeSchema} (kebab-case, <=64 chars), the
 * SAME contract memories.scope is validated against on the write path, so a
 * registered scope name can always be carried on a memory and vice versa.
 */
export const scopeNameSchema = scopeSchema

/** A bounded alias list for a scope (each an alias-shaped string). */
export const scopeAliasesSchema = z.array(scopeNameSchema).max(MAX_SCOPE_ALIASES)

/**
 * `configure_scope` input — an ACTION DISCRIMINATOR (list | create | rename |
 * set_aliases | delete). A discriminated union keeps each action's required
 * fields explicit and STRICT (unknown keys rejected) so the surface is
 * self-describing and a typo never silently lands in the wrong branch.
 *
 * SCOPE-CHECK NOTE (two-layer model, orchestrator decision): the tool's
 * registry-level requiredScope is an anyOf floor (memory:read | memory:write) so
 * a read token can `list` AND a write token can mutate; the HANDLER then asserts
 * the EXACT action scope (list → memory:read, mutations → memory:write). The
 * input shape does not encode the scope split — that is the transport's concern.
 */
export const configureScopeInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z
    .object({
      action: z.literal('create'),
      name: scopeNameSchema,
      aliases: scopeAliasesSchema.default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal('rename'),
      name: scopeNameSchema,
      newName: scopeNameSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('set_aliases'),
      name: scopeNameSchema,
      aliases: scopeAliasesSchema,
    })
    .strict(),
  z.object({ action: z.literal('delete'), name: scopeNameSchema }).strict(),
])
export type ConfigureScopeInput = z.infer<typeof configureScopeInputSchema>

/**
 * REGISTRATION shape for the MCP SDK. registerTool wants a ZodRawShape (it wraps
 * it in z.object); a discriminated union is not a raw shape, so the SDK is given
 * this permissive flat object (action enum + the per-action fields, all optional)
 * while the HANDLER re-parses with the strict {@link configureScopeInputSchema}
 * union for real validation. The advertised contract therefore lists every field;
 * the precise per-action requirements are enforced in the handler.
 */
export const configureScopeRegisterShape = {
  action: z.enum(['list', 'create', 'rename', 'set_aliases', 'delete']),
  name: scopeNameSchema.optional(),
  newName: scopeNameSchema.optional(),
  aliases: scopeAliasesSchema.optional(),
} as const

/** One scope-registry record in a tool result (id + name + aliases + created). */
export const scopeRecordSchema = z
  .object({
    id: z.uuid(),
    name: scopeNameSchema,
    aliases: scopeAliasesSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ScopeRecordOutput = z.infer<typeof scopeRecordSchema>

/**
 * `configure_scope` output — a discriminated result mirroring the action:
 * `list` returns the full registry + count; `upserted` echoes the resulting
 * `scope` record for create/rename/set_aliases; `deleted` confirms removal by
 * name (no row to echo after a delete).
 */
export const configureScopeOutputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      scopes: z.array(scopeRecordSchema),
      count: z.number().int().min(0),
    })
    .strict()
    .meta(OPEN_OUTPUT_META),
  z
    .object({ action: z.literal('upserted'), scope: scopeRecordSchema })
    .strict()
    .meta(OPEN_OUTPUT_META),
  z
    .object({ action: z.literal('deleted'), name: scopeNameSchema })
    .strict()
    .meta(OPEN_OUTPUT_META),
])
export type ConfigureScopeOutput = z.infer<typeof configureScopeOutputSchema>

/**
 * REGISTRATION output shape for the SDK (permissive: a discriminated union is not
 * a raw shape). The SDK validates structuredContent against this; the HANDLER
 * builds and validates the exact per-action result with the strict
 * {@link configureScopeOutputSchema} union before returning, so the precise shape
 * is still enforced — this shape only needs to ADMIT every variant.
 */
export const configureScopeRegisterOutputShape = {
  action: z.enum(['list', 'upserted', 'deleted']),
  scopes: z.array(scopeRecordSchema).optional(),
  count: z.number().int().min(0).optional(),
  scope: scopeRecordSchema.optional(),
  name: scopeNameSchema.optional(),
} as const

// ---------------------------------------------------------------------------
// describe_environment
// ---------------------------------------------------------------------------

/**
 * `describe_environment` input — no parameters. An empty STRICT object so any
 * passed key is rejected (the tool takes no filters; the report is the tenant's
 * full capabilities/scopes/stats snapshot).
 */
export const describeEnvironmentInputSchema = z.object({}).strict()
export type DescribeEnvironmentInput = z.infer<typeof describeEnvironmentInputSchema>

/**
 * `describe_environment` output. REDACTION-CRITICAL (hard rule 6): capabilities
 * (tool NAMES + count + server version), the scope registry, and bounded COUNTS
 * only. The schema is structurally incapable of carrying an env value, DSN, key,
 * or base URL — there is no field for one. A `.strict()` object additionally
 * rejects any stray key a future edit might add by mistake.
 */
export const describeEnvironmentOutputSchema = z
  .object({
    capabilities: z
      .object({
        tools: z.array(z.string()),
        toolCount: z.number().int().min(0),
        version: z.string(),
      })
      .strict()
      .meta(OPEN_OUTPUT_META),
    scopes: z.array(scopeRecordSchema),
    stats: z
      .object({
        memoriesByType: z.record(z.string(), z.number().int().min(0)),
        activeMemories: z.number().int().min(0),
        supersededMemories: z.number().int().min(0),
        archivedMemories: z.number().int().min(0),
        commitmentsByStatus: z.record(z.string(), z.number().int().min(0)),
      })
      .strict()
      .meta(OPEN_OUTPUT_META),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type DescribeEnvironmentOutput = z.infer<typeof describeEnvironmentOutputSchema>

// ---------------------------------------------------------------------------
// review_proposals
// ---------------------------------------------------------------------------

/** Default review window for the proposals list (no-firehose, docs/concepts/mcp-design.mdx). */
export const DEFAULT_PROPOSALS_LIMIT = 25
/** Upper bound a caller may request for the proposals list. */
export const MAX_PROPOSALS_LIMIT = 100

/**
 * `review_proposals` input — an ACTION DISCRIMINATOR (list | reject | accept).
 *
 * - `list`   : optional status filter ({@link proposalStatusSchema}) + bounded
 *   limit (default {@link DEFAULT_PROPOSALS_LIMIT}). handler asserts memory:read.
 * - `reject` : proposalId; status proposed -> rejected. memory:write (handler).
 * - `accept` : proposalId; returns a typed not_implemented (the consolidator
 *   that applies a proposal is not built).
 *   memory:write (handler), so an accept attempt is still scope-gated.
 *
 * Two-layer scope model (same as configure_scope): the tool's registry
 * requiredScope is an anyOf floor (memory:read | memory:write); the handler
 * asserts the exact action scope (list → read, reject/accept → write).
 */
export const reviewProposalsInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      status: proposalStatusSchema.optional(),
      limit: z.number().int().min(1).max(MAX_PROPOSALS_LIMIT).default(DEFAULT_PROPOSALS_LIMIT),
    })
    .strict(),
  z.object({ action: z.literal('reject'), proposalId: z.uuid() }).strict(),
  z.object({ action: z.literal('accept'), proposalId: z.uuid() }).strict(),
])
export type ReviewProposalsInput = z.infer<typeof reviewProposalsInputSchema>

/**
 * REGISTRATION shape for the SDK (permissive flat object; the union is not a raw
 * shape). The HANDLER re-parses with the strict {@link reviewProposalsInputSchema}
 * union for real per-action validation.
 */
export const reviewProposalsRegisterShape = {
  action: z.enum(['list', 'reject', 'accept']),
  status: proposalStatusSchema.optional(),
  limit: z.number().int().min(1).max(MAX_PROPOSALS_LIMIT).optional(),
  proposalId: z.uuid().optional(),
} as const

/** One consolidation-proposal record in a tool result. rationale may be null. */
export const proposalRecordSchema = z
  .object({
    id: z.uuid(),
    fromId: z.uuid(),
    toId: z.uuid(),
    edgeType: edgeTypeSchema,
    memoryType: memoryTypeSchema,
    similarity: z.number(),
    rationale: z.string().nullable(),
    status: proposalStatusSchema,
    decidedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ProposalRecordOutput = z.infer<typeof proposalRecordSchema>

/**
 * `review_proposals` output — a discriminated result mirroring the action:
 * `list` returns the bounded record list + count; `rejected` and `applied` echo
 * the updated record (the proposal row with its new status + decided_at). ACCEPT
 * now SHIPS: it materializes the proposed edge, closes the
 * predecessor for a supersedes/updates edge, and returns the `applied` variant.
 */
export const reviewProposalsOutputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      proposals: z.array(proposalRecordSchema),
      count: z.number().int().min(0),
    })
    .strict()
    .meta(OPEN_OUTPUT_META),
  z
    .object({ action: z.literal('rejected'), proposal: proposalRecordSchema })
    .strict()
    .meta(OPEN_OUTPUT_META),
  z
    .object({ action: z.literal('applied'), proposal: proposalRecordSchema })
    .strict()
    .meta(OPEN_OUTPUT_META),
])
export type ReviewProposalsOutput = z.infer<typeof reviewProposalsOutputSchema>

/**
 * REGISTRATION output shape for the SDK (permissive: admits all variants). The
 * HANDLER builds and validates the exact result with the strict
 * {@link reviewProposalsOutputSchema} union before returning.
 */
export const reviewProposalsRegisterOutputShape = {
  action: z.enum(['list', 'rejected', 'applied']),
  proposals: z.array(proposalRecordSchema).optional(),
  count: z.number().int().min(0).optional(),
  proposal: proposalRecordSchema.optional(),
} as const

// ---------------------------------------------------------------------------
// briefing + handoff (docs/concepts/mcp-design.mdx orientation tools)
// ---------------------------------------------------------------------------

/**
 * The orientation SELECTOR — a REQUIRED, discriminated choice of which slice of
 * memory to brief/hand off over (docs/concepts/mcp-design.mdx no-firehose centerpiece). There is
 * NO unfiltered default: a caller MUST pick `all`, a `scope`, or a `project`, so
 * the schema makes the selector REQUIRED on every orientation input. The
 * discriminated union means a `scope` selector carries a scope (and only a scope),
 * a `project` selector a project — an `all` selector carries nothing.
 *
 * PROJECT SCOPING: a `project` selector matches ONLY memories
 * written WITH that project (commitments and blockers included). A commitment or
 * blocker remembered without a `project` lands with project=NULL and never
 * appears in a project briefing — pass `project` on remember to make it
 * project-scoped.
 */
export const briefingSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('scope'), scope: scopeSchema }).strict(),
  z.object({ kind: z.literal('project'), project: projectSchema }).strict(),
])
export type BriefingSelectorInput = z.infer<typeof briefingSelectorSchema>

/**
 * The OUTPUT-side selector union — the SAME three variants, marked open for the
 * advertised JSON Schema ({@link OPEN_OUTPUT_META}, issue #154).
 *
 * The selector is the ONE object reachable from BOTH an input and an output
 * tree: briefing/handoff take it as an argument AND echo it back. Marking the
 * shipped union in place would leak open-ness into the INPUT advertisement, so
 * the openness rides a DERIVATION — `.meta()` clones, leaving
 * {@link briefingSelectorSchema} (the input path) byte-identical, and the two
 * unions parse and infer identically.
 */
const [allSelector, scopeSelector, projectSelector] = briefingSelectorSchema.options
export const briefingSelectorOutputSchema = z.discriminatedUnion('kind', [
  allSelector.meta(OPEN_OUTPUT_META),
  scopeSelector.meta(OPEN_OUTPUT_META),
  projectSelector.meta(OPEN_OUTPUT_META),
])
export type BriefingSelectorOutput = z.infer<typeof briefingSelectorOutputSchema>

/** Briefing detail level. `brief` (default) = counts + top items; `full` = bounded lists. */
export const briefingModeSchema = z.enum(['brief', 'full'])
export type BriefingModeInput = z.infer<typeof briefingModeSchema>

/**
 * `briefing` input — REQUIRES an explicit {@link briefingSelectorSchema} (the
 * no-firehose rule, docs/concepts/mcp-design.mdx). `mode` defaults to `brief` (counts + a small
 * top slice per section); `full` returns the bounded lists. No other knobs: the
 * sections and their bounds are policy, not caller-tunable.
 */
export const briefingToolInputSchema = z
  .object({
    selector: briefingSelectorSchema,
    mode: briefingModeSchema.default('brief'),
  })
  .strict()
export type BriefingToolInput = z.infer<typeof briefingToolInputSchema>

/** A commitment line in the briefing (ids/topic/status/due + the overdue flag). */
export const briefingCommitmentSchema = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    topic: z.string(),
    status: commitmentStatusSchema,
    dueAt: z.iso.datetime().nullable(),
    overdue: z.boolean(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type BriefingCommitmentOutput = z.infer<typeof briefingCommitmentSchema>

/**
 * A memory line in a briefing section — TOPIC/metadata only, NO content. A
 * briefing orients ("here is what is open/stale/decided"); carrying full content
 * is the `handoff` tool's job (and even there it is bounded). Keeping content out
 * of the briefing is the output-discipline guard against the 50KB firehose.
 */
export const briefingMemoryItemSchema = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string(),
    scope: scopeSchema,
    project: projectSchema.nullable(),
    recordedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type BriefingMemoryItemOutput = z.infer<typeof briefingMemoryItemSchema>

/** One briefing section: the total COUNT plus a bounded item slice (the envelope). */
function briefingSectionSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      count: z.number().int().min(0),
      items: z.array(item),
    })
    .strict()
    .meta(OPEN_OUTPUT_META)
}

/**
 * `briefing` output — the selector echoed back, the mode, and one size-disciplined
 * section per orientation concern (commitments, the overdue split, blockers, stale
 * candidates, recent decisions, preferences). Each section is a count + bounded
 * slice; no section carries memory content (that is `handoff`'s job).
 */
export const briefingToolOutputSchema = z
  .object({
    selector: briefingSelectorOutputSchema,
    mode: briefingModeSchema,
    generatedAt: z.iso.datetime(),
    commitments: briefingSectionSchema(briefingCommitmentSchema),
    overdue: briefingSectionSchema(briefingCommitmentSchema),
    blockers: briefingSectionSchema(briefingMemoryItemSchema),
    staleCandidates: briefingSectionSchema(briefingMemoryItemSchema),
    recentDecisions: briefingSectionSchema(briefingMemoryItemSchema),
    preferences: briefingSectionSchema(briefingMemoryItemSchema),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type BriefingToolOutput = z.infer<typeof briefingToolOutputSchema>

/**
 * `handoff` input — same REQUIRED selector discipline as briefing (no-firehose).
 * `generatedFor` is an optional free-form label for the receiving agent, echoed
 * back into the payload. No mode: a handoff always returns its bounded context
 * lists (content INCLUDED by design — see the output schema note).
 */
export const handoffToolInputSchema = z
  .object({
    selector: briefingSelectorSchema,
    generatedFor: z.string().trim().min(1).max(256).optional(),
  })
  .strict()
export type HandoffToolInput = z.infer<typeof handoffToolInputSchema>

/**
 * A decision/preference line in a handoff — CONTENT INCLUDED BY DESIGN. Unlike a
 * briefing item, a handoff carries the memory `content` (a bounded EXCERPT,
 * {@link MAX_EXCERPT_LENGTH}, with `contentLength` + `truncated`)
 * because its PURPOSE is to transport context to a receiving agent. This is NOT
 * a hard-rule-6 violation: rule 6 forbids content in LOGS/traces/metrics, an
 * observability sink — a handoff is a deliberate data EXPORT to the
 * authenticated caller, and the transport never logs the payload.
 */
export const handoffMemorySchema = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string(),
    content: z.string().max(MAX_EXCERPT_LENGTH),
    contentLength: z.number().int().min(0),
    truncated: z.boolean(),
    scope: scopeSchema,
    project: projectSchema.nullable(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type HandoffMemoryOutput = z.infer<typeof handoffMemorySchema>

/** A commitment line in a handoff (the obligation a receiving agent must carry). */
export const handoffCommitmentSchema = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    topic: z.string(),
    status: commitmentStatusSchema,
    dueAt: z.iso.datetime().nullable(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type HandoffCommitmentOutput = z.infer<typeof handoffCommitmentSchema>

/**
 * `handoff` output — the selector echoed back, an optional `generatedFor` label,
 * and the bounded context a receiving agent needs to pick up the thread:
 * decisions, open commitments, preferences (content INCLUDED — see
 * {@link handoffMemorySchema}). `notes` is a reserved free-form list kept stable
 * for the receiver.
 */
export const handoffToolOutputSchema = z
  .object({
    selector: briefingSelectorOutputSchema,
    generatedFor: z.string().nullable(),
    generatedAt: z.iso.datetime(),
    decisions: z.array(handoffMemorySchema),
    commitments: z.array(handoffCommitmentSchema),
    preferences: z.array(handoffMemorySchema),
    notes: z.array(z.string()),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type HandoffToolOutput = z.infer<typeof handoffToolOutputSchema>

// ===========================================================================
// search filters V2 — memoryTypes[] + recorded_at range (issue #48, epic #42).
// APPENDED block: the shipped V1 contracts above stay byte-identical; V2 is a
// NEW composition over them (the composed-schema pattern, ADR-0011), exactly
// how searchQuerySchema composes searchFiltersSchema onto searchInputSchema.
// ===========================================================================

/**
 * Upper bound on the `memoryTypes` OR-set. The memory-type enum is small; 8 is
 * a generous ceiling that keeps the filter a bounded narrowing, never a
 * firehose-shaped list parameter.
 */
export const MAX_MEMORY_TYPES_FILTER = 8

/**
 * The V2 search FILTER additions — two new candidate-narrowing axes:
 *   - `memoryTypes`     → an OR-set over memories.memory_type
 *     (`memory_type = ANY(...)` in the db layer). Each element reuses
 *     {@link memoryTypeSchema}, the SAME contract the column is written
 *     against. Non-empty (an empty set is "match nothing" — a caller error,
 *     rejected loudly) and bounded by {@link MAX_MEMORY_TYPES_FILTER}.
 *   - `recordedAfter` / `recordedBefore` → an INCLUSIVE transaction-time range
 *     on memories.recorded_at (ISO datetimes, matching asOfSchema's bounds).
 *     UNLIKE `asOf`, the range does NOT lift the active-only default: it is a
 *     plain narrowing of the live view ("what did I record last week"), not
 *     bi-temporal time travel. Time travel stays `asOf`'s job.
 *
 * `.partial()` like {@link searchFiltersSchema}: an absent filter never narrows
 * its axis. Tags filtering is deliberately NOT here (deferred to its own epic).
 */
export const searchFiltersV2Schema = z
  .object({
    // The mutual exclusion with memoryType is RUNTIME-enforced by the
    // searchQueryV2Schema superRefine below; a custom refinement is invisible
    // in the JSON Schema tools/list advertises, so the constraint is ALSO
    // stated in both fields' descriptions (memoryType's V2 override lives in
    // searchQueryV2Schema) for schema-driven clients and generated docs.
    memoryTypes: z
      .array(memoryTypeSchema)
      .min(1)
      .max(MAX_MEMORY_TYPES_FILTER)
      .describe(
        'OR-set of memory types to match. Mutually exclusive with memoryType — pass one or the other, never both.',
      ),
    recordedAfter: z.iso.datetime().describe(recordedBoundDescription('recordedAfter')),
    recordedBefore: z.iso.datetime().describe(recordedBoundDescription('recordedBefore')),
  })
  .partial()
  .strict()
export type SearchFiltersV2Input = z.infer<typeof searchFiltersV2Schema>

/**
 * The V2 search query contract: the shipped {@link searchQuerySchema} (query +
 * limit + the five V1 filters) EXTENDED with {@link searchFiltersV2Schema} —
 * the same composition pattern, one validation boundary (hard rule 2). The MCP
 * `search` tool registers THIS schema; V1 consumers keep parsing the untouched
 * `searchQuerySchema`.
 *
 * MUTUAL EXCLUSION: `memoryTypes` is the PLURAL form of the V1 `memoryType`
 * axis. Supplying both is ambiguous (intersect? union?), so it is REJECTED at
 * the boundary rather than silently resolved — pass one or the other. The
 * superRefine is the ENFORCEMENT; because a custom refinement does not survive
 * into the emitted JSON Schema, the constraint is also ADVERTISED in both
 * fields' descriptions (memoryTypes in searchFiltersV2Schema; memoryType via
 * the V2-only override below — the shipped V1 schemas stay untouched).
 *
 * RANGE SANITY: the shared recorded-range rules ({@link recordedRangeIssues},
 * issue #58 — the SAME rule set the REST memoriesListQuerySchema applies, so
 * the two transports cannot drift): an INVERTED range (recordedAfter later
 * than recordedBefore) can never match anything — a caller error, rejected
 * loudly instead of silently returning an empty result (equal bounds are a
 * valid single-instant range, both bounds inclusive) — and a bound with
 * sub-millisecond fractional seconds is rejected rather than silently
 * truncated by the ISO→Date conversion at the transport (recorded_at is
 * microsecond-precise in Postgres; a truncated bound would leak boundary
 * rows past an inclusive bound).
 */
export const searchQueryV2Schema = searchQuerySchema
  .extend({
    ...searchFiltersV2Schema.shape,
    memoryType: searchQuerySchema.shape.memoryType.describe(
      'Single memory type to match. Mutually exclusive with memoryTypes — pass one or the other, never both.',
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
  })
export type SearchQueryV2Input = z.infer<typeof searchQueryV2Schema>
/**
 * Caller-side (pre-parse) shape: `z.input` where the defaulted `limit` is
 * OPTIONAL. See {@link RememberToolArgs}.
 */
export type SearchQueryV2Args = z.input<typeof searchQueryV2Schema>
