// SPDX-License-Identifier: Apache-2.0
// Import facade (groundwork for batch importers).
//
// The ONE place the import JTBD is orchestrated, mirroring write/: each surface
// validates its RAW payload exactly once at the schema boundary (hard rule 2 —
// packages/db never re-validates), computes the content hash where relevant,
// and delegates atomic persistence to packages/db (hard rule 3). Every import
// write is recorded as the 'importer' actor class; apart from its 'import'
// audit event an imported row is indistinguishable from a native one.
//
// Append-and-supersede (hard rule 1) holds: imports only append; the only
// mutation is the revise()-precedent valid_to close of an imported predecessor.
//
// Observability (hard rule 6): never log memory content — this module logs
// nothing; callers that do must honour the same rule.
import { createHash } from 'node:crypto'
import {
  appendImportedEvent,
  insertImportedFact,
  writeImportedEdge,
  writeImportedMemory,
} from '@3ngram/db'
import {
  importEdgeInputSchema,
  importEventInputSchema,
  importFactInputSchema,
  importMemoryInputSchema,
} from '@3ngram/schema'
import { assertWithinBudget, resolveResourceLimits } from '../budget/index.js'
import { type EmbedOptions, kickEmbed } from '../write/embed.js'
import type { WriteResult } from '../write/remember.js'

export {
  DuplicateMemoryError,
  EdgeConflictError,
  ImportTargetNotFoundError,
  PredecessorAlreadySupersededError,
  type WrittenMemory,
} from '@3ngram/db'
export type { EmbedOptions } from '../write/embed.js'
export type { WriteResult } from '../write/remember.js'

/** Every import write records this actor class — it IS the import surface. */
const IMPORTER = 'importer' as const

/** Default Gateway operation key for import-path embeddings, so bulk import
 * cost is attributable separately from interactive 'memory.embed' traffic. */
export const IMPORT_EMBED_OPERATION = 'import.embed'

/** Embed knobs for {@link importMemory}. Same injected surface as remember()
 * plus a skip flag for batch importers that embed in bulk afterwards. */
export interface ImportWriteOptions extends EmbedOptions {
  /** Skip the embed kick entirely (embedding stays NULL for a later backfill). */
  skipEmbed?: boolean | undefined
}

/** Same convention as remember()/revise() — one hash space across all writes. */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Import a memory for `userId` with its original history preserved: optional
 * recordedAt/validFrom/validTo and status overrides, an 'import' audit event
 * carrying a bounded source payload at its original time, and — for a
 * commitment-type memory — the commitments row at its caller-supplied INITIAL
 * FSM state (insert-with-initial-status; the FSM trigger guards UPDATE only).
 *
 * Embedding follows ack-before-embed under {@link IMPORT_EMBED_OPERATION}
 * (overridable via `options.operation`); `options.skipEmbed` defers it for a
 * bulk backfill. With no gateway, no embed is attempted (as remember()).
 *
 * @throws ZodError if `input` violates the import contract (validation boundary).
 * @throws DuplicateMemoryError if live content with the same hash exists
 *   (not raised for rows imported already-superseded — validTo set).
 */
export async function importMemory(
  userId: string,
  input: unknown,
  options: ImportWriteOptions = {},
): Promise<WriteResult> {
  const parsed = importMemoryInputSchema.parse(input)
  // PRE-PERSIST GUARDS (before writeImportedMemory so a denied import never lands
  // a row):
  //   1. ACCESS: the injected access gate denies a write when the platform policy
  //      forbids it (self-host allowAllAccess allows all). Resolved INDEPENDENTLY
  //      of the budget so it runs even when no budget is wired, and it fires even
  //      when `skipEmbed` is set — an import still PERSISTS a row, which is a write.
  //   2. BUDGET CAP: asserted only when an embed will actually run;
  //      a skipped embed incurs no LLM cost now (the cap is enforced when the later
  //      bulk backfill embeds via the shared seam).
  if (options.access) await options.access.assertWrite(userId)
  if (options.budget && !options.skipEmbed) {
    await assertWithinBudget(options.budget, userId, options.operation ?? IMPORT_EMBED_OPERATION)
  }
  const consumesLiveSlot = (parsed.status ?? 'active') === 'active' && parsed.validTo == null
  const maxLiveMemories = consumesLiveSlot
    ? (await resolveResourceLimits(options.limits, userId)).maxLiveMemories
    : undefined
  const written = await writeImportedMemory(
    {
      userId,
      memoryType: parsed.memoryType,
      topic: parsed.topic,
      content: parsed.content,
      scope: parsed.scope,
      project: parsed.project,
      tags: parsed.tags,
      contentHash: contentHash(parsed.content),
      actorKind: IMPORTER,
      status: parsed.status,
      validFrom: parsed.validFrom,
      validTo: parsed.validTo,
      recordedAt: parsed.recordedAt,
      event: parsed.event,
      commitment: parsed.commitment,
    },
    maxLiveMemories,
  )
  if (options.skipEmbed) return { ...written, embed: { settled: Promise.resolve(false) } }
  const embed = kickEmbed(userId, written.id, parsed.content, IMPORTER, {
    ...options,
    operation: options.operation ?? IMPORT_EMBED_OPERATION,
  })
  return { ...written, embed }
}

/**
 * Append an additional historical lifecycle event (create/resolve/revise/
 * archive) to an imported memory at its original timestamp.
 *
 * @throws ZodError if `input` violates the contract (validation boundary).
 * @throws ImportTargetNotFoundError memory absent / not owned (RLS).
 */
export async function importEvent(userId: string, input: unknown): Promise<{ id: string }> {
  const parsed = importEventInputSchema.parse(input)
  return appendImportedEvent({
    userId,
    memoryId: parsed.memoryId,
    eventKind: parsed.eventKind,
    actorKind: IMPORTER,
    payload: parsed.payload,
    createdAt: parsed.createdAt,
  })
}

/**
 * Create a typed edge between two imported memories (created_by 'importer');
 * for a 'supersedes' edge, optionally close the predecessor's (`toId`'s)
 * validity at its original supersession instant in the same transaction.
 *
 * @throws ZodError if `input` violates the contract (validation boundary).
 * @throws ImportTargetNotFoundError either endpoint absent / not owned (RLS).
 * @throws EdgeConflictError the edge already exists (idempotency index).
 * @throws PredecessorAlreadySupersededError predecessor already closed.
 */
export async function importEdge(userId: string, input: unknown): Promise<void> {
  const parsed = importEdgeInputSchema.parse(input)
  await writeImportedEdge({
    userId,
    fromId: parsed.fromId,
    toId: parsed.toId,
    edgeType: parsed.edgeType,
    createdBy: IMPORTER,
    closePredecessorAt: parsed.closePredecessorAt,
  })
}

/**
 * Insert a bi-temporal fact (subject/predicate/value + confidence) tied to an
 * imported memory, with caller-supplied validity timestamps.
 *
 * @throws ZodError if `input` violates the contract (validation boundary).
 * @throws ImportTargetNotFoundError memory absent / not owned (RLS).
 */
export async function importFact(userId: string, input: unknown): Promise<{ id: string }> {
  const parsed = importFactInputSchema.parse(input)
  return insertImportedFact({
    userId,
    memoryId: parsed.memoryId,
    subject: parsed.subject,
    predicate: parsed.predicate,
    value: parsed.value,
    confidence: parsed.confidence,
    validFrom: parsed.validFrom,
    validTo: parsed.validTo,
    recordedAt: parsed.recordedAt,
  })
}
