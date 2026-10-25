// SPDX-License-Identifier: Apache-2.0
// `revise` DISPOSITIONS (issue #216 umbrella): answers to a stale candidate
// that are neither a correction (successor) nor a refile (move).
//
//   - archive (issue #217): status 'active' -> 'archived' on each listed
//     memory. No successor, no edge; content, topic, tags and the bi-temporal
//     columns are untouched (hard rule 1's audited status carve-out).
//
// SHAPE: a bounded, de-duplicated `memoryIds` batch, never a single
// `predecessorId`. A stale-candidate review answers many rows at once, and
// the response reports one outcome PER ID instead of failing the whole call
// for one bad id. REST keeps its per-memory route: the URL id becomes the
// one-element batch, so both transports share this contract.
//
// CONFIRMATION (#106): a future confirmation step rides the protocol (an
// elicitation round-trip before the write), not an input field. Nothing here
// is named `confirm`/`confirmation`, so that layer can land without a schema
// break.
import { z } from 'zod'
import { OPEN_OUTPUT_META } from './output-openness.js'
import { sessionRunIdField } from './write.js'

/** Most memories one disposition call may name (a briefing page, with room). */
export const MAX_REVISE_DISPOSITION_IDS = 50

/** The disposition kinds `revise` accepts beside the successor and move shapes. */
export const reviseDispositionKindSchema = z.enum(['archive'])
export type ReviseDispositionKind = z.infer<typeof reviseDispositionKindSchema>

const memoryIdsField = z
  .array(z.uuid().toLowerCase())
  .min(1)
  .max(MAX_REVISE_DISPOSITION_IDS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'memoryIds must be unique' })
  .describe(
    `The memories to act on, 1-${MAX_REVISE_DISPOSITION_IDS} unique ids. Each id gets its own outcome; one bad id never fails the others.`,
  )

const dispositionFields = {
  kind: reviseDispositionKindSchema.describe(
    'archive: take each memory out of the active set (status archived). No successor; content, tags and dates untouched; recoverable with status: archived. Open commitments and blockers are rejected: settle those with resolve.',
  ),
  memoryIds: memoryIdsField,
  sessionRunId: sessionRunIdField,
}

/** Native disposition request: kind, the id batch, optional session provenance. */
export const nativeReviseDispositionInputSchema = z.object(dispositionFields).strict()
export type NativeReviseDispositionInput = z.infer<typeof nativeReviseDispositionInputSchema>

/** REST body of a disposition: the URL id is the one-element batch, so no `memoryIds`. */
export const nativeReviseDispositionBodySchema = nativeReviseDispositionInputSchema.omit({
  memoryIds: true,
})

/**
 * Payload of the `archive` memory event every archive disposition writes
 * (revise archive and the REST archive route). Strict and free-text-free: the
 * disposition plus the session provenance every write event carries.
 * `disposition` tells it apart from the `archive` events blocker resolve and the
 * commitment sweep write, which carry no disposition.
 */
export const archiveEventPayloadSchema = z
  .object({ sessionRunId: sessionRunIdField, disposition: z.literal('archive') })
  .strict()
export type ArchiveEventPayload = z.infer<typeof archiveEventPayloadSchema>

/**
 * Why one id was not acted on. `not_found` covers unknown and other-tenant ids
 * alike (no existence leak); `superseded` rows are already closed history;
 * `open_commitment` and `blocker` leave the active set through `resolve`.
 */
export const reviseDispositionRejectionSchema = z.enum([
  'not_found',
  'superseded',
  'open_commitment',
  'blocker',
])
export type ReviseDispositionRejection = z.infer<typeof reviseDispositionRejectionSchema>

/** What happened to one id. `already_archived` is the idempotent repeat. */
export const reviseDispositionOutcomeKindSchema = z.enum([
  'archived',
  'already_archived',
  'rejected',
])
export type ReviseDispositionOutcomeKind = z.infer<typeof reviseDispositionOutcomeKindSchema>

export const reviseDispositionOutcomeSchema = z
  .object({
    memoryId: z.uuid(),
    outcome: reviseDispositionOutcomeKindSchema,
    reason: reviseDispositionRejectionSchema
      .optional()
      .describe('Present only when outcome is rejected.'),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ReviseDispositionOutcome = z.infer<typeof reviseDispositionOutcomeSchema>

/** A disposition's response: the kind echoed and one outcome per requested id, in order. */
export const reviseDispositionOutputSchema = z
  .object({
    kind: reviseDispositionKindSchema,
    outcomes: z.array(reviseDispositionOutcomeSchema).max(MAX_REVISE_DISPOSITION_IDS),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ReviseDispositionOutput = z.infer<typeof reviseDispositionOutputSchema>
