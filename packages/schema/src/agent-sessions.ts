// SPDX-License-Identifier: Apache-2.0
// Session-control contracts (docs/concepts/session-continuity.mdx).
// One validation boundary: enums and payload shape live HERE. Native write
// table + provenance payload. Native write plumbing lives on
// nativeRememberInputSchema (packages/schema/src/write.ts).
import { z } from 'zod'
import { briefingSelectorV2Schema } from './briefing-bounds.js'
import { actorKindSchema, eventKindSchema } from './memory.js'
import { scopeSchema } from './scope.js'
import { sessionRunIdSchema } from './session-run-id.js'
import { projectSchema } from './write.js'

/** Harness that opened the row. Open vocabulary — new harnesses must not need a migration. */
export const agentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case: lowercase alphanumerics and hyphens')
export type AgentName = z.infer<typeof agentNameSchema>

/** Harness conversation id from Stop/SessionStart stdin. */
export const harnessSessionIdSchema = z.string().trim().min(1).max(256)
export type HarnessSessionId = z.infer<typeof harnessSessionIdSchema>

export const agentSessionSourceSchema = z.enum(['startup', 'resume'])
export type AgentSessionSource = z.infer<typeof agentSessionSourceSchema>

export const agentSessionTriageStatusSchema = z.enum([
  'idle',
  'pending',
  'completed',
  'expired',
  'overflowed',
])
export type AgentSessionTriageStatus = z.infer<typeof agentSessionTriageStatusSchema>

/** Lease duration: overnight idle must still count as open. Evaluated on read/write. */
export const SESSION_LEASE_MS = 24 * 60 * 60 * 1000

/**
 * Closed native-write payload. JSON keys are spelling-sensitive — the index uses
 * the same spelling — and so is the VALUE: it is compared as `text` by
 * `payload->>'sessionRunId' = $1`, so the id rides the canonical
 * {@link sessionRunIdSchema} rather than a bare `z.uuid()`.
 */
export const sessionProvenancePayloadSchema = z
  .object({
    sessionRunId: sessionRunIdSchema,
  })
  .strict()
export type SessionProvenancePayload = z.infer<typeof sessionProvenancePayloadSchema>

export const briefedMemorySchema = z
  .object({
    id: z.uuid(),
    topic: z.string().trim().min(1).max(256),
    status: z.string().trim().min(1).max(64),
  })
  .strict()
export type BriefedMemory = z.infer<typeof briefedMemorySchema>

/** Upper bound on last_message_excerpt — closer input, not a transcript. */
export const MAX_SESSION_EXCERPT_LENGTH = 4000
/** Per-run ceiling on last_triaged_event_ids and listSessionEvents. */
export const MAX_SESSION_EVENT_IDS = 500
/** Surviving briefing rows stamped after local truncate. */
export const MAX_BRIEFED_MEMORIES = 100

export const agentSessionRowSchema = z
  .object({
    id: z.uuid(),
    agent: agentNameSchema,
    sessionId: harnessSessionIdSchema,
    source: agentSessionSourceSchema,
    project: projectSchema.nullable(),
    scope: scopeSchema.nullable(),
    selector: briefingSelectorV2Schema,
    activationEpoch: z.number().int().positive(),
    triageStatus: agentSessionTriageStatusSchema,
    triageAttemptId: z.uuid().nullable(),
    lastTriagedEventIds: z.array(z.uuid()).max(MAX_SESSION_EVENT_IDS),
    briefedMemories: z.array(briefedMemorySchema).max(MAX_BRIEFED_MEMORIES),
    lastMessageExcerpt: z.string().max(MAX_SESSION_EXCERPT_LENGTH).nullable(),
    openedAt: z.date(),
    closedAt: z.date().nullable(),
    lastSeenAt: z.date(),
    briefingDeliveredAt: z.date().nullable(),
  })
  .strict()
export type AgentSessionRow = z.infer<typeof agentSessionRowSchema>

// ---------------------------------------------------------------------------
// GET /api/v1/agent-sessions/:sessionRunId/events — typed provenance read
// ---------------------------------------------------------------------------

/** Hard per-call page size. The per-run ceiling is MAX_SESSION_EVENT_IDS. */
export const MAX_SESSION_EVENTS_LIMIT = 100
export const DEFAULT_SESSION_EVENTS_LIMIT = 50

/**
 * Query contract for the typed provenance read.
 *
 * `cursor` is the `id` of the last item of the previous page, echoed back
 * verbatim. It is NOT base64-wrapped: unlike the search cursor
 * (packages/schema/src/cursor.ts) there is no frozen ordering, no query
 * fingerprint and no scores to hide — the value is already published as
 * `items[].id` in the same response, so wrapping it would buy opacity the
 * response gives away anyway. Keyset on uuidv7 `id` over an append-only log
 * cannot duplicate or skip, so the token needs no drift guard. It needs no
 * case-canonicalization either, unlike `sessionRunId`: the cursor is compared
 * against `memory_events.id`, a `uuid` COLUMN, so Postgres parses either
 * spelling to the same value (see session-run-id.ts).
 *
 * `limit` COERCES because the whole `req.query` object is handed to this schema
 * unmodified — the route must not hand-pick `{ cursor, limit }` into a fresh
 * object, or `.strict()` never sees a misspelled key like `?cursro=` and the
 * request silently succeeds as page 1. Query values arrive as strings (and as
 * an ARRAY when a param is repeated, `?limit=1&limit=2`), which coercion turns
 * into NaN and the int/min/max checks then reject.
 */
export const sessionEventsQuerySchema = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_SESSION_EVENTS_LIMIT)
      .default(DEFAULT_SESSION_EVENTS_LIMIT),
  })
  .strict()
export type SessionEventsQueryInput = z.infer<typeof sessionEventsQuerySchema>

/**
 * One provenance event for a run. This is the NARROWING of the history rule
 * (packages/schema/src/rest.ts: never raw payload values or arbitrary payload
 * keys): exactly one payload key, `sessionRunId`, is projected — read with a
 * jsonb operator and parsed through {@link sessionProvenancePayloadSchema},
 * never `payload` as a blob. No memory content, topic, or tags.
 */
export const sessionEventSchema = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    eventKind: eventKindSchema,
    actorKind: actorKindSchema,
    sessionRunId: sessionRunIdSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()
export type SessionEvent = z.infer<typeof sessionEventSchema>

/**
 * One page of a run's provenance events, in uuidv7 `id` order.
 *
 * `nextCursor` is present exactly when another page exists WITHIN the per-run
 * ceiling. `truncated` is the separate, terminal signal that the run holds more
 * than {@link MAX_SESSION_EVENT_IDS} events at all — the closer must not
 * re-claim such a run (it is `overflowed`), so the two flags are not
 * interchangeable and a truncated run's last page still carries no cursor.
 */
export const sessionEventsResponseSchema = z
  .object({
    items: z.array(sessionEventSchema).max(MAX_SESSION_EVENTS_LIMIT),
    nextCursor: z.uuid().optional(),
    truncated: z.boolean(),
  })
  .strict()
export type SessionEventsResponse = z.infer<typeof sessionEventsResponseSchema>
