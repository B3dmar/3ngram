// SPDX-License-Identifier: Apache-2.0
// Import-path persistence (groundwork for batch importers).
//
// An import is an ordinary append (docs/concepts/memory-model.mdx) with its original history
// preserved: caller-supplied bi-temporal timestamps/status, an 'import' audit
// event whose payload carries source-system identifiers, additional historical
// lifecycle events, typed edges, and bi-temporal facts. Imported rows are
// indistinguishable from native ones apart from that import event. Everything
// runs inside withTenant(userId) (hard rule 3); nothing here UPDATEs memory
// content — the only mutation is the revise()-precedent valid_to close.
//
// Observability (hard rule 6): ids/hashes only — never content or payloads.
import type { ActorKind, CommitmentStatus, EdgeType, EventKind } from '@3ngram/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { type TenantTx, withTenant } from './client.js'
import { insertEdge } from './memory-edges.js'
import { PredecessorAlreadySupersededError } from './memory-revise.js'
import {
  DuplicateMemoryError,
  insertMemoryWithEvent,
  type MemoryWrite,
  type WrittenMemory,
} from './memory-write.js'
import { isUniqueViolation } from './pg-errors.js'
import { commitments, facts, memories, memoryEvents } from './schema/memory.js'

/**
 * Thrown when the memory an import write targets (event/edge/fact) does not
 * exist for this tenant. Under RLS a cross-tenant id returns zero rows, so
 * "not found" and "not owned" are indistinguishable by design. Carries the id
 * (a uuid, never content).
 */
export class ImportTargetNotFoundError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super('import target memory not found for this tenant')
    this.name = 'ImportTargetNotFoundError'
    this.memoryId = memoryId
  }
}

/** Probe a target memory's existence so a miss is a typed not-found instead of
 * a raw composite-FK violation. Runs inside the caller's tenant tx. */
async function requireMemory(tx: TenantTx, userId: string, memoryId: string): Promise<void> {
  const [row] = await tx
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.id, memoryId)))
    .limit(1)
  if (!row) throw new ImportTargetNotFoundError(memoryId)
}

/** An imported memory: a normal {@link MemoryWrite} (whose optional
 * status/validFrom/validTo/recordedAt overrides the import path supplies) plus
 * the import event's metadata and the optional initial commitment state. */
export interface ImportedMemoryWrite extends MemoryWrite {
  /** Metadata for the row's 'import' audit event. */
  event?: { payload?: unknown; createdAt?: Date | undefined } | undefined
  /** Initial FSM state for a commitment-type memory; defaults to 'open'. */
  commitment?:
    | {
        status: CommitmentStatus
        owner?: string | undefined
        dueAt?: Date | undefined
        resolvedAt?: Date | undefined
        recurrence?: unknown
      }
    | undefined
}

/**
 * Insert an imported memory and its 'import' audit event in one tenant-scoped
 * transaction — the {@link insertMemoryWithEvent} core with the event kind
 * 'import', the bounded source payload, and the original event time.
 *
 * Commitment-type memories ALSO insert their commitments row in the SAME tx
 * (the writeMemory auto-create invariant: a commitment memory is always
 * resolvable), at the caller-supplied INITIAL FSM state. Insert-with-initial-
 * status is legal: the FSM trigger (migration 0001) fires BEFORE UPDATE OF
 * status only, so INSERT is constrained solely by the status enum CHECK —
 * a historical commitment lands in its final state without replaying
 * transitions.
 *
 * @throws {@link DuplicateMemoryError} live content with the same hash exists
 *   (skipped for rows imported already-superseded — validTo set).
 */
export async function writeImportedMemory(
  input: ImportedMemoryWrite,
  maxLiveMemories?: number,
): Promise<WrittenMemory> {
  try {
    return await withTenant(input.userId, async (tx) => {
      const written = await insertMemoryWithEvent(
        tx,
        input,
        {
          kind: 'import',
          payload: input.event?.payload,
          createdAt: input.event?.createdAt,
        },
        maxLiveMemories,
      )
      if (input.memoryType !== 'commitment') return written
      const state = input.commitment ?? { status: 'open' as CommitmentStatus }
      const [commitment] = await tx
        .insert(commitments)
        .values({
          userId: input.userId,
          memoryId: written.id,
          status: state.status,
          owner: state.owner,
          dueAt: state.dueAt,
          resolvedAt: state.resolvedAt,
          recurrence: state.recurrence,
        })
        .returning({ id: commitments.id })
      if (!commitment) throw new Error('writeImportedMemory commitment insert returned no row')
      return { ...written, commitmentId: commitment.id }
    })
  } catch (error) {
    if (error instanceof DuplicateMemoryError) throw error
    if (isUniqueViolation(error)) throw new DuplicateMemoryError(input.contentHash)
    throw error
  }
}

/** An additional historical lifecycle event for an imported memory. */
export interface ImportedEventWrite {
  userId: string
  memoryId: string
  eventKind: EventKind
  actorKind: ActorKind
  payload?: unknown
  /** Original event time; omitted -> now() (column default). */
  createdAt?: Date | undefined
}

/**
 * Append a historical audit event to an imported memory with its original
 * timestamp. Append-only, exactly like every memory_events write.
 *
 * @throws {@link ImportTargetNotFoundError} memory absent / not owned (RLS).
 */
export async function appendImportedEvent(input: ImportedEventWrite): Promise<{ id: string }> {
  return withTenant(input.userId, async (tx) => {
    await requireMemory(tx, input.userId, input.memoryId)
    const [row] = await tx
      .insert(memoryEvents)
      .values({
        userId: input.userId,
        memoryId: input.memoryId,
        eventKind: input.eventKind,
        actorKind: input.actorKind,
        payload: input.payload,
        createdAt: input.createdAt,
      })
      .returning({ id: memoryEvents.id })
    if (!row) throw new Error('appendImportedEvent returned no row')
    return { id: row.id }
  })
}

/** A typed edge between two imported memories, optionally closing the
 * superseded predecessor (`toId`) at its original supersession instant. */
export interface ImportedEdgeWrite {
  userId: string
  fromId: string
  toId: string
  edgeType: EdgeType
  /** Actor class recorded on memory_edges.created_by. */
  createdBy: ActorKind
  /** Close the predecessor's valid_to at this instant ('supersedes' only —
   * enforced at the schema boundary). Must be >= its valid_from (DB CHECK). */
  closePredecessorAt?: Date | undefined
}

/**
 * Insert a typed edge, and — for an imported supersession — close the
 * predecessor's bi-temporal validity at the caller-supplied instant, in ONE
 * tenant-scoped transaction. The close mirrors reviseMemory(): valid_to ONLY,
 * never content (docs/concepts/memory-model.mdx), with the liveness predicate re-asserted on the
 * UPDATE so a concurrent close surfaces as already-superseded.
 *
 * @throws {@link ImportTargetNotFoundError} either endpoint absent / not owned.
 * @throws {@link EdgeConflictError} the edge already exists (idempotency index).
 * @throws {@link PredecessorAlreadySupersededError} predecessor already closed.
 */
export async function writeImportedEdge(input: ImportedEdgeWrite): Promise<void> {
  await withTenant(input.userId, async (tx) => {
    await requireMemory(tx, input.userId, input.fromId)
    const [predecessor] = await tx
      .select({ validTo: memories.validTo })
      .from(memories)
      .where(and(eq(memories.userId, input.userId), eq(memories.id, input.toId)))
      .limit(1)
    if (!predecessor) throw new ImportTargetNotFoundError(input.toId)

    await insertEdge(tx, {
      userId: input.userId,
      fromId: input.fromId,
      toId: input.toId,
      edgeType: input.edgeType,
      createdBy: input.createdBy,
    })

    if (!input.closePredecessorAt) return
    if (predecessor.validTo !== null) throw new PredecessorAlreadySupersededError(input.toId)
    const closed = await tx
      .update(memories)
      .set({ validTo: input.closePredecessorAt, updatedAt: sql`now()` })
      .where(
        and(
          eq(memories.userId, input.userId),
          eq(memories.id, input.toId),
          isNull(memories.validTo),
        ),
      )
      .returning({ id: memories.id })
    if (closed.length === 0) throw new PredecessorAlreadySupersededError(input.toId)
  })
}

/** A bi-temporal fact riding an imported memory. */
export interface ImportedFactWrite {
  userId: string
  memoryId: string
  subject: string
  predicate: string
  value: string
  confidence?: number | undefined
  validFrom?: Date | undefined
  validTo?: Date | undefined
  recordedAt?: Date | undefined
}

/**
 * Insert a facts row tied to an imported memory. Omitted timestamps take the
 * column defaults (now()); no uniqueness applies — bi-temporal history keeps
 * every assertion (schema/memory.ts facts rationale).
 *
 * @throws {@link ImportTargetNotFoundError} memory absent / not owned (RLS).
 */
export async function insertImportedFact(input: ImportedFactWrite): Promise<{ id: string }> {
  return withTenant(input.userId, async (tx) => {
    await requireMemory(tx, input.userId, input.memoryId)
    const [row] = await tx
      .insert(facts)
      .values({
        userId: input.userId,
        memoryId: input.memoryId,
        subject: input.subject,
        predicate: input.predicate,
        value: input.value,
        confidence: input.confidence,
        validFrom: input.validFrom,
        validTo: input.validTo,
        recordedAt: input.recordedAt,
      })
      .returning({ id: facts.id })
    if (!row) throw new Error('insertImportedFact returned no row')
    return { id: row.id }
  })
}
