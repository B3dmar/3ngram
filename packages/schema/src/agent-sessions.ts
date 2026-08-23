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
// Hook-facing session lifecycle: open / close / heartbeat
// (docs/concepts/session-continuity.mdx layers 1, 5 and 6).
//
// NATURAL KEY, NOT sessionRunId. Stop and SessionEnd are separate processes
// that hold the harness conversation id and nothing else, and the page forbids
// a local mapping file — so every lifecycle route addresses the row by
// `(agent, sessionId)` with `user_id` coming from the API key. Close also
// carries NO `activation_epoch`: SessionEnd cannot know it, and a stale close is
// transient because the next heartbeat or resume resurrects.
// ---------------------------------------------------------------------------

/**
 * The tenant-scoped address of one session row. `user_id` is NOT part of the
 * wire contract — it comes from the authenticated key, so a body can never name
 * another tenant's row.
 */
export const agentSessionNaturalKeySchema = z
  .object({
    agent: agentNameSchema,
    sessionId: harnessSessionIdSchema,
  })
  .strict()
export type AgentSessionNaturalKey = z.infer<typeof agentSessionNaturalKeySchema>

/**
 * `POST /api/v1/agent-sessions/open`.
 *
 * `briefedMemories` is an INPUT because the hook renders the briefing and then
 * TRUNCATES it locally (`BRIEFING_MAX_TOKENS`), so only the hook knows which
 * rows the agent actually saw. It reports the survivors; the server stamps
 * `briefing_delivered_at` at THIS POST rather than at the briefing GET —
 * otherwise the row would record commitments the agent never read.
 *
 * There is deliberately no `briefingDeliveredAt` input: the stamp is the POST,
 * and a client clock is not a fact the server should persist. Presence of the
 * `briefedMemories` KEY (an empty array included — a briefing that surfaced
 * nothing is still a delivery) is what triggers the stamp.
 *
 * `selector` defaults to the axis-free `all` selector, matching the shipped
 * hook, which omits the briefing axes entirely (`cmd/3ngram-hook/briefing.go`).
 */
export const agentSessionOpenBodySchema = z
  .object({
    agent: agentNameSchema,
    sessionId: harnessSessionIdSchema,
    source: agentSessionSourceSchema,
    // OMITTED, never the literal "unknown" deriveProject returns for an empty
    // cwd — a fake facet on the row would be indistinguishable from a real one.
    project: projectSchema.optional(),
    scope: scopeSchema.optional(),
    selector: briefingSelectorV2Schema.default({ kind: 'all' }),
    briefedMemories: z.array(briefedMemorySchema).max(MAX_BRIEFED_MEMORIES).optional(),
  })
  .strict()
/** The PARSED open input: `selector` is present, the default already applied. */
export type AgentSessionOpenInput = z.infer<typeof agentSessionOpenBodySchema>
/**
 * The open input as a CALLER writes it — `selector` optional, because the schema
 * supplies it. Facades take this at their boundary and parse; only code that has
 * already parsed should take {@link AgentSessionOpenInput}, or a TypeScript
 * caller is forced to hand-write the very default the schema exists to apply.
 */
export type AgentSessionOpenBodyInput = z.input<typeof agentSessionOpenBodySchema>

/**
 * The state `open` resolved to, so the hook can inject the right thing without
 * a second read. `created`/`reopened` are the resolution of `source` against
 * what was already stored; `sessionRunId` is what the agent passes on writes.
 */
export const agentSessionOpenResponseSchema = z
  .object({
    sessionRunId: sessionRunIdSchema,
    activationEpoch: z.number().int().positive(),
    /** Echo of the requested source. The row keeps the source it was inserted with. */
    source: agentSessionSourceSchema,
    /** This call inserted the row. */
    created: z.boolean(),
    /**
     * This call revived a row that was closed OR past its lease, and advanced
     * `activation_epoch`. Implicit close is evaluated on read and write, not
     * only after a sweeper has stamped `closed_at`, so a lease-expired row with
     * `closed_at` still null reopens too.
     */
    reopened: z.boolean(),
    openedAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    briefingDeliveredAt: z.iso.datetime().nullable(),
  })
  .strict()
export type AgentSessionOpenResponse = z.infer<typeof agentSessionOpenResponseSchema>

/** `POST /api/v1/agent-sessions/close` — natural key only, no epoch. */
export const agentSessionCloseBodySchema = agentSessionNaturalKeySchema
export type AgentSessionCloseInput = z.infer<typeof agentSessionCloseBodySchema>

/**
 * Idempotent close receipt. `closedAt` is the FIRST close's timestamp on a
 * repeat call: re-stamping it would move the row past the
 * `closed_at <= last_seen_at + lease` window that tells an explicit SessionEnd
 * apart from a sweeper's implicit close, forever.
 */
export const agentSessionCloseResponseSchema = z
  .object({
    sessionRunId: sessionRunIdSchema,
    activationEpoch: z.number().int().positive(),
    closedAt: z.iso.datetime(),
    alreadyClosed: z.boolean(),
  })
  .strict()
export type AgentSessionCloseResponse = z.infer<typeof agentSessionCloseResponseSchema>

/**
 * `POST /api/v1/agent-sessions/heartbeat` — lease refresh by natural key,
 * optionally carrying the turn's `last_assistant_message`.
 *
 * The excerpt is CLOSER INPUT, not a transcript: it is bounded here and the
 * hook must truncate locally to fit, the same contract the briefing rows ride.
 * A too-long excerpt is a 400 rather than a silent truncation — the server does
 * not get to decide which half of an agent's message matters.
 */
export const agentSessionHeartbeatBodySchema = z
  .object({
    agent: agentNameSchema,
    sessionId: harnessSessionIdSchema,
    lastMessageExcerpt: z.string().min(1).max(MAX_SESSION_EXCERPT_LENGTH).optional(),
  })
  .strict()
export type AgentSessionHeartbeatInput = z.infer<typeof agentSessionHeartbeatBodySchema>

/**
 * Heartbeat receipt. `resurrected` is true when the refresh reopened a row that
 * was closed or past its lease — the epoch advanced, so a closer claim fenced
 * at the previous epoch is now a no-op.
 */
export const agentSessionHeartbeatResponseSchema = z
  .object({
    sessionRunId: sessionRunIdSchema,
    activationEpoch: z.number().int().positive(),
    lastSeenAt: z.iso.datetime(),
    resurrected: z.boolean(),
  })
  .strict()
export type AgentSessionHeartbeatResponse = z.infer<typeof agentSessionHeartbeatResponseSchema>

// ---------------------------------------------------------------------------
// GET /api/v1/prompts/debrief — the MCP debrief registrar over REST
// ---------------------------------------------------------------------------

/**
 * Query contract for the REST debrief render.
 *
 * `agent` + `sessionId` are the natural key of the run whose `briefed_memories`
 * get inlined as the id -> topic/status mapping. They are individually optional
 * but move TOGETHER: half a natural key names no row, and silently rendering
 * without the mapping would hand the model "resolve what you completed" with no
 * ids — the exact failure the mapping exists to fix.
 *
 * Parsed from `req.query` WHOLE, so `.strict()` sees a misspelled key and 400s
 * instead of rendering a prompt that quietly ignored it (the same rule the
 * session-events query rides).
 */
export const debriefPromptQuerySchema = z
  .object({
    scope: scopeSchema.optional(),
    project: projectSchema.optional(),
    agent: agentNameSchema.optional(),
    sessionId: harnessSessionIdSchema.optional(),
  })
  .strict()
  .refine((q) => (q.agent === undefined) === (q.sessionId === undefined), {
    error: 'agent and sessionId must be supplied together (the run natural key)',
    path: ['sessionId'],
  })
export type DebriefPromptQueryInput = z.infer<typeof debriefPromptQuerySchema>

/**
 * The rendered prompt. One bounded string the hook injects verbatim as a Stop
 * continuation `reason`; no tenant data rides beside it.
 */
export const debriefPromptResponseSchema = z.object({ prompt: z.string().min(1) }).strict()
export type DebriefPromptResponse = z.infer<typeof debriefPromptResponseSchema>

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
