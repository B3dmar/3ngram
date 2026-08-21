// SPDX-License-Identifier: Apache-2.0
// Write-path persistence for the memory domain (docs/concepts/memory-model.mdx).
//
// The ONLY package that touches Postgres owns the SQL; packages/core
// orchestrates (validate at the schema boundary, compute content_hash) and
// calls this helper. Every statement runs inside ONE withTenant(userId)
// transaction so the memory row and its audit event land atomically and
// roll back together (AGENTS.md hard rule 3). RLS enforces tenant isolation
// on both inserts via the bound app.user_id.
//
// Append-and-supersede (hard rule 1): this only ever INSERTs. Nothing here
// UPDATEs or DELETEs memory content. (revise() closes a predecessor's
// valid_to — a bi-temporal close, never a content mutation — in memory-revise.ts,
// reusing insertMemoryWithEvent below for the successor row.)
import type { ActorKind, EventKind } from '@3ngram/schema'
import { and, count, eq, isNull, sql } from 'drizzle-orm'
import { type TenantTx, withTenant } from './client.js'
import { insertFacts, type MemoryFactWrite } from './facts-write.js'
import { isUniqueViolation } from './pg-errors.js'
import { ResourceLimitExceededError } from './resource-limits.js'
import { commitments, memories, memoryEvents } from './schema/memory.js'
import {
  resolveSessionProvenance,
  sessionPayload,
  UnknownSessionRunError,
} from './session-provenance.js'

/**
 * Thrown when a write would duplicate content already live for this tenant —
 * an active memory (`valid_to IS NULL`) with the same `content_hash` exists.
 * Callers map this to a domain-level conflict (REST 409 / MCP duplicate)
 * without inspecting pg internals. Carries the colliding hash for correlation
 * (a hash, never the content — observability hard rule 6).
 */
export class DuplicateMemoryError extends Error {
  readonly contentHash: string
  constructor(contentHash: string) {
    super('memory with this content already exists for this tenant')
    this.name = 'DuplicateMemoryError'
    this.contentHash = contentHash
  }
}

/** Persisted columns for a new memory. `content_hash` is computed by core. */
export interface MemoryWrite {
  userId: string
  memoryType: string
  topic: string
  content: string
  scope: string
  project?: string | undefined
  tags: string[]
  contentHash: string
  /** Actor class recorded on the `create` audit event (memory_events). */
  actorKind: ActorKind
  /** Native-only session provenance. Import never sets this. */
  sessionRunId?: string | undefined
  /** Injected clock for lease evaluation. Defaults to now. */
  now?: Date | undefined
  // Optional original-history overrides (import path). Omitted -> column
  // defaults ('active' / now()), i.e. byte-for-byte the native write.
  status?: string | undefined
  validFrom?: Date | undefined
  /** Imported ALREADY SUPERSEDED (a closed historical version). Such a row sits
   * outside the live-hash space, so the duplicate guard is skipped for it. */
  validTo?: Date | undefined
  recordedAt?: Date | undefined
}

/** Audit-event metadata for the row's insert event. Defaults model today's
 * native write: kind 'create', no payload, created_at now(). */
export interface MemoryEventWrite {
  kind: EventKind
  /** Bounded by the schema boundary (import payload contract) — never re-validated here. */
  payload?: unknown
  /** Original event time from a source system (import path). */
  createdAt?: Date | undefined
}

/**
 * The freshly written memory's identity, returned to the caller.
 *
 * `commitmentId` is set ONLY when the write auto-created a commitment row — i.e.
 * `memoryType === 'commitment'` on the {@link writeMemory} (fresh remember) path.
 * It rides the SAME transaction as the memory write so a commitment memory
 * is always resolvable.
 */
export interface WrittenMemory {
  id: string
  commitmentId?: string | undefined
  /**
   * Ids of the facts written alongside this memory, positionally matching the
   * `facts` argument of {@link writeMemory}. Present ONLY when at least one
   * fact was written, so a write without facts keeps a byte-identical result.
   */
  factIds?: string[] | undefined
}

/**
 * In-transaction core of a memory append: idempotency guard, the INSERT, and
 * the `create` audit event. Runs against a caller-supplied {@link TenantTx} so
 * it composes inside a larger transaction (revise() inserts the successor row
 * with this, then closes the predecessor and writes the edge in the SAME tx).
 *
 * Duplicate guard: a hard UNIQUE on `content_hash` would break
 * append-and-supersede (a re-asserted memory must be able to follow a
 * superseded one), so the backstop is a PARTIAL unique index
 * (`memories_hash_idx`) scoped to LIVE rows only: `UNIQUE (user_id,
 * content_hash) WHERE valid_to IS NULL`. Idempotency is checked in-transaction
 * first — if an ACTIVE memory (`valid_to IS NULL`) already carries this hash for
 * the tenant we throw {@link DuplicateMemoryError} for a clean fast path — but
 * that SELECT-then-INSERT is a TOCTOU window under READ COMMITTED, so the
 * partial unique index closes the race at the DB: a concurrent second INSERT
 * raises a unique violation. The unique-violation -> DuplicateMemoryError
 * mapping is owned by the OUTER withTenant wrappers ({@link writeMemory} /
 * reviseMemory) so the mapping lives once at the transaction boundary.
 *
 * IMPORTANT for revise(): closing the predecessor's valid_to (in the same tx,
 * BEFORE calling this) frees ITS live-hash slot, so re-asserting the
 * predecessor's exact content as the successor is legal — the partial index no
 * longer sees the predecessor as a live collision.
 */
export async function insertMemoryWithEvent(
  tx: TenantTx,
  input: MemoryWrite,
  event: MemoryEventWrite = { kind: 'create' },
  maxLiveMemories?: number,
): Promise<WrittenMemory> {
  if (maxLiveMemories !== undefined) {
    // Serialize capped appends per tenant so count + insert is exact under
    // concurrency. Revise deliberately omits this option: it closes one live
    // row before inserting its replacement and therefore remains net-zero.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`live_memories:${input.userId}`}, 0))`,
    )
  }

  // A row imported already-superseded (validTo set) is OUTSIDE the live-hash
  // space — the partial index only covers valid_to IS NULL — so the guard must
  // not block it: a closed historical version may legally share content with
  // the current live row (the revise() re-assertion precedent).
  if (input.validTo == null) {
    const [existing] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.userId, input.userId),
          eq(memories.contentHash, input.contentHash),
          isNull(memories.validTo),
        ),
      )
      .limit(1)
    if (existing) throw new DuplicateMemoryError(input.contentHash)
  }

  const consumesLiveSlot = (input.status ?? 'active') === 'active' && input.validTo == null
  if (consumesLiveSlot && maxLiveMemories !== undefined) {
    const [usage] = await tx
      .select({ value: count() })
      .from(memories)
      .where(
        and(
          eq(memories.userId, input.userId),
          eq(memories.status, 'active'),
          isNull(memories.validTo),
        ),
      )
    if ((usage?.value ?? 0) >= maxLiveMemories) {
      throw new ResourceLimitExceededError('live_memories')
    }
  }

  const [row] = await tx
    .insert(memories)
    .values({
      userId: input.userId,
      memoryType: input.memoryType,
      topic: input.topic,
      content: input.content,
      scope: input.scope,
      project: input.project,
      tags: input.tags,
      contentHash: input.contentHash,
      // Original-history overrides (import path); undefined values are omitted
      // by drizzle, so the native write keeps its column defaults untouched.
      status: input.status,
      validFrom: input.validFrom,
      validTo: input.validTo,
      recordedAt: input.recordedAt,
      // embedding intentionally omitted -> NULL; populated in the
      // ack-before-embed slice (S5), never on the synchronous write.
    })
    .returning({ id: memories.id })
  if (!row) throw new Error('insertMemoryWithEvent returned no row')

  await tx.insert(memoryEvents).values({
    userId: input.userId,
    memoryId: row.id,
    eventKind: event.kind,
    actorKind: input.actorKind,
    payload: event.payload,
    createdAt: event.createdAt,
  })

  return { id: row.id }
}

/**
 * Insert a memory and its `create` audit event in one tenant-scoped
 * transaction. Bi-temporal columns (valid_from/recorded_at) and status take
 * their schema defaults; embedding stays NULL — it is computed by the
 * async ack-before-embed worker step, not on the synchronous write path.
 *
 * Auto-created commitment:
 * when `memory_type === 'commitment'` this ALSO inserts a `commitments` row
 * (status 'open', defaults only — no dueAt/owner; the schema still models none)
 * in the SAME transaction, so a commitment memory and its lifecycle row land or
 * roll back together. Rationale: an MCP-created commitment memory MUST be
 * resolvable via the `resolve` tool, and resolve keys on the COMMITMENT — without
 * the auto-create the memory would have no commitment to transition. The earlier
 * deferral held only because no surface created commitment memories yet. The
 * returned {@link WrittenMemory#commitmentId} carries the new commitment id.
 *
 * Structured facts:
 * `facts` rides the SAME transaction as the memory, so a memory and the facts
 * it asserts are never half-written — a fact whose source memory rolled back
 * would be an unsourced claim in the structured projection. Facts are inserted
 * for EVERY memory type, before the commitment branch below, because nothing
 * about asserting a fact is commitment-specific. The returned
 * {@link WrittenMemory#factIds} carries the new ids positionally.
 *
 * The duplicate guard and its concurrent-INSERT backstop live in
 * {@link insertMemoryWithEvent}; this wrapper owns the transaction and the
 * unique-violation -> {@link DuplicateMemoryError} mapping. Neither path
 * swallows the error.
 *
 * That mapping stays safe with facts in the transaction because `facts` carries
 * no unique index and no unique constraint — bi-temporal history keeps every
 * assertion — and its only unique object, the uuidv7 primary key, is
 * server-generated, so no caller input can collide on it. A facts INSERT
 * therefore has no violation to raise and nothing to misattribute to the
 * memories partial-hash index. The premise is pinned by a schema-shape test
 * (test/facts-write.test.ts): adding uniqueness to `facts` fails that test,
 * which is the signal to scope this catch (the insertEdge precedent) rather
 * than let a fact collision surface as a duplicate memory.
 */
export async function writeMemory(
  input: MemoryWrite,
  maxLiveMemories?: number,
  facts?: readonly MemoryFactWrite[],
): Promise<WrittenMemory> {
  try {
    return await withTenant(input.userId, async (tx) => {
      const runId = await resolveSessionProvenance(tx, input.userId, {
        sessionRunId: input.sessionRunId,
        project: input.project,
        now: input.now ?? new Date(),
      })
      const inserted = await insertMemoryWithEvent(
        tx,
        input,
        { kind: 'create', payload: sessionPayload(runId) },
        maxLiveMemories,
      )
      const factIds = await insertFacts(
        tx,
        (facts ?? []).map((fact) => ({ ...fact, userId: input.userId, memoryId: inserted.id })),
      )
      const written: WrittenMemory = factIds.length > 0 ? { ...inserted, factIds } : inserted
      if (input.memoryType !== 'commitment') return written
      // Same-tx commitment auto-create: defaults only (status 'open'). The
      // composite FK to the just-inserted memory holds inside the tx; the unique
      // index (one commitment per memory) cannot collide on a fresh memory id.
      const [commitment] = await tx
        .insert(commitments)
        .values({ userId: input.userId, memoryId: written.id })
        .returning({ id: commitments.id })
      if (!commitment) throw new Error('writeMemory commitment auto-create returned no row')
      return { ...written, commitmentId: commitment.id }
    })
  } catch (error) {
    if (error instanceof DuplicateMemoryError) throw error
    if (error instanceof UnknownSessionRunError) throw error
    if (isUniqueViolation(error)) throw new DuplicateMemoryError(input.contentHash)
    throw error
  }
}
