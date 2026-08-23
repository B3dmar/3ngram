// SPDX-License-Identifier: Apache-2.0
// Session-control contracts (docs/concepts/session-continuity.mdx).
// One validation boundary: enums and payload shape live HERE. Native write
// table + provenance payload. Native write plumbing lives on
// nativeRememberInputSchema (packages/schema/src/write.ts).
import { z } from 'zod'
import { briefingSelectorV2Schema } from './briefing-bounds.js'
import { scopeSchema } from './scope.js'
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

/** Closed native-write payload. JSON keys are spelling-sensitive — the index uses the same spelling. */
export const sessionProvenancePayloadSchema = z
  .object({
    sessionRunId: z.uuid(),
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
