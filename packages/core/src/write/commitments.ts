// SPDX-License-Identifier: Apache-2.0
// Commitment FSM orchestration (commitments are their own entity with an explicit FSM).
//
// apps -> core -> db layering: this is the ONE place the commitment-lifecycle
// JTBD is orchestrated. The FSM contract lives in @3ngram/schema
// (COMMITMENT_TRANSITIONS / canTransition); core CONSUMES it and never
// re-derives the rules (hard rule 2). A transition is validated with
// canTransition BEFORE the DB call — the DB trigger (enforce_commitment_fsm) is
// the BACKSTOP, not the primary guard. Transports call these; they hold zero
// business logic (hard rule 5).
//
// Observability (hard rule 6): ids/status only — never memory content.
import {
  archiveBlockerMemory,
  assertSessionRunOwned,
  BlockerNotFoundError,
  CommitmentNotFoundError,
  type CommitmentState,
  CommitmentStateChangedError,
  createCommitment as dbCreateCommitment,
  transitionCommitment as dbTransitionCommitment,
  getCommitment,
  getCommitmentByMemoryId,
  getMemoryById,
  IllegalCommitmentTransitionError,
  type WrittenCommitment,
  withTenant,
} from '@3ngram/db'
import { type ActorKind, type CommitmentStatus, canTransition } from '@3ngram/schema'

export {
  BlockerNotFoundError,
  CommitmentExistsError,
  CommitmentNotFoundError,
  CommitmentStateChangedError,
  IllegalCommitmentTransitionError,
  NotCommitmentMemoryError,
  type WrittenCommitment,
} from '@3ngram/db'

/**
 * Thrown when a requested transition is not legal per COMMITMENT_TRANSITIONS,
 * caught in CORE before any DB call (the schema FSM contract, applied at the
 * service boundary). The DB trigger would also reject it, but core fails fast
 * with the real from/to so callers never depend on the backstop for the common
 * case. Distinct from {@link IllegalCommitmentTransitionError} (db backstop) so
 * tests can prove which guard fired.
 */
export class InvalidCommitmentTransitionError extends Error {
  readonly from: CommitmentStatus
  readonly to: CommitmentStatus
  constructor(from: CommitmentStatus, to: CommitmentStatus) {
    super(`commitment transition not permitted: ${from} -> ${to}`)
    this.name = 'InvalidCommitmentTransitionError'
    this.from = from
    this.to = to
  }
}

/** Optional metadata for a new commitment. remember() does NOT auto-create
 * one (no commitment metadata in rememberInputSchema) — this is the surface. */
export interface CreateCommitmentOptions {
  owner?: string | undefined
  dueAt?: Date | undefined
  recurrence?: unknown | undefined
  nextSurfacingAt?: Date | undefined
}

/**
 * Create a commitment riding `memoryId` (a commitment-type memory). The
 * commitment starts 'open'; subsequent state changes go through
 * {@link transition}. The composite FK / unique index (one commitment per
 * memory) are enforced in the db layer; this is the orchestration surface.
 */
export async function createCommitment(
  userId: string,
  memoryId: string,
  actorKind: ActorKind,
  options: CreateCommitmentOptions = {},
): Promise<WrittenCommitment> {
  return dbCreateCommitment({
    userId,
    memoryId,
    owner: options.owner,
    dueAt: options.dueAt,
    recurrence: options.recurrence,
    nextSurfacingAt: options.nextSurfacingAt,
    actorKind,
  })
}

/**
 * Transition a commitment to `to`, validating legality at the schema boundary
 * FIRST.
 *
 * Reads the current state (RLS-scoped), maps a missing row to
 * {@link CommitmentNotFoundError}, validates `from -> to` via canTransition
 * (throwing {@link InvalidCommitmentTransitionError} on an illegal pair, BEFORE
 * any write), then delegates the status change (sets resolved_at on 'resolved',
 * appends the lifecycle audit event) to the db layer. A same-state transition is
 * a no-op success — canTransition is consulted only for an ACTUAL change.
 *
 * @throws {@link CommitmentNotFoundError} commitment absent / not owned.
 * @throws {@link InvalidCommitmentTransitionError} illegal per the schema FSM.
 */
export async function transition(
  userId: string,
  commitmentId: string,
  to: CommitmentStatus,
  actorKind: ActorKind,
): Promise<{ id: string; status: CommitmentStatus }> {
  const current: CommitmentState | undefined = await getCommitment(userId, commitmentId)
  if (!current) throw new CommitmentNotFoundError(commitmentId)
  return applyTransition(userId, current, to, actorKind)
}

/**
 * The status a {@link resolveByMemoryId} call settles on. For a COMMITMENT this
 * is the target FSM status (the existing behaviour, byte-identical); for a
 * BLOCKER (no commitment FSM) the memory's own status moves to
 * 'archived', dropping it from the active-briefing set.
 */
export type ResolveStatus = CommitmentStatus | 'archived'

/**
 * Resolve the obligation an agent keys on by MEMORY id. The `resolve` MCP tool
 * keys on the MEMORY id agents already
 * hold (from remember / search), not the commitment id, so this dispatches on
 * what that memory IS:
 *
 *   COMMITMENT (a commitments row rides the memory): resolve memory ->
 *   commitment via the unique (user_id, memory_id) index, then apply the same
 *   FSM-validated transition as {@link transition} — UNCHANGED, byte-identical.
 *   `to === 'open'` from a 'resolved' commitment is the UNRESOLVE transition
 *   (legal per COMMITMENT_TRANSITIONS); this same surface serves resolve and
 *   unresolve, the target status the only difference.
 *
 *   BLOCKER (no commitment rides it — blockers are deliberately MEMORY-ONLY): a
 *   commitment lookup misses, so instead of throwing we ARCHIVE the blocker
 *   memory (status 'active' -> 'archived'), which removes it from the briefing's
 *   active blockers (activeBlockers filters status='active' AND valid_to IS
 *   NULL). The requested `to` is IGNORED for a blocker: resolve, expire, and any
 *   FSM target all mean the SAME thing for a blocker — "no longer active" ==
 *   archived (there is no blocker FSM to transition between). The result's status
 *   is therefore 'archived', not `to`.
 *
 *   NEITHER (no commitment AND not a live blocker — e.g. a decision/fact id, an
 *   already-archived blocker, a superseded row, or a cross-tenant/absent id):
 *   {@link CommitmentNotFoundError} keyed on the memory id, preserving the
 *   pre-existing not-found contract for non-blocker, non-commitment ids.
 *
 * @throws {@link CommitmentNotFoundError} no commitment rides the memory AND it
 *   is not a live blocker (RLS hides cross-tenant rows).
 * @throws {@link InvalidCommitmentTransitionError} illegal per the schema FSM
 *   (commitment path only).
 */
export async function resolveByMemoryId(
  userId: string,
  memoryId: string,
  to: CommitmentStatus,
  actorKind: ActorKind,
  sessionRunId?: string,
): Promise<{ id: string; status: ResolveStatus }> {
  const current = await getCommitmentByMemoryId(userId, memoryId)
  if (current) return applyTransition(userId, current, to, actorKind, sessionRunId)

  // No commitment rides the memory. A blocker is MEMORY-ONLY: it
  // leaves the active set by archiving its OWN status, not via a commitment FSM.
  // Inspect the memory type (no live gate: getMemoryById returns superseded rows
  // too, but archiveBlockerMemory's UPDATE re-asserts liveness, so a superseded
  // or already-archived blocker still maps to the not-found contract below).
  const memory = await withTenant(userId, (tx) => getMemoryById(tx, userId, memoryId))
  if (memory?.memoryType === 'blocker') {
    try {
      return await archiveBlockerMemory(userId, memoryId, actorKind, sessionRunId)
    } catch (error) {
      // A live blocker that lost a concurrent archive race (already archived /
      // superseded between the read and the UPDATE) collapses to the same
      // not-found contract as any other unresolvable id — keyed 'memory'.
      if (error instanceof BlockerNotFoundError)
        throw new CommitmentNotFoundError(memoryId, 'memory')
      throw error
    }
  }

  // keyedBy 'memory': the carried id is the MEMORY id we looked up by, not a
  // commitment id — the error message/mapping must label it as such.
  throw new CommitmentNotFoundError(memoryId, 'memory')
}

/**
 * Why a {@link resolveForClosedRun} candidate was skipped, or that it resolved.
 * The closer processes a batch, so each candidate reports its own outcome
 * instead of one bad id failing the pass (the page: *skip illegal transitions;
 * do not persist a failing batch*).
 */
export type ClosedRunResolveOutcome =
  /** The commitment moved open|waiting -> resolved. */
  | 'resolved'
  /** Another session already resolved it. Idempotent, not an error. */
  | 'already-resolved'
  /** No commitment rides this memory (a note, a blocker, a superseded row). */
  | 'not-a-commitment'
  /** A live re-read found a status `resolved` is not reachable from. */
  | 'illegal-transition'

/**
 * The session closer's ONLY write. Resolve one briefed commitment on behalf of a
 * run that has already closed, stamping that run's provenance verbatim.
 *
 * THE LIVE RE-READ IS THE POINT. `briefed_memories` is a SessionStart stamp;
 * between then and now another session may have resolved, superseded or expired
 * the row. Every call re-reads the commitment immediately before deciding, and
 * an illegal or already-settled target is a SKIP, not a throw — one stale
 * candidate must not abort the other nine.
 *
 * Provenance rides `stampedSessionRunId`, never `sessionRunId`: the run is
 * closed by construction, and the attach path would resurrect it. See the field
 * doc in packages/db/src/commitments.ts.
 *
 * RESOLVE-ONLY, AND REVERSIBLE. This function cannot create, revise or archive
 * anything; the worst case it can produce is a commitment marked resolved too
 * early, which `unresolve` (open <- resolved, a legal edge) undoes. That is the
 * safety property that makes an LLM-driven v1 shippable at all, and it is why a
 * BullMQ retry through this path cannot append a duplicate corpus row.
 *
 * NOT PART OF THE PUBLIC SURFACE, ON PURPOSE. It is exported from this module
 * and from NEITHER barrel (`../write/index.ts`, `../index.ts`), so the only way
 * to reach it is the deep import the closer uses. Unlike every other write here
 * it takes `sessionRunId` as an ALREADY-TRUSTED value and stamps it verbatim,
 * skipping the ownership check `resolveSessionProvenance` performs — safe only
 * because the caller read that id off the tenant's own session row moments
 * earlier. A transport handler that picked this out of the barrel and passed a
 * client-supplied run id would forge provenance across sessions, and (given a
 * foreign id) across tenants. It must NEVER receive a client-supplied id.
 */
export async function resolveForClosedRun(
  userId: string,
  memoryId: string,
  actorKind: ActorKind,
  sessionRunId: string,
): Promise<ClosedRunResolveOutcome> {
  const current = await getCommitmentByMemoryId(userId, memoryId)
  if (!current) return 'not-a-commitment'
  if (current.status === 'resolved') return 'already-resolved'
  if (!canTransition(current.status, 'resolved')) return 'illegal-transition'
  try {
    await dbTransitionCommitment({
      userId,
      commitmentId: current.id,
      to: 'resolved',
      actorKind,
      // COMPARE-AND-SET on the status just read. The read runs in its own
      // transaction, so without this the window between it and the write is
      // wide open: a second closer attempt, or an interactive `resolve` in
      // another session, settles the row first, and this write still succeeds —
      // the FSM trigger waves `resolved -> resolved` through — re-stamping
      // `resolved_at` and appending a DUPLICATE resolve event under this run's
      // provenance. Both callers would report `resolved`. With the guard the
      // loser gets zero rows and reports `already-resolved` having written
      // nothing.
      expectedFrom: current.status,
      stampedSessionRunId: sessionRunId,
    })
  } catch (error) {
    // Lost the compare-and-set: somebody moved the row between the read and the
    // write. Re-read once to say WHICH way it went, so the pass reports an
    // honest outcome instead of guessing.
    if (error instanceof CommitmentStateChangedError) {
      const latest = await getCommitmentByMemoryId(userId, memoryId)
      if (latest?.status === 'resolved') return 'already-resolved'
      return 'illegal-transition'
    }
    // The re-read above closes the window, it does not eliminate it: a
    // concurrent session can expire the commitment between the SELECT and the
    // UPDATE, and `expired -> resolved` is not a legal edge. The DB backstop
    // firing is still a SKIP for the batch, never a failed pass — the row is
    // simply no longer ours to close.
    if (error instanceof IllegalCommitmentTransitionError) return 'illegal-transition'
    if (error instanceof CommitmentNotFoundError) return 'not-a-commitment'
    throw error
  }
  return 'resolved'
}

/**
 * Shared FSM-validated transition body for both id- and memory-keyed surfaces. A
 * same-state transition is a no-op success; an illegal pair throws BEFORE any DB
 * write (core is the primary guard, the DB trigger is the backstop).
 *
 * The no-op branch still VALIDATES a supplied sessionRunId. Idempotency is about
 * the commitment's state, not about which inputs get checked: the native-write
 * contract is that a run id this tenant does not own fails the request, and the
 * early return would otherwise let a foreign or nonexistent id come back 200
 * purely because the commitment already held the requested status — the one
 * request shape where a bad id was silently accepted. The check is ownership
 * only: it never attaches, heartbeats, or stamps an event, so a no-op resolve
 * cannot be used to keep a session's lease alive.
 */
async function applyTransition(
  userId: string,
  current: CommitmentState,
  to: CommitmentStatus,
  actorKind: ActorKind,
  sessionRunId?: string,
): Promise<{ id: string; status: CommitmentStatus }> {
  if (current.status === to) {
    if (sessionRunId !== undefined) await assertSessionRunOwned(userId, sessionRunId)
    return { id: current.id, status: current.status }
  }
  if (!canTransition(current.status, to)) {
    throw new InvalidCommitmentTransitionError(current.status, to)
  }
  return dbTransitionCommitment({ userId, commitmentId: current.id, to, actorKind, sessionRunId })
}
