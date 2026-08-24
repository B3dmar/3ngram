// SPDX-License-Identifier: Apache-2.0
// Commitment persistence + FSM transitions (fixes a modeling tangle).
//
// A commitment is its OWN entity that rides a commitment-type memory: the row
// references memoryId via the composite tenant-qualified FK, and is UNIQUE per
// memory (commitments_memory_idx). It is never staged columns on memories — the
// lifecycle is an explicit FSM whose legal transitions live in @3ngram/schema
// (COMMITMENT_TRANSITIONS / canTransition). packages/core validates the
// transition BEFORE calling transitionCommitment (hard rule 2: schema owns the
// FSM contract, services consume it). The DB trigger (enforce_commitment_fsm,
// migration 0001) is the BACKSTOP: bypassing core surfaces a check-violation,
// mapped here to a typed {@link IllegalCommitmentTransitionError}.
//
// All access runs inside withTenant(userId) (hard rule 3); RLS scopes every
// statement to the tenant. Append-and-supersede (hard rule 1) governs MEMORIES,
// not the commitment FSM — a commitment legitimately UPDATEs its own status
// column (the runtime role has UPDATE on commitments, provision-roles.sql); the
// memory it rides is never mutated.
//
// Observability (hard rule 6): ids/status only — never memory content.
import type { ActorKind, CommitmentStatus } from '@3ngram/schema'
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { withTenant } from './client.js'
import {
  illegalTransitionPair,
  isIllegalCommitmentTransition,
  isUniqueViolation,
} from './pg-errors.js'
import { agentSessions } from './schema/agent-sessions.js'
import { commitments, memories, memoryEvents } from './schema/memory.js'
import { resolveSessionProvenance, sessionPayload } from './session-provenance.js'

/**
 * Thrown when a commitment already exists for the given memory — the
 * `commitments_memory_idx` unique violation (one commitment per commitment-type
 * memory). Carries the memory id (a uuid, never content).
 */
export class CommitmentExistsError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super('a commitment already exists for this memory')
    this.name = 'CommitmentExistsError'
    this.memoryId = memoryId
  }
}

/**
 * Thrown when the parent memory a commitment would ride is not a LIVE
 * commitment-type memory — i.e. it is not `memory_type = 'commitment'`, or it has
 * been superseded (`valid_to` is set). The composite tenant-qualified FK only
 * proves the memory is owned by the tenant; it does NOT constrain the type or
 * liveness, so this guard upholds the module invariant that a commitment rides a
 * live commitment-type memory. Carries the memory id (a uuid, never content —
 * hard rule 6).
 */
export class NotCommitmentMemoryError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super('parent memory is not a live commitment-type memory')
    this.name = 'NotCommitmentMemoryError'
    this.memoryId = memoryId
  }
}

/**
 * Discriminates WHICH id {@link CommitmentNotFoundError} carries: the commitment
 * id itself (the id-keyed `transition` surface) or the memory id a commitment
 * rides (the memory-keyed `resolveByMemoryId` surface). The mapping/message uses
 * this so a memory-keyed miss reads "memory <id>", never mislabelling it as a
 * commitment id.
 */
export type CommitmentNotFoundKey = 'commitment' | 'memory'

/**
 * Thrown when the commitment does not exist for this tenant. Under RLS a
 * cross-tenant id simply returns zero rows, so "not found" and "not owned" are
 * indistinguishable by design — both surface this. Carries the id (a uuid) and a
 * `keyedBy` discriminator naming whether that id is the commitment id or the
 * memory id it was looked up by; the message reflects the keyed-by so a
 * memory-keyed miss is never mislabelled as a commitment id.
 */
export class CommitmentNotFoundError extends Error {
  readonly commitmentId: string
  readonly keyedBy: CommitmentNotFoundKey
  constructor(id: string, keyedBy: CommitmentNotFoundKey = 'commitment') {
    super(
      keyedBy === 'memory'
        ? 'no commitment for memory id for this tenant'
        : 'commitment not found for this tenant',
    )
    this.name = 'CommitmentNotFoundError'
    this.commitmentId = id
    this.keyedBy = keyedBy
  }
}

/**
 * Thrown when a compare-and-set transition lost its race: the commitment exists,
 * but no longer holds the `expectedFrom` status the caller observed. Carries the
 * commitment id and the status that was expected (never memory content).
 *
 * Distinct from {@link IllegalCommitmentTransitionError}: that one means the
 * requested edge is not in the FSM at all, this one means the edge was legal
 * from the state the caller SAW and somebody else moved the row first. A batch
 * caller treats it as a skip; there is nothing wrong with the request.
 */
export class CommitmentStateChangedError extends Error {
  readonly commitmentId: string
  readonly expectedFrom: CommitmentStatus
  constructor(commitmentId: string, expectedFrom: CommitmentStatus) {
    super(`commitment is no longer in status '${expectedFrom}'`)
    this.name = 'CommitmentStateChangedError'
    this.commitmentId = commitmentId
    this.expectedFrom = expectedFrom
  }
}

/**
 * Thrown when a `stampedSessionRunId` write (the session closer's ONLY write
 * path) carries a `stampedSessionEpoch` that no longer matches the run's
 * CURRENT `activation_epoch`, read in the SAME transaction as the write
 * (issue #185, resolve-path TOCTOU). A resurrection or an account erasure
 * moved the epoch between the closer's outer per-resolve check
 * (`session-closer.ts`, a separate transaction) and this statement — the
 * write is aborted before it happens.
 *
 * Distinct from {@link CommitmentStateChangedError} on purpose: that one is
 * about the COMMITMENT's own state (a legitimate skip a batch reports and
 * moves on from); this one is about the SESSION the pass is fenced at, and the
 * correct response is not "skip this one candidate" but "abandon the pass" —
 * the same `fenced` outcome every other epoch-fence hit in `closeSessionRun`
 * produces. Callers must map this to that abandon behavior, never retry it.
 */
export class SessionEpochFencedError extends Error {
  readonly sessionRunId: string
  readonly expectedEpoch: number
  constructor(sessionRunId: string, expectedEpoch: number) {
    super('session activation_epoch no longer matches the epoch this pass is fenced at')
    this.name = 'SessionEpochFencedError'
    this.sessionRunId = sessionRunId
    this.expectedEpoch = expectedEpoch
  }
}

/**
 * Thrown when the DB FSM trigger rejects a status transition — the backstop
 * firing because core's canTransition guard was bypassed (a direct db call with
 * an illegal pair). Carries from/to so callers can correlate without parsing pg
 * internals.
 */
export class IllegalCommitmentTransitionError extends Error {
  readonly from: CommitmentStatus
  readonly to: CommitmentStatus
  constructor(from: CommitmentStatus, to: CommitmentStatus) {
    super(`illegal commitment transition: ${from} -> ${to}`)
    this.name = 'IllegalCommitmentTransitionError'
    this.from = from
    this.to = to
  }
}

/** Optional commitment metadata supplied at creation. */
export interface CommitmentCreate {
  userId: string
  /** The commitment-type memory this commitment rides (composite FK). */
  memoryId: string
  owner?: string | undefined
  dueAt?: Date | undefined
  recurrence?: unknown | undefined
  nextSurfacingAt?: Date | undefined
  /** Actor class recorded on the `create` audit event for the memory. */
  actorKind: ActorKind
}

/** The freshly created commitment's identity (starts in status 'open'). */
export interface WrittenCommitment {
  id: string
  status: CommitmentStatus
}

/**
 * Create a commitment riding `memoryId`, in one tenant-scoped transaction.
 *
 * Status takes its schema default ('open'). A `create` audit event is appended
 * to memory_events against the commitment's memory so the lifecycle is auditable
 * from the memory's event stream. The unique index makes a second commitment for
 * the same memory a typed {@link CommitmentExistsError}; the composite FK makes a
 * commitment on a non-owned / cross-tenant memory unrepresentable. The parent
 * memory is additionally required to be a LIVE commitment-type memory
 * (memory_type = 'commitment' AND valid_to IS NULL) in the same tx — the FK alone
 * does not enforce type or liveness, so a note-typed or superseded memory raises
 * {@link NotCommitmentMemoryError}.
 *
 * remember() does NOT auto-create this (rememberInputSchema models no commitment
 * metadata) — auto-create would invent policy. This is the standalone surface.
 */
export async function createCommitment(input: CommitmentCreate): Promise<WrittenCommitment> {
  try {
    return await withTenant(input.userId, async (tx) => {
      // The composite FK only proves tenant ownership of the parent memory; it
      // does NOT constrain memory_type or liveness. Enforce the module invariant
      // (a commitment rides a LIVE commitment-type memory) in the SAME tx, before
      // the INSERT, so a note-typed or superseded memory is a typed rejection
      // rather than a silently-malformed commitment. Drizzle builder (not raw
      // sql) keeps each param in exactly one typed context — sidesteps the
      // parse-time "inconsistent types deduced for parameter" gotcha.
      //
      // FOR SHARE closes a TOCTOU race (Codex finding, comment
      // 3365080280 + user audit): under READ COMMITTED, a concurrent
      // reviseMemory() could commit a valid_to close on this parent BETWEEN this
      // liveness check and the INSERT below, leaving a commitment riding a
      // superseded memory. The row-share lock makes reviseMemory's UPDATE of the
      // parent (its valid_to close) BLOCK until this tx commits, so the parent's
      // liveness verified here HOLDS through the INSERT. SHARE (not UPDATE) is the
      // weakest lock that still conflicts with the writer while letting
      // concurrent createCommitment readers of the same parent proceed.
      const [parent] = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.userId, input.userId),
            eq(memories.id, input.memoryId),
            eq(memories.memoryType, 'commitment'),
            isNull(memories.validTo),
          ),
        )
        .for('share')
        .limit(1)
      if (!parent) throw new NotCommitmentMemoryError(input.memoryId)

      const [row] = await tx
        .insert(commitments)
        .values({
          userId: input.userId,
          memoryId: input.memoryId,
          owner: input.owner,
          dueAt: input.dueAt,
          recurrence: input.recurrence,
          nextSurfacingAt: input.nextSurfacingAt,
        })
        .returning({ id: commitments.id, status: commitments.status })
      if (!row) throw new Error('createCommitment returned no row')

      await tx.insert(memoryEvents).values({
        userId: input.userId,
        memoryId: input.memoryId,
        eventKind: 'create',
        actorKind: input.actorKind,
      })

      return { id: row.id, status: row.status as CommitmentStatus }
    })
  } catch (error) {
    if (error instanceof NotCommitmentMemoryError) throw error
    if (error instanceof CommitmentExistsError) throw error
    if (isUniqueViolation(error)) throw new CommitmentExistsError(input.memoryId)
    throw error
  }
}

/** A commitment's current FSM state, for core's pre-DB transition validation. */
export interface CommitmentState {
  id: string
  memoryId: string
  status: CommitmentStatus
}

/**
 * Read a commitment's current state for this tenant, or undefined if absent /
 * not owned (RLS hides cross-tenant rows). Core reads this BEFORE validating a
 * transition via canTransition (hard rule 2) so the FSM contract is checked in
 * the app, with the DB trigger as the backstop.
 */
export async function getCommitment(
  userId: string,
  commitmentId: string,
): Promise<CommitmentState | undefined> {
  return withTenant(userId, async (tx) => {
    const [row] = await tx
      .select({
        id: commitments.id,
        memoryId: commitments.memoryId,
        status: commitments.status,
      })
      .from(commitments)
      .where(and(eq(commitments.userId, userId), eq(commitments.id, commitmentId)))
      .limit(1)
    return row
      ? { id: row.id, memoryId: row.memoryId, status: row.status as CommitmentStatus }
      : undefined
  })
}

/**
 * Read a commitment's current state by its PARENT MEMORY id, or undefined if no
 * commitment rides that memory for this tenant (RLS hides cross-tenant rows).
 *
 * The `resolve` MCP tool keys on the MEMORY id an agent holds (from remember /
 * search), not the commitment id, so this maps memory -> commitment. The mapping
 * is well-defined: `commitments_memory_idx` is UNIQUE per (user_id, memory_id),
 * so at most one commitment rides a memory. Same shape as {@link getCommitment}.
 */
export async function getCommitmentByMemoryId(
  userId: string,
  memoryId: string,
): Promise<CommitmentState | undefined> {
  return withTenant(userId, async (tx) => {
    const [row] = await tx
      .select({
        id: commitments.id,
        memoryId: commitments.memoryId,
        status: commitments.status,
      })
      .from(commitments)
      .where(and(eq(commitments.userId, userId), eq(commitments.memoryId, memoryId)))
      .limit(1)
    return row
      ? { id: row.id, memoryId: row.memoryId, status: row.status as CommitmentStatus }
      : undefined
  })
}

/** Inputs for an FSM status transition. */
export interface CommitmentTransition {
  userId: string
  commitmentId: string
  /** Target status. Legality is validated by core BEFORE this call; the DB
   * trigger is the backstop. */
  to: CommitmentStatus
  /** Actor class recorded on the lifecycle audit event. */
  actorKind: ActorKind
  /**
   * Compare-and-set guard: apply the transition ONLY while the row still holds
   * this status, and raise {@link CommitmentStateChangedError} otherwise.
   *
   * Every caller reads the current state in a SEPARATE transaction before
   * deciding, so without this the read is advisory: a concurrent writer can
   * settle the row in the gap, and because the FSM trigger returns early on
   * `OLD.status = NEW.status`, a same-state UPDATE then succeeds — re-stamping
   * `resolved_at` and appending a duplicate lifecycle event under this caller's
   * provenance. Optional so the interactive surfaces, which already short-circuit
   * a same-state request in core, keep their exact behaviour.
   */
  expectedFrom?: CommitmentStatus | undefined
  sessionRunId?: string | undefined
  /**
   * Provenance the caller has ALREADY resolved: stamp exactly this run id and do
   * NOT run the attach decision. Mutually exclusive with `sessionRunId`.
   *
   * This exists for the session closer, and only for it. The closer's rows are
   * closed or lease-expired BY CONSTRUCTION — that is its eligibility rule — so
   * routing its writes through `resolveSessionProvenance` would take the one
   * branch that must never fire here: a stale-lease row RESURRECTS, clearing
   * `closed_at` and incrementing `activation_epoch`. The closer would then fail
   * its own epoch-fenced write-back, leave the dead session looking live, and be
   * swept again on the next pass — an unbounded loop that spends an LLM call
   * each time. The other branch is no better: an explicitly closed row attaches
   * NOTHING, so the resolve would land unattributed and drop out of the run's
   * own event set.
   *
   * The closer is not a write "arriving at" a session; it is the session's own
   * bookkeeping being consumed. It holds the row, so the id needs no resolution.
   */
  stampedSessionRunId?: string | undefined
  /**
   * Paired with `stampedSessionRunId`: the `activation_epoch` the closer's pass
   * observed and is fenced at. When both are set, this row is locked
   * (`FOR UPDATE`) before a SEPARATE, freshly-snapshotted read of the run's
   * CURRENT epoch, which raises {@link SessionEpochFencedError} instead of
   * writing when it no longer matches (issue #185, resolve-path TOCTOU) — see
   * the lock's own comment in `transitionCommitment` for why the lock must
   * come first and the epoch check must be its own statement (an
   * EXISTS(...) predicate folded into the write's own WHERE is unsound under
   * EvalPlanQual and was a real bug in an earlier revision). The closer's
   * outer per-resolve check (session-closer.ts) runs in a SEPARATE
   * transaction and only narrows this window; the lock-then-read here closes
   * it. Ignored (no guard) when `stampedSessionRunId` is absent — meaningless
   * without the run it is the epoch of.
   */
  stampedSessionEpoch?: number | undefined
  now?: Date | undefined
}

/** The audit event_kind recorded for each terminal/lifecycle target status. */
const TRANSITION_EVENT_KIND = {
  open: 'unresolve',
  waiting: 'revise',
  resolved: 'resolve',
  expired: 'archive',
} as const satisfies Record<CommitmentStatus, string>

/**
 * Transition a commitment to `to`, in one tenant-scoped transaction. Sets
 * `resolved_at` when entering 'resolved' (and clears it on any other target so a
 * revived commitment does not carry a stale resolution time), bumps `updated_at`,
 * and appends a lifecycle audit event to the commitment's memory.
 *
 * The status UPDATE fires the FSM trigger; an illegal pair (reached only when
 * core's canTransition guard is bypassed) raises a check-violation mapped to
 * {@link IllegalCommitmentTransitionError}. A zero-row UPDATE means the
 * commitment is absent / not owned (RLS) -> {@link CommitmentNotFoundError}.
 *
 * @throws {@link CommitmentNotFoundError} commitment absent / not owned (RLS).
 * @throws {@link IllegalCommitmentTransitionError} DB FSM backstop rejected it.
 */
export async function transitionCommitment(
  input: CommitmentTransition,
): Promise<{ id: string; status: CommitmentStatus }> {
  const resolvedAt = input.to === 'resolved' ? sql`now()` : null
  try {
    return await withTenant(input.userId, async (tx) => {
      // Resolve the memory id first so the audit event references the right
      // memory and so a missing commitment is a clean NotFound (vs the FSM
      // trigger never running on a no-op UPDATE).
      //
      // LOCKED (`FOR UPDATE`) ONLY ON THE STAMPED (closer) PATH — not
      // unconditionally. An earlier revision of this function locked here for
      // EVERY caller (issue #185, resolve-path TOCTOU) and that was itself a
      // bug (F1b): it inverted the canonical lock order for the non-stamped
      // path, which calls `resolveSessionProvenance` a few statements below
      // and may take the tenant/project ATTACH advisory lock. The canonical
      // order for every write path that stamps provenance — see
      // memory-revise.ts's own "LOCK ORDER" note — is attach-lock BEFORE any
      // memory/commitment row lock; inverting it here (row lock, THEN attach)
      // is an AB-BA deadlock against a concurrent write that takes them in the
      // canonical order (reviseMemory's commitment-sync helper does exactly
      // that).
      //
      // THE DEEPER TENSION, not just a style choice: `eraseAccountData`
      // (account-delete.ts) orders its writes commitments -> agent_sessions
      // (redact commitments, THEN bump the epoch), while the canonical
      // provenance-stamping order is agent_sessions(-adjacent attach lock) ->
      // commitments. No single lock order in this one function can satisfy
      // both erasure's ordering (which the stamped path needs to serialize
      // against, below) and the canonical provenance ordering (which the
      // non-stamped path needs) at the same time. Scoping the lock to ONLY the
      // stamped path is the resolution: that path never calls
      // `resolveSessionProvenance` (a pre-resolved id bypasses it entirely —
      // see `stampedSessionRunId`'s own doc), so it holds exactly one lock and
      // waits on nothing else, safe to serialize against erasure. The
      // non-stamped path takes NO commitment lock here at all, and keeps the
      // canonical attach-first order it always had.
      //
      // WHY THE STAMPED PATH NEEDS THE LOCK AT ALL: `eraseAccountData` UPDATEs
      // EVERY commitment row of the account BEFORE it bumps
      // `activation_epoch`, so the closer's write locking this row FIRST
      // forces erasure and this transaction to SERIALIZE against each other
      // rather than merely race — see the epoch fence right below for why the
      // lock has to come first. An EXISTS(...) epoch check folded into the
      // UPDATE's own WHERE — a still-earlier revision — is NOT equivalent and
      // does not work: Postgres evaluates a blocked-then-woken UPDATE's TARGET
      // row fresh (EvalPlanQual), but a sub-SELECT against another table
      // inside that same WHERE still runs under the statement's ORIGINAL
      // snapshot. If erasure held this row's lock first, the woken UPDATE
      // would re-check its own qual against the post-erasure commitment row
      // yet evaluate the `agent_sessions` sub-select as of BEFORE erasure
      // committed — seeing the stale epoch, passing the guard, and landing the
      // resolve after all. This is the exact pitfall `excerptPatch`
      // (session-lifecycle.ts) and `settleNeedsLook` (session-closer.ts)
      // already document: a sub-SELECT needs its own fresh statement, not a
      // shared one with the write it guards.
      const locked =
        input.stampedSessionRunId !== undefined && input.stampedSessionEpoch !== undefined
      const base = tx
        .select({ memoryId: commitments.memoryId })
        .from(commitments)
        .where(and(eq(commitments.userId, input.userId), eq(commitments.id, input.commitmentId)))
        .limit(1)
      const [existing] = await (locked ? base.for('update') : base)
      if (!existing) throw new CommitmentNotFoundError(input.commitmentId)

      // THE RESOLVE-PATH EPOCH FENCE (issue #185), now that the lock above is
      // held. A SEPARATE statement, deliberately — it must run on a FRESH
      // snapshot, which the lock wait alone does not guarantee for anything
      // outside the row it locked. Two interleavings, both covered:
      //
      //   - this transaction acquires the row lock FIRST -> erasure's own
      //     commitments UPDATE blocks behind it, so this SELECT still sees
      //     the PRE-erasure epoch -> the resolve legitimately happens-before
      //     the erasure that follows it (a valid outcome: the account was
      //     still live from this pass's perspective when it wrote);
      //   - erasure's transaction holds the row lock FIRST (true for every
      //     commitment row by the time erasure reaches its own commitments
      //     UPDATE, since that UPDATE touches them all in one statement) ->
      //     the SELECT above blocks on the lock, resumes once erasure
      //     COMMITS, and THIS brand-new statement's fresh snapshot sees the
      //     bumped epoch -> abort below, nothing written.
      //
      // Only applied when `stampedSessionEpoch` is supplied (the closer's own
      // write; every other caller passes neither field).
      if (input.stampedSessionRunId !== undefined && input.stampedSessionEpoch !== undefined) {
        const [session] = await tx
          .select({ activationEpoch: agentSessions.activationEpoch })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.userId, input.userId),
              eq(agentSessions.id, input.stampedSessionRunId),
            ),
          )
          .limit(1)
        if (session === undefined || session.activationEpoch !== input.stampedSessionEpoch) {
          throw new SessionEpochFencedError(input.stampedSessionRunId, input.stampedSessionEpoch)
        }
      }

      const [memory] = await tx
        .select({ project: memories.project })
        .from(memories)
        .where(and(eq(memories.userId, input.userId), eq(memories.id, existing.memoryId)))
        .limit(1)
      // A pre-resolved id bypasses the attach decision entirely (see
      // `stampedSessionRunId`): no lock, no heartbeat, no resurrect, no epoch
      // change — just the stamp.
      const runId =
        input.stampedSessionRunId ??
        (await resolveSessionProvenance(tx, input.userId, {
          sessionRunId: input.sessionRunId,
          project: memory?.project,
          now: input.now ?? new Date(),
        }))

      // `expectedFrom` makes the caller's live re-read and this write ATOMIC.
      // Without it a caller that read the row in an earlier transaction — which
      // is every caller, since the read has its own withTenant — can lose a race
      // and still write: the FSM trigger passes `OLD.status = NEW.status`
      // straight through, so a resolved -> resolved UPDATE succeeds, bumps
      // `resolved_at`/`updated_at`, and appends a SECOND `resolve` event under a
      // different session's provenance. Putting the observed status in the WHERE
      // turns that into a zero-row update the caller can classify. On the
      // STAMPED path, `locked` means this transaction has held this row's lock
      // since the SELECT above, so nothing NEW can race this predicate between
      // then and now either — the WHERE still matters (it is the guard against
      // the STALE status the caller observed before this transaction even
      // began), but no concurrent writer can additionally sneak in during this
      // transaction's own lifetime. The non-stamped path holds no such lock
      // (see above), so for it the WHERE is doing the whole job, same as
      // before this file ever added a lock here.
      const [row] = await tx
        .update(commitments)
        .set({ status: input.to, resolvedAt, updatedAt: sql`now()` })
        .where(
          and(
            eq(commitments.userId, input.userId),
            eq(commitments.id, input.commitmentId),
            ...(input.expectedFrom === undefined
              ? []
              : [eq(commitments.status, input.expectedFrom)]),
          ),
        )
        .returning({ id: commitments.id, status: commitments.status })
      if (!row) {
        // The row exists (the SELECT above found it), so with `expectedFrom`
        // set a zero-row update means only one thing: somebody moved it
        // first — on the stamped path, this transaction has held the row's
        // lock ever since that SELECT, so "somebody" moved it before this
        // transaction started, not during it. The epoch fence above already
        // ran to completion — an epoch mismatch never reaches this branch, it
        // aborts earlier with SessionEpochFencedError.
        if (input.expectedFrom !== undefined) {
          throw new CommitmentStateChangedError(input.commitmentId, input.expectedFrom)
        }
        throw new CommitmentNotFoundError(input.commitmentId)
      }

      await tx.insert(memoryEvents).values({
        userId: input.userId,
        memoryId: existing.memoryId,
        eventKind: TRANSITION_EVENT_KIND[input.to],
        actorKind: input.actorKind,
        payload: sessionPayload(runId),
      })

      return { id: row.id, status: row.status as CommitmentStatus }
    })
  } catch (error) {
    if (
      error instanceof CommitmentNotFoundError ||
      error instanceof CommitmentStateChangedError ||
      error instanceof IllegalCommitmentTransitionError ||
      error instanceof SessionEpochFencedError
    ) {
      throw error
    }
    if (isIllegalCommitmentTransition(error)) {
      // The trigger raise carries the real from->to pair in its message; parse
      // it so the typed error reports the actual source status, falling back to
      // the requested target if the message shape ever changes.
      const pair = illegalTransitionPair(error)
      throw new IllegalCommitmentTransitionError(
        (pair?.from as CommitmentStatus | undefined) ?? input.to,
        (pair?.to as CommitmentStatus | undefined) ?? input.to,
      )
    }
    throw error
  }
}

// --- Surfacing / overdue advisory sweep (workstream F2) — appended ---

/** Outcome of {@link sweepCommitments}: how many rows each advisory leg touched. */
export interface SurfacingSweepResult {
  /** open|waiting commitments whose due_at had passed, transitioned to 'expired'. */
  expired: number
  /** live commitments whose next_surfacing_at had passed, rolled forward/cleared. */
  surfaced: number
}

/** The non-terminal commitment states a periodic sweep may act on. */
const LIVE_COMMITMENT_STATES = ['open', 'waiting'] as const

/**
 * Advisory background sweep over the tenant's commitments (workstream F2): keeps
 * the briefing's overdue/stale sections honest without ANY memory mutation. Runs
 * inside the caller's withTenant() transaction (RLS scopes every statement); the
 * injected `now` (no datetime.now() in business logic — hard rule, observability)
 * is the single clock both legs share.
 *
 * Two bounded UPDATE legs, both on the `commitments` table ONLY — the memory each
 * commitment rides is NEVER touched (append-and-supersede governs memories; a
 * commitment legitimately UPDATEs its own status column, the createCommitment /
 * transitionCommitment precedent):
 *
 *   1. OVERDUE: open|waiting commitments whose `due_at` is strictly in the PAST
 *      transition to 'expired' (a legal FSM edge from both states — the DB FSM
 *      trigger is the backstop). Each fires an 'archive' audit event against its
 *      memory's event stream so the lifecycle stays auditable, exactly as
 *      {@link transitionCommitment} does for a single row.
 *
 *   2. SURFACING: live commitments whose `next_surfacing_at` is in the PAST have
 *      surfaced this tick. Their `next_surfacing_at` is CLEARED (set NULL): the
 *      one-shot surfacing instant has fired, so it must not keep re-surfacing
 *      every tick. Recurrence-driven re-scheduling is a separate concern (the
 *      recurrence column is advisory metadata, not computed here). Commitments
 *      expired by leg 1 in the same sweep are excluded from this leg.
 *
 * Order matters: leg 1 runs first so a commitment that is both overdue AND due to
 * surface is expired (its surfacing is then irrelevant), not merely re-surfaced.
 */
export async function sweepCommitments(
  tx: TenantTx,
  userId: string,
  now: Date,
): Promise<SurfacingSweepResult> {
  const overdue = await tx
    .update(commitments)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(
      and(
        eq(commitments.userId, userId),
        inArray(commitments.status, [...LIVE_COMMITMENT_STATES]),
        isNotNull(commitments.dueAt),
        lt(commitments.dueAt, now),
      ),
    )
    .returning({ id: commitments.id, memoryId: commitments.memoryId })

  for (const row of overdue) {
    await tx.insert(memoryEvents).values({
      userId,
      memoryId: row.memoryId,
      eventKind: 'archive',
      actorKind: 'worker',
    })
  }

  const surfaced = await tx
    .update(commitments)
    .set({ nextSurfacingAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(commitments.userId, userId),
        inArray(commitments.status, [...LIVE_COMMITMENT_STATES]),
        isNotNull(commitments.nextSurfacingAt),
        lt(commitments.nextSurfacingAt, now),
      ),
    )
    .returning({ id: commitments.id })

  return { expired: overdue.length, surfaced: surfaced.length }
}
