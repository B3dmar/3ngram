// SPDX-License-Identifier: Apache-2.0
// REST /api/v1 dashboard-facing I/O contracts (docs/concepts/architecture.mdx thin
// transports, hard rule 2: the ONE validation boundary). The dashboard's typed
// clients code against EXACTLY these shapes — this file FREEZES that contract.
//
// These schemas are REST-only (no MCP tool mirror): list/inspect memories, list
// proposals, the stats envelope, and /me. They live HERE (packages/schema), not
// in apps/server, so the dashboard and the server share one validation boundary
// and cannot drift. Reused enum/value constraints (memoryType/scope/project) are
// imported from the existing domain schemas — never re-declared.
//
// Output discipline (docs/concepts/mcp-design.mdx): list reads are BOUNDED at the input boundary
// (limit/offset) and the output rows carry IDENTITY + ORIENTATION fields only
// (id, type, topic, project, scope, timestamps) — NEVER memory content. The
// detail (inspect) read carries content because that is its JTBD, bounded by the
// same write-time content cap.
import { z } from 'zod'
import { commitmentStatusSchema } from './commitment.js'
import { proposalStatusSchema } from './consolidation.js'
import { MAX_MEMORY_TYPES_FILTER, searchFiltersSchema } from './mcp.js'
import {
  actorKindSchema,
  edgeTypeSchema,
  eventKindSchema,
  memoryStatusSchema,
  memoryTypeSchema,
} from './memory.js'
import { recordedRangeIssues } from './recorded-range.js'
import { scopeSchema } from './scope.js'
import { projectSchema } from './write.js'

// ---------------------------------------------------------------------------
// POST /api/v1/dashboard/search - dashboard search continuation
// ---------------------------------------------------------------------------

/** Dashboard search page size. Kept separate from the MCP search default. */
export const DEFAULT_DASHBOARD_SEARCH_LIMIT = 25
/** Dashboard search page ceiling. MCP MAX_SEARCH_LIMIT remains unchanged. */
export const MAX_DASHBOARD_SEARCH_LIMIT = 25

/**
 * POST /api/v1/dashboard/search body contract for the dashboard. This REST-only
 * shape adds an opaque keyset `cursor` for explicit continuation while reusing
 * the canonical search filters. The MCP tool keeps `searchQuerySchema`
 * unchanged: no cursor, default 5, max 25. The cursor is row-anchored (not a
 * numeric offset), so continuation pages cannot skip or repeat rows when fusion
 * scores are recomputed per request (see {@link cursorPayloadSchema}).
 */
export const dashboardSearchQuerySchema = z
  .object({
    query: z.string().trim().min(1),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_DASHBOARD_SEARCH_LIMIT)
      .default(DEFAULT_DASHBOARD_SEARCH_LIMIT),
    cursor: z.string().min(1).optional(),
  })
  .extend(searchFiltersSchema.shape)
  .strict()
export type DashboardSearchQuery = z.infer<typeof dashboardSearchQuerySchema>

/**
 * One dashboard search hit. Identity + ranking/status metadata only: no memory
 * content, no excerpt, no hash, no embedding. `commitmentStatus` is present only
 * when a commitment FSM row rides the memory.
 */
export const dashboardSearchHitSchema = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string(),
    score: z.number(),
    commitmentStatus: commitmentStatusSchema.optional(),
  })
  .strict()
export type DashboardSearchHit = z.infer<typeof dashboardSearchHitSchema>

/**
 * POST /api/v1/dashboard/search response. `count` is the returned page length.
 * `hasMore` is computed by the route via one-row overfetch; this contract
 * deliberately does not expose or imply a total count for the ranked candidate
 * set. `nextCursor` is the opaque keyset token to fetch the next page; it is
 * present IFF `hasMore` is true (the route emits it from the last page row).
 */
export const dashboardSearchResponseSchema = z
  .object({
    hits: z.array(dashboardSearchHitSchema).max(MAX_DASHBOARD_SEARCH_LIMIT),
    count: z.number().int().min(0).max(MAX_DASHBOARD_SEARCH_LIMIT),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
  })
  .strict()
export type DashboardSearchResponse = z.infer<typeof dashboardSearchResponseSchema>

// ---------------------------------------------------------------------------
// GET /api/v1/memories — bounded list
// ---------------------------------------------------------------------------

/** Default page size for the memories list (no-firehose). */
export const DEFAULT_MEMORIES_LIMIT = 25
/** Upper bound a caller may request for the memories list (no-firehose ceiling). */
export const MAX_MEMORIES_LIMIT = 100

/**
 * GET /api/v1/memories query contract. Every field is OPTIONAL and NARROWING:
 * an absent filter is "do not narrow on this axis". `limit`/`offset` page the
 * bounded list; `type`/`scope`/`project` filter on the matching memory columns.
 * Numeric query params arrive as strings over a GET, so the transport coerces
 * them before parse; this schema validates the coerced shape. `.strict()` makes
 * an unknown query key a 400 (never a silent drop).
 */
export const memoriesListQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_MEMORIES_LIMIT).default(DEFAULT_MEMORIES_LIMIT),
    offset: z.number().int().min(0).default(0),
    // The type/memoryTypes mutual exclusion is RUNTIME-enforced by the
    // superRefine below; a custom refinement is invisible in the generated
    // OpenAPI document, so the constraint is ALSO stated in both params'
    // descriptions (mirrors the MCP searchQueryV2Schema fields).
    type: memoryTypeSchema
      .optional()
      .describe(
        'Single memory type to match. Mutually exclusive with memoryTypes — pass one or the other, never both.',
      ),
    scope: scopeSchema.optional(),
    // Express gives string when param appears once, string[] when repeated (?project=a&project=b).
    project: z.union([projectSchema, z.array(projectSchema)]).optional(),
    status: memoryStatusSchema.optional(),
    // Filters V2 (issue #48) — REST parity with the MCP search V2 axes.
    // memoryTypes: an OR-set over memory_type. Repeated-param handling mirrors
    // `project` above (string once, string[] when repeated); bounded by
    // MAX_MEMORY_TYPES_FILTER when repeated. Mutually exclusive with the scalar
    // `type` axis — enforced by the superRefine below, same rule as the MCP
    // searchQueryV2Schema boundary.
    memoryTypes: z
      .union([memoryTypeSchema, z.array(memoryTypeSchema).min(1).max(MAX_MEMORY_TYPES_FILTER)])
      .optional()
      .describe(
        'OR-set of memory types to match (repeat the param to pass several). Mutually exclusive with type — pass one or the other, never both.',
      ),
    // recordedAfter/recordedBefore: an INCLUSIVE recorded_at range. The list is
    // ALWAYS live-gated (valid_to IS NULL), so the range narrows within the live
    // view — consistent with search filters V2: a recorded_at range is never
    // time travel and never widens what a read surfaces.
    recordedAfter: z.iso.datetime().optional(),
    recordedBefore: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type !== undefined && v.memoryTypes !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['memoryTypes'],
        message: 'memoryTypes is mutually exclusive with type — pass one or the other',
      })
    }
    // Recorded-range sanity (issue #58): the SAME shared rule set as the MCP
    // searchQueryV2Schema — an inverted range or a sub-millisecond bound is a
    // 400 at the boundary, never an empty 200 or a silently truncated bound.
    for (const issue of recordedRangeIssues(v)) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message })
    }
  })
export type MemoriesListQuery = z.infer<typeof memoriesListQuerySchema>

/**
 * One memory in a list result. IDENTITY + ORIENTATION only (hard rule 6): NO
 * content, hash, or embedding. `project` may be null (an unscoped memory).
 */
export const memoryListItemSchema = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string(),
    project: projectSchema.nullable(),
    scope: scopeSchema,
    status: memoryStatusSchema,
    commitmentStatus: commitmentStatusSchema.optional(),
    recordedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .strict()
export type MemoryListItem = z.infer<typeof memoryListItemSchema>

/**
 * GET /api/v1/memories response envelope. `count` is the returned page length
 * (count-consistency: it mirrors `memories.length`); `total` is the unpaged row
 * count for the same filters, so the dashboard can render pagination.
 */
export const memoriesListResponseSchema = z
  .object({
    memories: z.array(memoryListItemSchema),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
  })
  .strict()
export type MemoriesListResponse = z.infer<typeof memoriesListResponseSchema>

// ---------------------------------------------------------------------------
// GET /api/v1/memories/:id — inspect (detail)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/memories/:id response. The inspect JTBD: the full memory row for a
 * single id, INCLUDING content (its reason to exist) plus tags and the
 * bi-temporal coordinates. `validTo`/`project` may be null.
 */
export const memoryDetailSchema = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string(),
    content: z.string(),
    scope: scopeSchema,
    project: projectSchema.nullable(),
    status: memoryStatusSchema,
    commitmentStatus: commitmentStatusSchema.optional(),
    tags: z.array(z.string()),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    recordedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .strict()
export type MemoryDetail = z.infer<typeof memoryDetailSchema>

// ---------------------------------------------------------------------------
// GET /api/v1/memories/:id/history — identity-only lineage + audit trail
// ---------------------------------------------------------------------------

/**
 * User-facing lifecycle state for a memory history view. `current` means an
 * active row with no `validTo`; `archived` is an archived memory row; `superseded`
 * is a historical row closed by a successor edge; `historical` is any other
 * non-current historical row, such as imported point-in-time history.
 */
export const memoryHistoryLifecycleStateSchema = z.enum([
  'current',
  'superseded',
  'archived',
  'historical',
])
export type MemoryHistoryLifecycleState = z.infer<typeof memoryHistoryLifecycleStateSchema>

/**
 * Identity + orientation only for any memory appearing in history/relationships.
 * No content, tags, hash, embedding, or event payload appears in this shape.
 */
export const memoryHistoryIdentitySchema = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string(),
    project: projectSchema.nullable(),
    scope: scopeSchema,
    status: memoryStatusSchema,
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    recordedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    isCurrent: z.boolean(),
    lifecycleState: memoryHistoryLifecycleStateSchema,
  })
  .strict()
export type MemoryHistoryIdentity = z.infer<typeof memoryHistoryIdentitySchema>

/** A typed memory graph edge. Direction is literal: fromId is successor/source, toId is predecessor/target. */
export const memoryHistoryEdgeSchema = z
  .object({
    id: z.uuid(),
    fromId: z.uuid(),
    toId: z.uuid(),
    edgeType: edgeTypeSchema,
    createdBy: actorKindSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()
export type MemoryHistoryEdge = z.infer<typeof memoryHistoryEdgeSchema>

/** A direct predecessor/successor relationship for the inspected memory. */
export const memoryHistoryRelationshipSchema = z
  .object({
    memory: memoryHistoryIdentitySchema,
    edge: memoryHistoryEdgeSchema,
  })
  .strict()
export type MemoryHistoryRelationship = z.infer<typeof memoryHistoryRelationshipSchema>

/**
 * Metadata about an event payload. This deliberately exposes only coarse
 * shape/size, never raw payload values or arbitrary payload keys.
 */
export const memoryHistoryEventPayloadMetadataSchema = z
  .object({
    present: z.boolean(),
    jsonType: z.enum(['object', 'array', 'string', 'number', 'boolean', 'null']).nullable(),
    byteLength: z.number().int().min(0),
  })
  .strict()
export type MemoryHistoryEventPayloadMetadata = z.infer<
  typeof memoryHistoryEventPayloadMetadataSchema
>

/** One lifecycle audit row for the inspected memory, with payload metadata only. */
export const memoryHistoryEventSchema = z
  .object({
    id: z.uuid(),
    eventKind: eventKindSchema,
    actorKind: actorKindSchema,
    createdAt: z.iso.datetime(),
    payloadMetadata: memoryHistoryEventPayloadMetadataSchema,
  })
  .strict()
export type MemoryHistoryEvent = z.infer<typeof memoryHistoryEventSchema>

/** Per-section load status for the history view (graceful degradation). */
export const memoryHistorySectionStatusSchema = z.enum(['ok', 'unavailable'])
export type MemoryHistorySectionStatus = z.infer<typeof memoryHistorySectionStatusSchema>

/**
 * Partial-failure flags: `unavailable` means that section could not be read and
 * its arrays are returned empty. The `lineage` group covers lineage + direct
 * relationships; `events` covers the audit trail. Both `unavailable` is the only
 * total-failure case the surface may render as "history unavailable".
 */
export const memoryHistorySectionsSchema = z
  .object({
    lineage: memoryHistorySectionStatusSchema,
    events: memoryHistorySectionStatusSchema,
  })
  .strict()
export type MemoryHistorySections = z.infer<typeof memoryHistorySectionsSchema>

/** GET /api/v1/memories/:id/history response envelope. */
export const memoryHistoryResponseSchema = z
  .object({
    memory: memoryHistoryIdentitySchema,
    lineage: z
      .object({
        nodes: z.array(memoryHistoryIdentitySchema),
        edges: z.array(memoryHistoryEdgeSchema),
        truncated: z.boolean(),
      })
      .strict(),
    directRelationships: z
      .object({
        predecessors: z.array(memoryHistoryRelationshipSchema),
        successors: z.array(memoryHistoryRelationshipSchema),
        truncated: z.boolean(),
      })
      .strict(),
    auditEvents: z.array(memoryHistoryEventSchema),
    eventsTruncated: z.boolean(),
    // Additive + optional-tolerant: older servers that omit it are treated as
    // all-`ok` by consumers; the web client casts the body and never re-validates.
    sections: memoryHistorySectionsSchema.optional(),
  })
  .strict()
export type MemoryHistoryResponse = z.infer<typeof memoryHistoryResponseSchema>

// ---------------------------------------------------------------------------
// GET /api/v1/proposals — bounded list over the existing core listProposals
// ---------------------------------------------------------------------------

/** Default page size for the proposals list (no-firehose). */
export const DEFAULT_REST_PROPOSALS_LIMIT = 25
/** Upper bound a caller may request for the proposals list. */
export const MAX_REST_PROPOSALS_LIMIT = 100

/**
 * GET /api/v1/proposals query contract: an optional `status` filter
 * ({@link proposalStatusSchema}) + a bounded `limit`. Numeric `limit` arrives as
 * a string over a GET, so the transport coerces it before parse.
 */
export const proposalsListQuerySchema = z
  .object({
    status: proposalStatusSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_REST_PROPOSALS_LIMIT)
      .default(DEFAULT_REST_PROPOSALS_LIMIT),
  })
  .strict()
export type ProposalsListQueryInput = z.infer<typeof proposalsListQuerySchema>

/**
 * POST /api/v1/proposals/:id/reject body — an OPTIONAL `{ rationale }`. The
 * dashboard may annotate a rejection; the field is bounded and validated here so
 * the route stays thin. An empty body is valid (no rationale).
 */
export const proposalRejectBodySchema = z
  .object({
    rationale: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
export type ProposalRejectBody = z.infer<typeof proposalRejectBodySchema>

// ---------------------------------------------------------------------------
// GET /api/v1/stats — the existing getEnvironmentStats bounded counts
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/stats response: the bounded COUNT aggregates from
 * getEnvironmentStats (hard rule 6: counts only, never content/values). The
 * per-type / per-status maps are open records of non-negative integers.
 */
export const statsResponseSchema = z
  .object({
    memoriesByType: z.record(z.string(), z.number().int().min(0)),
    activeMemories: z.number().int().min(0),
    supersededMemories: z.number().int().min(0),
    archivedMemories: z.number().int().nonnegative(),
    commitmentsByStatus: z.record(z.string(), z.number().int().min(0)),
  })
  .strict()
export type StatsResponse = z.infer<typeof statsResponseSchema>

// ---------------------------------------------------------------------------
// GET /api/v1/memories/facets — dynamic filter values from the live corpus
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/memories/facets response: DISTINCT scope + project values from
 * the tenant's live memories (status='active' AND valid_to IS NULL). Used by
 * the UI to populate filter dropdowns from actual corpus values.
 * Content discipline (hard rule 6): only bounded user-defined labels (scope,
 * project), never memory content.
 */
export const memoriesFacetsResponseSchema = z
  .object({
    scopes: z.array(scopeSchema),
    projects: z.array(projectSchema),
  })
  .strict()
export type MemoriesFacetsResponse = z.infer<typeof memoriesFacetsResponseSchema>

// ---------------------------------------------------------------------------
// GET /api/v1/me — the authenticated identity
// ---------------------------------------------------------------------------

/** GET /api/v1/me response: the authenticated user's id + email. */
export const meResponseSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
  })
  .strict()
export type MeResponse = z.infer<typeof meResponseSchema>

// ---------------------------------------------------------------------------
// DELETE /api/v1/account — self-serve account deletion
// ---------------------------------------------------------------------------

/**
 * DELETE /api/v1/account body: an explicit irreversible-action confirmation.
 * `confirm` MUST be the literal `true` — a missing/false value is a 400 at the
 * boundary, never a silent destructive call. The dashboard supplies it after a
 * type-to-confirm step.
 */
export const accountDeleteBodySchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict()
export type AccountDeleteBody = z.infer<typeof accountDeleteBodySchema>
