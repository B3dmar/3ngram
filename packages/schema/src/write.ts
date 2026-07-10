// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'
import { actorKindSchema, edgeTypeSchema, memoryTypeSchema } from './memory.js'
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

/** Per-write upper bound on raw content. Matches the S5 capture-hook contract. */
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
