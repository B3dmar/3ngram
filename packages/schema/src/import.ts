// SPDX-License-Identifier: Apache-2.0
// Import write contracts (groundwork for batch importers).
//
// These are the validated payloads the import facade (packages/core/src/import)
// accepts at the ONE validation boundary (AGENTS.md hard rule 2). An import is
// an ordinary append (docs/concepts/memory-model.mdx) whose original history is preserved: timestamps
// and status may be supplied by the caller, and the audit trail records an
// 'import' event whose bounded payload carries source-system identifiers.
import { z } from 'zod'
import { commitmentStatusSchema } from './commitment.js'
import { edgeTypeSchema, eventKindSchema, memoryStatusSchema } from './memory.js'
import { MAX_CONTENT_LENGTH, rememberInputSchema } from './write.js'

/** Serialized ceiling for a caller-supplied import event payload. The payload
 * carries source ids/types for correlation — it is metadata, never a body. */
export const MAX_IMPORT_PAYLOAD_LENGTH = 4096

/**
 * Import-path content ceiling (256K chars). Import sources carry real
 * historical content that must land as-is (the migration's frozen mapping:
 * prod has hundreds of rows over the native 2,000-char cap, max ~245K), so
 * the native MAX_CONTENT_LENGTH authoring cap does not apply here. This bound
 * exists to keep payloads sane, not to enforce authoring discipline.
 */
export const MAX_IMPORT_CONTENT_LENGTH = 262144

const serializedLength = (payload: Record<string, unknown>): number => {
  try {
    return JSON.stringify(payload).length
  } catch {
    // Unserializable (circular/BigInt) payloads can never be bounded — reject.
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Bounded JSON object persisted on an import audit event (memory_events.payload,
 * jsonb). Bounded by SERIALIZED length so jsonb's typelessness cannot smuggle an
 * unbounded body through the boundary (the tags-in-jsonb precedent).
 */
export const importEventPayloadSchema = z
  .record(z.string(), z.unknown())
  .refine((payload) => serializedLength(payload) <= MAX_IMPORT_PAYLOAD_LENGTH, {
    message: `import payload must serialize to at most ${MAX_IMPORT_PAYLOAD_LENGTH} characters`,
  })
export type ImportEventPayload = z.infer<typeof importEventPayloadSchema>

/** A caller-supplied historical instant: a Date or an ISO-8601 string (the
 * piped date check rejects strings that do not parse). `null` is rejected
 * outright — a required timestamp must be a real instant; bare z.coerce.date()
 * would silently coerce null to the 1970-01-01 epoch. Optional fields take
 * {@link nullableTimestampSchema} for DB-NULL semantics instead. */
export const importTimestampSchema = z
  .union([z.date(), z.string()], { error: 'expected a Date or an ISO-8601 timestamp string' })
  .pipe(z.coerce.date())

/** DB-NULL semantics for OPTIONAL timestamps: exporters commonly emit explicit
 * JSON `null` for nullable columns, so `null` and `undefined` both mean ABSENT
 * — never the 1970 epoch (which, on validTo, would mark a live imported memory
 * as superseded). Invalid strings still fail here at the one boundary. */
const nullableTimestampSchema = importTimestampSchema
  .nullish()
  .transform((value) => value ?? undefined)

/** Overrides for the 'import' audit event written with an imported memory. */
const importEventOverrideSchema = z
  .object({
    payload: importEventPayloadSchema.optional(),
    /** Original event time from the source system (memory_events.created_at). */
    createdAt: nullableTimestampSchema,
  })
  .strict()

/**
 * Initial FSM state for the commitment riding an imported commitment-type
 * memory. Inserted directly at this status: the FSM trigger (migration 0001)
 * guards UPDATE OF status only, so a historical commitment lands in its final
 * state without replaying transitions.
 */
export const importCommitmentSchema = z
  .object({
    status: commitmentStatusSchema.default('open'),
    owner: z.string().trim().min(1).max(256).optional(),
    dueAt: nullableTimestampSchema,
    resolvedAt: nullableTimestampSchema,
    recurrence: z.unknown().optional(),
  })
  .strict()
export type ImportCommitmentInput = z.infer<typeof importCommitmentSchema>

/**
 * `importMemory` payload: a full remember() payload plus original-history
 * overrides. Omitted timestamps take the column defaults (now()), exactly like
 * a native write — imported rows are indistinguishable from native ones apart
 * from their 'import' audit event.
 *
 * `validTo` set means the row is imported ALREADY SUPERSEDED (a closed
 * historical version); such a row sits outside the live-hash space, so the
 * duplicate guard does not apply to it.
 */
export const importMemoryInputSchema = rememberInputSchema
  .extend({
    /** Import-sized content bound (see MAX_IMPORT_CONTENT_LENGTH); topic and
     * tags keep the native bounds — they are labels, not historical bodies. */
    content: z.string().trim().min(1).max(MAX_IMPORT_CONTENT_LENGTH),
    status: memoryStatusSchema.default('active'),
    recordedAt: nullableTimestampSchema,
    validFrom: nullableTimestampSchema,
    validTo: nullableTimestampSchema,
    event: importEventOverrideSchema.optional(),
    commitment: importCommitmentSchema.optional(),
  })
  .strict()
  .refine((input) => !(input.validFrom && input.validTo) || input.validFrom <= input.validTo, {
    message: 'validFrom must not be after validTo',
    path: ['validTo'],
  })
  .refine((input) => !input.commitment || input.memoryType === 'commitment', {
    message: 'commitment state requires a commitment-type memory',
    path: ['commitment'],
  })
export type ImportMemoryInput = z.infer<typeof importMemoryInputSchema>

/** Historical lifecycle kinds an importer may append, DERIVED from the canonical
 * {@link eventKindSchema} (ONE validation boundary, AGENTS.md hard rule 2) minus
 * the two reserved kinds: 'import' is the row's own provenance event, and
 * 'embed_failed' is system-only. Deriving rather than hand-listing means new
 * lifecycle kinds — notably 'supersede' and 'unresolve', needed to replay real
 * supersession and commitment-reopen history during the legacy migration
 * — flow through automatically and can never silently drift. */
export const importEventKindSchema = eventKindSchema.exclude(['import', 'embed_failed'])
export type ImportEventKind = z.infer<typeof importEventKindSchema>

/** `importEvent` payload: an additional historical audit event for an imported
 * memory, with its original timestamp and a bounded source payload. */
export const importEventInputSchema = z
  .object({
    memoryId: z.uuid(),
    eventKind: importEventKindSchema,
    payload: importEventPayloadSchema.optional(),
    createdAt: nullableTimestampSchema,
  })
  .strict()
export type ImportEventInput = z.infer<typeof importEventInputSchema>

/**
 * `importEdge` payload: a typed edge between two imported memories. For a
 * 'supersedes' edge, `closePredecessorAt` additionally closes the predecessor's
 * (`toId`'s) bi-temporal validity at the supplied original instant — the same
 * close-only mutation revise() performs, never a content change (docs/concepts/memory-model.mdx).
 */
export const importEdgeInputSchema = z
  .object({
    fromId: z.uuid(),
    toId: z.uuid(),
    edgeType: edgeTypeSchema,
    closePredecessorAt: nullableTimestampSchema,
  })
  .strict()
  .refine((edge) => edge.fromId !== edge.toId, {
    message: 'an edge cannot point a memory at itself',
    path: ['toId'],
  })
  .refine((edge) => !edge.closePredecessorAt || edge.edgeType === 'supersedes', {
    message: 'closing the predecessor requires a supersedes edge',
    path: ['closePredecessorAt'],
  })
export type ImportEdgeInput = z.infer<typeof importEdgeInputSchema>

/** `importFact` payload: a bi-temporal subject/predicate/value row riding an
 * imported memory (the facts table models no other writer today). */
export const importFactInputSchema = z
  .object({
    memoryId: z.uuid(),
    subject: z.string().trim().min(1).max(256),
    predicate: z.string().trim().min(1).max(256),
    value: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
    confidence: z.number().min(0).max(1).optional(),
    validFrom: nullableTimestampSchema,
    validTo: nullableTimestampSchema,
    recordedAt: nullableTimestampSchema,
  })
  .strict()
  .refine((fact) => !(fact.validFrom && fact.validTo) || fact.validFrom <= fact.validTo, {
    message: 'validFrom must not be after validTo',
    path: ['validTo'],
  })
export type ImportFactInput = z.infer<typeof importFactInputSchema>
