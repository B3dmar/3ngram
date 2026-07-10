// SPDX-License-Identifier: Apache-2.0
// Revise-path persistence for the memory domain (slice 2, docs/concepts/memory-model.mdx).
//
// revise() is append-and-supersede made atomic: in ONE withTenant(userId)
// transaction it (1) closes the predecessor's bi-temporal validity
// (UPDATE valid_to = now() ONLY — content is NEVER touched, docs/concepts/memory-model.mdx), (2)
// appends the successor memory (reusing insertMemoryWithEvent — same content_hash
// + DuplicateMemoryError guard as remember()), (3) writes the typed edge FROM
// the successor TO the predecessor, and (4) records a `supersede` audit event on
// the predecessor. All four land or roll back together (hard rule 3); RLS scopes
// every statement to the tenant.
//
// EDGE DIRECTION IS LOAD-BEARING (search.ts:312): supersession ranking keys on
// EXISTS(edge WHERE e.to_id = predecessor AND edge_type='supersedes'). The edge
// MUST therefore be from_id = successor, to_id = predecessor. The tier-penalty
// in search fires ONLY for edge_type='supersedes' (not 'updates'), so an
// 'updates' revise links the memories but does NOT tier-demote the predecessor.
//
// Closing the predecessor (valid_to set) frees its live-hash slot in the partial
// unique index, so re-asserting the predecessor's EXACT content as the successor
// is legal — insertMemoryWithEvent's guard only sees LIVE (valid_to IS NULL)
// rows, and by the time it runs the predecessor is already closed.
//
// COMMITMENT CARRY ACROSS REVISION (D1, Codex P2): a
// commitment is its OWN entity (FSM, due/surfacing state) that merely RIDES a
// commitment-type memory; its identity is the obligation, not the memory
// revision. Revising a commitment-type memory MUST NOT strand the obligation on
// the now-superseded predecessor (which would make the live successor claim to be
// a commitment yet be unresolvable — resolve(successorId) -> CommitmentNotFound).
// So, in the SAME tx, we keep the obligation aligned with the LIVE memory. Four
// cases, by (predecessor has a commitments row) x (successor.memoryType):
//   (a) row + successor IS commitment  -> MOVE the row (UPDATE memory_id =
//       successor). FSM status/resolved_at/due/surfacing all survive; the
//       obligation continues on the live memory. resolve(successorId) works,
//       resolve(predecessorId) is now NotFound (correct — superseded).
//   (b) row + successor is NON-commitment (demote, e.g. commitment->note) ->
//  RESOLVE the row (Option A): transition a live (open/waiting)
//       row to 'resolved' with DB-clock stamps + 'resolve' audit event, the
//       transitionCommitment pattern. Leaving it stranded preserved nothing
//       observable — briefing's openCommitments()/overdueCommitments() inner-join
//       to memories and filter valid_to IS NULL AND status='active'
//       (briefing-read.ts), so the row was silently invisible anyway, and the
//       resolve tool keys on a memory id the agent no longer holds. An explicit
//       close beats a silent strand; the FSM allows resolved -> open if the
//       obligation is reconsidered. Terminal rows (resolved/expired) stay put as
//       history.
//   (c) no row (pre-auto-create legacy) -> nothing to move, no error.
//   (d) no row + successor IS commitment (promote, e.g. note->commitment) ->
//       AUTO-CREATE a fresh row for the successor, mirroring remember()'s
//       auto-create (status 'open', defaults only), making revise symmetric with
//       remember for the INTO-commitment direction.
// commitments_memory_idx is UNIQUE (user_id, memory_id): the successor is freshly
// inserted so neither the MOVE (a) nor the auto-create (d) can collide. The FK is
// composite tenant-qualified; both target the just-inserted successor, still live
// inside this tx.
import type { ActorKind, EdgeType } from '@3ngram/schema'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { type TenantTx, withTenant } from './client.js'
import { EdgeConflictError, insertEdge } from './memory-edges.js'
import { DuplicateMemoryError, insertMemoryWithEvent, type MemoryWrite } from './memory-write.js'
import { isUniqueViolation } from './pg-errors.js'
import { commitments, memories, memoryEvents } from './schema/memory.js'

/**
 * Thrown when the predecessor does not exist for this tenant. Under RLS a
 * cross-tenant id simply returns zero rows (the row is invisible), so "not
 * found" and "not owned" are indistinguishable by design — both surface this.
 * Carries the id (a uuid, never content).
 */
export class PredecessorNotFoundError extends Error {
  readonly predecessorId: string
  constructor(predecessorId: string) {
    super('predecessor memory not found for this tenant')
    this.name = 'PredecessorNotFoundError'
    this.predecessorId = predecessorId
  }
}

/**
 * Thrown when the predecessor is already superseded (valid_to already set). A
 * memory can be revised once; a second revise of the same predecessor is a
 * conflict, not a silent re-close.
 */
export class PredecessorAlreadySupersededError extends Error {
  readonly predecessorId: string
  constructor(predecessorId: string) {
    super('predecessor memory is already superseded')
    this.name = 'PredecessorAlreadySupersededError'
    this.predecessorId = predecessorId
  }
}

/** Inputs for a revision: the successor memory plus the predecessor + edge type. */
export interface ReviseWrite extends MemoryWrite {
  predecessorId: string
  /** Edge type from successor -> predecessor ('supersedes' | 'updates'). */
  edgeType: EdgeType
}

/**
 * Keep the commitment obligation aligned with the live memory after a revision,
 * in the SAME tx. The obligation is its own entity riding a memory; revising the
 * memory must not strand it on the superseded predecessor. Four cases by
 * (predecessor has a row) x (successor.memoryType) — full rationale in the module
 * header:
 *   (a) row + successor IS commitment      -> MOVE the row to the successor.
 *   (b) row + successor is NON-commitment   -> RESOLVE a live (open/waiting) row
 *  (Option A: DB-clock stamps + 'resolve' audit event, the
 *       transitionCommitment pattern); terminal rows stay put as history.
 *   (c) no row                              -> nothing to do.
 *   (d) no row + successor IS commitment    -> AUTO-CREATE a fresh row (mirrors
 *       remember()'s auto-create: status 'open', defaults only).
 *
 * commitments_memory_idx is UNIQUE (user_id, memory_id): the successor is freshly
 * inserted, so neither the MOVE nor the auto-create can collide.
 */
async function carryCommitment(
  tx: TenantTx,
  input: ReviseWrite,
  successorId: string,
): Promise<void> {
  const successorIsCommitment = input.memoryType === 'commitment'

  const [predecessorCommitment] = await tx
    .select({ id: commitments.id, status: commitments.status })
    .from(commitments)
    .where(and(eq(commitments.userId, input.userId), eq(commitments.memoryId, input.predecessorId)))
    .limit(1)

  if (predecessorCommitment) {
    // (b) demote (Option A): explicitly close a live obligation
    // instead of stranding it on the superseded predecessor (where briefing's
    // valid_to IS NULL join made it silently invisible). Mirrors
    // transitionCommitment's resolved-target stamps + 'resolve' audit event;
    // open->resolved and waiting->resolved are both legal FSM transitions
    // (COMMITMENT_TRANSITIONS), so the DB trigger backstop never fires here.
    // Terminal rows (resolved/expired) stay put as history — there is no live
    // obligation to close, and expired->resolved is not a legal transition.
    //
    // TOCTOU guard: the status check above reads a
    // snapshot, but the background sweep (sweepCommitments) can flip the row to
    // 'expired' between our SELECT and this UPDATE. The liveness predicate on
    // the UPDATE is therefore load-bearing: without it, the UPDATE would attempt
    // expired->resolved, the FSM trigger backstop would reject it, and the WHOLE
    // revise tx would abort — when the intended behavior is "terminal rows stay
    // untouched". With it, losing the race means zero rows updated, and the
    // 'resolve' audit event is skipped too (no event without a transition).
    if (!successorIsCommitment) {
      if (predecessorCommitment.status !== 'open' && predecessorCommitment.status !== 'waiting') {
        return
      }
      const resolved = await tx
        .update(commitments)
        .set({ status: 'resolved', resolvedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(commitments.userId, input.userId),
            eq(commitments.id, predecessorCommitment.id),
            inArray(commitments.status, ['open', 'waiting']),
          ),
        )
        .returning({ id: commitments.id })
      if (resolved.length === 0) return
      await tx.insert(memoryEvents).values({
        userId: input.userId,
        memoryId: input.predecessorId,
        eventKind: 'resolve',
        actorKind: input.actorKind,
      })
      return
    }
    // (a) carry: move the obligation onto the live successor. FSM
    // status/resolved_at/due/surfacing all survive — only the memory pointer
    // changes.
    await tx
      .update(commitments)
      .set({ memoryId: successorId, updatedAt: sql`now()` })
      .where(
        and(eq(commitments.userId, input.userId), eq(commitments.id, predecessorCommitment.id)),
      )
    return
  }

  // (c) no predecessor row + non-commitment successor: nothing to do.
  if (!successorIsCommitment) return

  // (d) promote: auto-create a fresh obligation for the successor (defaults only,
  // status 'open') — same shape as writeMemory's remember-path auto-create.
  await tx.insert(commitments).values({ userId: input.userId, memoryId: successorId })
}

/**
 * Append a successor that supersedes `predecessorId`, atomically. See module
 * header for the ordering and direction invariants.
 *
 * Commitment carry: if the predecessor rode a commitment and the successor is
 * commitment-type the obligation MOVES to the successor; if the successor is
 * commitment-type but the predecessor had none, one is auto-created (mirrors
 * remember); a demote to non-commitment RESOLVES a live obligation
 * (Option A). See {@link carryCommitment} for the full four-case matrix.
 *
 * @throws {@link PredecessorNotFoundError} predecessor absent / not owned (RLS).
 * @throws {@link PredecessorAlreadySupersededError} predecessor already closed.
 * @throws {@link DuplicateMemoryError} successor duplicates OTHER live content.
 * @throws {@link EdgeConflictError} the edge already exists (idempotency index).
 */
export async function reviseMemory(input: ReviseWrite): Promise<{ id: string }> {
  try {
    return await withTenant(input.userId, async (tx) => {
      // Distinguish not-found (RLS: zero rows) from already-superseded BEFORE
      // closing, so each failure mode maps to its own typed error. A single
      // SELECT of the predecessor's current validity does both.
      const [predecessor] = await tx
        .select({ validTo: memories.validTo })
        .from(memories)
        .where(and(eq(memories.userId, input.userId), eq(memories.id, input.predecessorId)))
        .limit(1)
      if (!predecessor) throw new PredecessorNotFoundError(input.predecessorId)
      if (predecessor.validTo !== null) {
        throw new PredecessorAlreadySupersededError(input.predecessorId)
      }

      // Close the predecessor: bi-temporal validity ONLY. Content, topic, tags
      // are NEVER touched (docs/concepts/memory-model.mdx append-and-supersede). The WHERE re-asserts
      // valid_to IS NULL so a concurrent revise that closed it first loses the
      // race here (zero rows) -> already-superseded, not a double close.
      const closed = await tx
        .update(memories)
        .set({ validTo: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(memories.userId, input.userId),
            eq(memories.id, input.predecessorId),
            isNull(memories.validTo),
          ),
        )
        .returning({ id: memories.id })
      if (closed.length === 0) {
        throw new PredecessorAlreadySupersededError(input.predecessorId)
      }

      // Append the successor (reuses remember()'s insert + create-event +
      // duplicate guard). The predecessor is already closed, so re-asserting its
      // exact content here is legal — the partial-hash guard sees only live rows.
      const successor = await insertMemoryWithEvent(tx, input)

      // Typed edge FROM successor TO predecessor (direction is load-bearing).
      await insertEdge(tx, {
        userId: input.userId,
        fromId: successor.id,
        toId: input.predecessorId,
        edgeType: input.edgeType,
        createdBy: input.actorKind,
      })

      // Audit the supersession on the predecessor (the successor already got a
      // `create` event from insertMemoryWithEvent).
      await tx.insert(memoryEvents).values({
        userId: input.userId,
        memoryId: input.predecessorId,
        eventKind: 'supersede',
        actorKind: input.actorKind,
      })

      // Keep the commitment obligation aligned with the LIVE memory (see module
      // header). The obligation's identity is the commitment, not the memory
      // revision, so it must follow the revision rather than strand on the
      // now-superseded predecessor.
      await carryCommitment(tx, input, successor.id)

      return { id: successor.id }
    })
  } catch (error) {
    // Pass typed domain errors through untouched. The unique-violation -> typed
    // mapping is owned at the boundary: insertMemoryWithEvent's content collision
    // and insertEdge's edge collision are already typed inside the tx; a residual
    // unique violation reaching here is the partial-hash backstop racing the
    // successor INSERT, which is a duplicate-content conflict.
    if (
      error instanceof DuplicateMemoryError ||
      error instanceof EdgeConflictError ||
      error instanceof PredecessorNotFoundError ||
      error instanceof PredecessorAlreadySupersededError
    ) {
      throw error
    }
    if (isUniqueViolation(error)) throw new DuplicateMemoryError(input.contentHash)
    throw error
  }
}

/**
 * Thrown when no LIVE blocker memory exists for this tenant under the given id.
 * Blockers are deliberately MEMORY-ONLY (no commitment FSM), so the
 * resolve path can't key them via the commitments table; this is the typed miss
 * for the memory-status archive path. Under RLS a cross-tenant id returns zero
 * rows, so "not found", "not owned", "not a live blocker", and "already
 * archived" all collapse to this one error — each is, from the tenant's view,
 * "there is no active blocker by this id to resolve". Carries the id (a uuid,
 * never content).
 */
export class BlockerNotFoundError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super('no active blocker memory found for this tenant')
    this.name = 'BlockerNotFoundError'
    this.memoryId = memoryId
  }
}

/**
 * Archive a LIVE blocker memory: CLOSE the row bi-temporally (set valid_to =
 * now()) AND transition its OWN status 'active' -> 'archived'.
 * Blockers carry no commitment FSM, so resolving one is a memory status change,
 * NOT a commitment transition — and NEVER a row delete (append-only, hard rule 1,
 * docs/concepts/memory-model.mdx bi-temporal close): the row stays, it is merely closed.
 *
 * Setting valid_to is load-bearing, not cosmetic. The partial-unique
 * memories_hash_idx (UNIQUE (user_id, content_hash) WHERE valid_to IS NULL) and
 * insertMemoryWithEvent's duplicate guard both treat any valid_to IS NULL row as
 * occupying the LIVE content-hash slot. Archiving by status alone left the row
 * valid_to IS NULL, so a NEW remember() with the SAME content kept hitting
 * DuplicateMemoryError forever — a recurring blocker could never be re-recorded.
 * Closing the row (valid_to set) frees its live-hash slot in the partial unique
 * index (same mechanism revise() uses for its predecessor; see module comment and
 * memory-write.ts: a valid_to-set row is outside the live-hash space, so the
 * duplicate guard is skipped for it), letting the identical blocker recur. No
 * successor edge is required: a resolved blocker has no replacement, and the
 * supersede edge exists only for revise()'s search tier-penalty.
 *
 * The close also keeps the row out of the active-briefing set: activeBlockers
 * filters status='active' AND valid_to IS NULL, so both predicates now exclude it.
 *
 * The guard is load-bearing and DELIBERATELY narrow: the UPDATE matches ONLY
 * memory_type='blocker' that is currently live (status='active' AND
 * valid_to IS NULL). This keeps resolve from archiving an arbitrary memory type
 * (a commitment, decision, fact, ...) — those either resolve via their own FSM
 * or are simply not resolvable. A zero-row UPDATE (wrong id, wrong tenant, wrong
 * type, already archived, or superseded) is a clean {@link BlockerNotFoundError},
 * mirroring the commitment path's NotFound rather than silently succeeding.
 *
 * Records an 'archive' lifecycle audit event (the same eventKind the commitment
 * sweep stamps on expiry) so the blocker's lifecycle stays auditable. Runs in one
 * withTenant() tx: the UPDATE and the audit event land or roll back together.
 *
 * @throws {@link BlockerNotFoundError} no live blocker by this id for the tenant.
 */
export async function archiveBlockerMemory(
  userId: string,
  memoryId: string,
  actorKind: ActorKind,
): Promise<{ id: string; status: 'archived' }> {
  return withTenant(userId, async (tx) => {
    const archived = await tx
      .update(memories)
      .set({ status: 'archived', validTo: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.id, memoryId),
          eq(memories.memoryType, 'blocker'),
          eq(memories.status, 'active'),
          isNull(memories.validTo),
        ),
      )
      .returning({ id: memories.id })
    if (archived.length === 0 || !archived[0]) throw new BlockerNotFoundError(memoryId)

    await tx.insert(memoryEvents).values({
      userId,
      memoryId,
      eventKind: 'archive',
      actorKind,
    })

    return { id: archived[0].id, status: 'archived' }
  })
}

/**
 * Thrown when no ACTIVE memory exists for this tenant under the given id (the
 * generic ARCHIVE lifecycle path). Under RLS a cross-tenant id returns zero rows,
 * so "not found", "not owned", "already archived", and "superseded" all collapse
 * to this one error — each is, from the tenant's view, "there is no active memory
 * by this id to archive". Carries the id (a uuid, never content).
 */
export class ActiveMemoryNotFoundError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super('no active memory found for this tenant')
    this.name = 'ActiveMemoryNotFoundError'
    this.memoryId = memoryId
  }
}

/**
 * Archive an ACTIVE memory of ANY type: transition its status
 * 'active' -> 'archived'. NEVER a row delete (append-only, hard rule 1) — the
 * row stays, it merely leaves the active set.
 *
 * DELIBERATELY UNLIKE {@link archiveBlockerMemory}, valid_to stays NULL. The
 * archived bucket every read surface keys on is `status='archived' AND valid_to
 * IS NULL` (docs/concepts/data-model.mdx: listMemories' status='archived' filter
 * in memory-read.ts and stats' archivedMemories count in scopes.ts both read
 * exactly that predicate) — setting valid_to here would drop the row into the
 * SUPERSEDED bucket instead and make the archive invisible to both. The known
 * trade (adoption-gate Decision D, locked): the row still holds its live-hash
 * slot in the partial-unique memories_hash_idx (WHERE valid_to IS NULL), so
 * re-remembering identical content stays a DuplicateMemoryError until the
 * archived row is superseded.
 *
 * The guard matches ONLY a currently-live row (status='active' AND valid_to IS
 * NULL) — no memoryType predicate: unlike the blocker-only resolve path, ARCHIVE
 * is a generic lifecycle op. A zero-row UPDATE (wrong id, wrong tenant, already
 * archived, or superseded) is a clean {@link ActiveMemoryNotFoundError} rather
 * than a silent success.
 *
 * Records an 'archive' lifecycle audit event in the SAME withTenant() tx: the
 * UPDATE and the audit event land or roll back together.
 *
 * @throws {@link ActiveMemoryNotFoundError} no active memory by this id for the tenant.
 */
export async function archiveMemory(
  userId: string,
  memoryId: string,
  actorKind: ActorKind,
): Promise<{ id: string; status: 'archived' }> {
  return withTenant(userId, async (tx) => {
    const archived = await tx
      .update(memories)
      .set({ status: 'archived', updatedAt: sql`now()` })
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.id, memoryId),
          eq(memories.status, 'active'),
          isNull(memories.validTo),
        ),
      )
      .returning({ id: memories.id })
    if (archived.length === 0 || !archived[0]) throw new ActiveMemoryNotFoundError(memoryId)

    await tx.insert(memoryEvents).values({
      userId,
      memoryId,
      eventKind: 'archive',
      actorKind,
    })

    return { id: archived[0].id, status: 'archived' }
  })
}
