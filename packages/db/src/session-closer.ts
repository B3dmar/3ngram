// SPDX-License-Identifier: Apache-2.0
// The lease-expiry sweep and the closer's claim/complete statements
// (docs/concepts/session-continuity.mdx, layer 5).
//
// SQL ONLY, one tenant at a time. Every function here takes the caller's
// `TenantTx`, so RLS scopes it (hard rule 3); the CROSS-TENANT fan-out is
// core's, over `listTenantIds()` — the same shape consolidation and surfacing
// already use. There is no privileged handle in this file and there must never
// be one: `agent_sessions` is user-owned with FORCE RLS, so an admin-handle
// scan would return zero rows by design.
//
// THE TWO INVARIANTS THIS MODULE EXISTS TO HOLD.
//
// 1. A SWEPT CLOSE IS AN IMPLICIT CLOSE. `isExplicitClose` (session-lease.ts)
//    identifies a SessionEnd close forever by `closed_at <= last_seen_at +
//    lease`. {@link sweepExpiredLeases} only ever stamps rows whose
//    `last_seen_at < now - lease - grace`, so the stamped `closed_at = now`
//    satisfies `now > last_seen_at + lease` — strictly outside the window, so
//    the row reads as IMPLICIT and stays resurrectable by a later heartbeat or
//    resume. Sweeper timing must not change attribution; this is where that is
//    enforced.
//
// 2. THE EPOCH IS THE FENCE, AND IT IS RE-CHECKED ON THE WRITE-BACK. A claim is
//    taken at the epoch the closer observed; resurrection increments the epoch,
//    so the claim's predicate stops matching and both the claim and the final
//    write-back become no-ops. Checking it only at claim time would let an
//    in-flight generation land on a session the user has since resumed.
//
// Observability (hard rule 6): ids, counts and lengths only. The excerpt these
// statements read and clear is user/assistant content — it is never logged,
// never echoed in an error, and never returned by anything but the closer's own
// bounded input read.
import {
  type AgentSessionTriageStatus,
  type BriefedMemory,
  MAX_SESSION_EVENT_IDS,
  SESSION_LEASE_MS,
  SESSION_SWEEP_GRACE_MS,
} from '@3ngram/schema'
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { agentSessions } from './schema/agent-sessions.js'
import { memoryEvents } from './schema/memory.js'

/**
 * Triage states a CLOSED row is closer-eligible in, unconditionally
 * (docs/concepts/session-continuity.mdx layer 5). `completed` is eligible only
 * with untriaged event ids, which is not a scan predicate — see
 * {@link listCloserCandidates}. `overflowed` is terminal and never eligible.
 */
export const CLOSER_ELIGIBLE_STATUSES = ['idle', 'pending', 'expired'] as const

/**
 * THE RE-ARM PREDICATE, in one place: this run holds a provenance event whose id
 * is NOT in `last_triaged_event_ids` (docs/concepts/session-continuity.mdx,
 * "Debounce" — *re-arm is an event id not in that set*).
 *
 * Correlated against the `agent_sessions` row in the enclosing query, so it
 * reads the watermark from the row rather than round-tripping the jsonb array
 * through a bind parameter, and it stops at the FIRST untriaged event instead of
 * materialising the run.
 *
 * Two consumers must agree on it or the closer and the Stop nudge would disagree
 * about whether the same row has untriaged signal: {@link listCloserCandidates}'
 * `completed` leg, and the triage handshake's entry rule + debounce
 * (session-triage.ts). Duplicating the SQL is how those two silently drift.
 *
 * The jsonb array holds event ids as TEXT, so membership is a containment test
 * against the scalar (`'["a"]'::jsonb @> '"a"'::jsonb`). `e.id::text` and
 * `agent_sessions.id::text` are both Postgres' canonical lowercase uuid
 * spelling, which is the spelling the write path stamps into the payload — the
 * same equality `listSessionEvents` relies on. The inner scan is served by
 * `memory_events_session_idx`.
 */
export const hasUntriagedSessionEvent = sql`EXISTS (
    SELECT 1
      FROM ${memoryEvents} AS e
     WHERE e.user_id = ${agentSessions.userId}
       AND e.payload->>'sessionRunId' = ${agentSessions.id}::text
       AND NOT (${agentSessions.lastTriagedEventIds} @> to_jsonb(e.id::text))
  )`

/**
 * RECOMPUTE `needs_look` for one run, in its own statement, AFTER a watermark
 * stamp has landed in the same transaction (issue #183).
 *
 * THE FLAG'S ONE MEANING: *false* is a promise that this run holds no provenance
 * event outside `last_triaged_event_ids`, and it is what lets settled `completed`
 * rows leave `agent_sessions_closer_idx` entirely. Only a statement that reads
 * the watermark it just stamped can honestly make that promise, so every stamper
 * of a terminal status calls this and nothing else clears the flag.
 *
 * WHY A SEPARATE STATEMENT, not a `CASE` folded into the stamp. It must see the
 * ids the stamp just wrote, and — the part that is actually load-bearing — it
 * must run on a FRESH snapshot. A stamp that waited on a row lock resumes under
 * EvalPlanQual, which re-derives the target list from the updated tuple but
 * gives no such guarantee to a sub-SELECT inside it; a probe that missed a
 * just-committed event would clear the flag and lose that event permanently.
 * READ COMMITTED gives each new statement its own snapshot, and this transaction
 * holds the row lock throughout, so the two orderings are both covered:
 *
 *   - the attaching write committed FIRST -> its event is visible here, the flag
 *     is set, and the closer's next sweep pays the EXISTS probe on the row;
 *   - the attaching write commits AFTER -> it was blocked on our row lock, and
 *     its own re-arm (session-provenance.ts) then flips `completed` back to
 *     `idle` and raises the flag on the row version we left behind.
 *
 * It also CLEARS a stale flag, which is the leak the index change depends on: a
 * row re-armed by a write and then legitimately re-triaged must stop paying for
 * the probe forever.
 *
 * THE ONE ATTRIBUTED WRITE THAT DOES NOT LOCK THE ROW is the closer's own
 * resolve (`resolveForClosedRun`, packages/core): it stamps `sessionRunId`
 * verbatim in its own transaction and deliberately never touches
 * `agent_sessions`, because the attach path would resurrect the very row the
 * closer is closing. So the row lock is NOT what orders those events against
 * this probe — sequence is. The closer runs its resolves to completion before it
 * takes the listing it stamps, and this statement re-probes on a fresh snapshot
 * afterwards, so every such event is either already in the watermark or found
 * here. Making that path concurrent with the stamp, or folding this probe back
 * into the stamp, breaks it.
 */
export async function settleNeedsLook(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
): Promise<void> {
  await tx
    .update(agentSessions)
    .set({ needsLook: sql<boolean>`${hasUntriagedSessionEvent}` })
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.id, sessionRunId)))
}

/** One row the sweep implicitly closed, or found already closed and eligible. */
export interface CloserCandidate {
  sessionRunId: string
  /** The epoch to claim at. A resurrection past this makes the job a no-op. */
  activationEpoch: number
}

/** The bounded closer input read: the row, minus anything content-shaped but the excerpt. */
export interface CloserSessionRow {
  sessionRunId: string
  activationEpoch: number
  triageStatus: AgentSessionTriageStatus
  triageAttemptId: string | null
  lastTriagedEventIds: string[]
  briefedMemories: BriefedMemory[]
  /** BOUNDED user/assistant content. Never log it, never put it in an error. */
  lastMessageExcerpt: string | null
  project: string | null
  scope: string | null
  closedAt: Date | null
  lastSeenAt: Date
}

/**
 * The instant a row must have gone quiet before the sweep may close it: one
 * lease plus the grace. Exported so the classification math is testable without
 * a database — the boundary case (`exactly lease + grace` is NOT yet swept) is
 * the one a reader gets wrong.
 */
export function sweepFloor(now: Date): Date {
  return new Date(now.getTime() - SESSION_LEASE_MS - SESSION_SWEEP_GRACE_MS)
}

/**
 * Stamp an implicit `closed_at` on every open row of this tenant that has been
 * quiet for lease + grace, newest-first, bounded by `limit`. Returns the rows it
 * closed, with the epoch each was closed at, so the caller can enqueue exactly
 * one closer job per row.
 *
 * This is the FIRST writer of implicit closes in the codebase. Until now
 * "implicitly closed" was only ever evaluated on read/write (session-lease.ts);
 * nothing stamped the column. See invariant 1 in the module header for why the
 * grace is what keeps the stamp classifiable as implicit.
 *
 * `closed_at IS NULL` is repeated in the WHERE even though the sweep floor
 * already implies quiet: it is what makes the statement idempotent under a
 * concurrent explicit close, and it is the predicate of `agent_sessions_lease_idx`,
 * so the scan stays on that partial index.
 */
export async function sweepExpiredLeases(
  tx: TenantTx,
  userId: string,
  now: Date,
  limit: number,
): Promise<CloserCandidate[]> {
  const stale = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        isNull(agentSessions.closedAt),
        lt(agentSessions.lastSeenAt, sweepFloor(now)),
      ),
    )
    .orderBy(agentSessions.lastSeenAt)
    .limit(limit)
  if (stale.length === 0) return []

  // Re-assert BOTH predicates in the UPDATE, not just the SELECT. Under READ
  // COMMITTED, Postgres re-evaluates the qual against the new row version, so
  // repeating them is what makes a concurrent writer WIN the race:
  //
  //   - `closed_at IS NULL`: an explicit SessionEnd close can commit in the gap,
  //     and re-stamping would move `closed_at` past the explicit-close window,
  //     silently reclassifying a close the tenant made deliberately.
  //   - `last_seen_at < sweepFloor`: a HEARTBEAT can commit in the gap. Without
  //     this the sweep would close a session that just came back to life — and
  //     then enqueue it for an LLM-driven resolve pass against a live run, which
  //     is exactly the mid-conversation debrief the grace exists to prevent.
  //
  // A row that loses either check simply returns no row and is skipped this
  // pass, which is correct: it is no longer stale.
  const closed = await tx
    .update(agentSessions)
    .set({ closedAt: now })
    .where(
      and(
        eq(agentSessions.userId, userId),
        isNull(agentSessions.closedAt),
        lt(agentSessions.lastSeenAt, sweepFloor(now)),
        inArray(
          agentSessions.id,
          stale.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: agentSessions.id, activationEpoch: agentSessions.activationEpoch })
  return closed.map((row) => ({ sessionRunId: row.id, activationEpoch: row.activationEpoch }))
}

/**
 * Closed rows of this tenant that the closer should run on, bounded by `limit`.
 *
 * Covers all three producers the page names:
 *
 *   1. rows the sweep just implicitly closed (closed and still `idle`);
 *   2. rows closed explicitly by SessionEnd whose triage never ran;
 *   3. `completed` rows holding a provenance event id that is NOT in
 *      `last_triaged_event_ids` — the page's re-arm rule.
 *
 * (3) cannot be dropped on the grounds that the write-time re-arm flips such a
 * row back to `idle`. It does (step 7a shipped it — `rearmTriage`,
 * session-provenance.ts), and it still leaves a race it cannot cover. A
 * memory-event row takes its uuidv7 `id` at INSERT but becomes visible at
 * COMMIT, so a transaction that started before the closer's final listing and
 * committed after it holds an id the watermark never saw. Its `sessionRunId`
 * payload is written inside that same transaction, so nothing outside it can
 * observe the row in time to re-arm the session. Without this leg that event is
 * missed permanently — which is precisely the failure the watermark is a SET of
 * ids, rather than a high-water mark, to avoid.
 *
 * COST, AND WHY THE PREDICATE IS SPELLED THE WAY IT IS (issue #183). The EXISTS
 * is cheap per row — it rides `memory_events_session_idx`
 * (`(user_id, (payload->>'sessionRunId'), id)` partial on that key being
 * present, the same index the typed provenance read keysets on) and stops at the
 * first untriaged event — but it was being paid on EVERY `completed` row, and
 * `completed` is the terminal state of the happy path. `LIMIT` bounds rows
 * returned, not rows probed, so the sweep's cost grew with the tenant's HISTORY.
 *
 * `needs_look` fixes that upstream of the query: settled `completed` rows are
 * not in `agent_sessions_closer_idx` at all (0034), so they are never visited.
 * The middle conjunct below therefore repeats the index predicate VERBATIM
 * rather than leaving it implied by the leg beneath it — Postgres' predicate
 * prover then discharges it against the index and drops it from the filter, and
 * the plan assertion in the integration suite pins that it does. The bottom
 * conjunct is the late-commit backstop (see above), now paid only on the flagged
 * rows the index kept.
 *
 * `triage_status <> 'overflowed' AND triage_status <> 'completed'` is exactly
 * {@link CLOSER_ELIGIBLE_STATUSES} over the CHECK-constrained enum, which is why
 * the unconditional leg no longer needs its own `IN` list.
 *
 * The WHERE lives in {@link closerCandidatePredicate} so the integration suite can
 * EXPLAIN the shipped predicate instead of a hand-copied transcription of it — a
 * plan assertion against a second spelling proves nothing once the two drift.
 */
export const closerCandidatePredicate = (userId: string) =>
  and(
    eq(agentSessions.userId, userId),
    isNotNull(agentSessions.closedAt),
    ne(agentSessions.triageStatus, 'overflowed'),
    // `agent_sessions_closer_idx`' predicate, verbatim.
    or(ne(agentSessions.triageStatus, 'completed'), eq(agentSessions.needsLook, true)),
    // The late-commit backstop, on flagged rows only.
    or(ne(agentSessions.triageStatus, 'completed'), hasUntriagedSessionEvent),
  )

export async function listCloserCandidates(
  tx: TenantTx,
  userId: string,
  limit: number,
): Promise<CloserCandidate[]> {
  const rows = await tx
    .select({ id: agentSessions.id, activationEpoch: agentSessions.activationEpoch })
    .from(agentSessions)
    .where(closerCandidatePredicate(userId))
    .orderBy(agentSessions.closedAt)
    .limit(limit)
  return rows.map((row) => ({ sessionRunId: row.id, activationEpoch: row.activationEpoch }))
}

/** Read the closer's bounded inputs for one run, or undefined if not owned (RLS). */
export async function readCloserSession(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
): Promise<CloserSessionRow | undefined> {
  const [row] = await tx
    .select({
      id: agentSessions.id,
      activationEpoch: agentSessions.activationEpoch,
      triageStatus: agentSessions.triageStatus,
      triageAttemptId: agentSessions.triageAttemptId,
      lastTriagedEventIds: agentSessions.lastTriagedEventIds,
      briefedMemories: agentSessions.briefedMemories,
      lastMessageExcerpt: agentSessions.lastMessageExcerpt,
      project: agentSessions.project,
      scope: agentSessions.scope,
      closedAt: agentSessions.closedAt,
      lastSeenAt: agentSessions.lastSeenAt,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.id, sessionRunId)))
    .limit(1)
  if (row === undefined) return undefined
  return {
    sessionRunId: row.id,
    activationEpoch: row.activationEpoch,
    triageStatus: row.triageStatus as AgentSessionTriageStatus,
    triageAttemptId: row.triageAttemptId,
    lastTriagedEventIds: row.lastTriagedEventIds,
    briefedMemories: row.briefedMemories,
    lastMessageExcerpt: row.lastMessageExcerpt,
    project: row.project,
    scope: row.scope,
    closedAt: row.closedAt,
    lastSeenAt: row.lastSeenAt,
  }
}

/**
 * CLAIM the run for one closer attempt: an atomic compare-and-set of
 * `triage_attempt_id`, fenced at the epoch the caller observed. Returns true
 * when this attempt owns the run.
 *
 * WHY NOT A NEW `processing` STATUS. `triage_status` is the Stop-handshake
 * vocabulary (layer 4) — `idle`/`pending`/`completed`/`expired`/`overflowed`
 * describe what the interactive nudge did, and only `idle` re-arms it. A
 * closer-only sixth value would put a background job's liveness into an enum a
 * different mechanism reads, and would need its own stale-claim recovery for a
 * worker that dies mid-pass. `triage_attempt_id` already exists as the claim
 * token, and Postgres serializes two UPDATEs of the same row, so the CAS below
 * is exactly as atomic with none of that coupling. It also keeps the CHECK
 * constraint, the Zod enum and the page's own status list unchanged — no
 * migration, table count still 27.
 *
 * The trade the CAS makes: it is a fence, not an exclusive lease, so two jobs
 * that are BOTH in flight can each hold a claim across a retry boundary. That
 * is affordable only because v1 is resolve-only — the second pass live-re-reads
 * every candidate and finds it already `resolved`, so it writes nothing. A
 * closer that could `remember` would need the stronger lock.
 *
 * ---------------------------------------------------------------------------
 * THE CLAIM RETIRES A `pending` HANDSHAKE (`pending` -> `expired`).
 * ---------------------------------------------------------------------------
 * `triage_attempt_id` has two writers — this CAS and the interactive Stop
 * handshake (session-triage.ts) — and the handshake's own fence is
 * `(triage_status = 'pending' AND triage_attempt_id = <the token begin
 * returned>)`. Swapping the token while LEAVING the status `pending` therefore
 * published a closer-owned claim into the interactive vocabulary:
 *
 *   begin arms A -> lease expires -> sweep closes -> closer CASes A -> C,
 *   status still `pending` -> the session RESUMES (resurrection preserves
 *   `triage_status` and `triage_attempt_id`) -> the hook's next `begin` sees
 *   `pending` and hands the hook back C -> `complete(C)` passes a fence that
 *   only ever checked the status and the token.
 *
 * The hook then stamped a terminal status for a continuation that never
 * happened: the session had DIED, and any provenance the resurrected session
 * has written since is ordinary MCP traffic, not an answer to a debrief nobody
 * was there to read. Because `since_begin` is non-empty for that traffic, the
 * outcome is `completed` — which is NOT closer-eligible — so a run that should
 * have stayed eligible is silently retired. False `completed` is the one
 * direction the page cares about.
 *
 * THE FIX IS ONE `CASE`, not a discriminator column. The closer only ever
 * claims a CLOSED row, and a closed row that is still `pending` is BY
 * DEFINITION an attempt whose session ended before `complete` — an abandoned
 * handshake. `expired` is already this page's word for "a triage attempt that
 * produced no completion", and it is unconditionally closer-eligible, so
 * retiring the attempt at claim time states a truth the closer was relying on
 * anyway. It buys the invariant the interactive fence needs:
 *
 *   **`pending` means an INTERACTIVE attempt is in flight, and nothing else.**
 *   `armAttempt` is the only writer of `pending` in the codebase; the closer
 *   now never leaves one behind.
 *
 * The three interleavings, traced:
 *   1. claim -> finish (happy path). `finishSessionTriage` is fenced on the
 *      epoch and the token, NOT the status, so the flip is invisible to it.
 *   2. claim -> resurrect -> hook `begin`/`complete`. The row is `expired`, so
 *      `begin` applies the expired ENTRY rule — decline `no-signal`, or arm a
 *      FRESH attempt with the hook's own token and a fresh begin watermark. A
 *      stale `complete` carrying either old token fails the status leg. No
 *      foreign token is ever handed to the hook.
 *   3. claim -> resurrect -> re-close -> closer re-claims. `expired` is in
 *      CLOSER_ELIGIBLE_STATUSES, so `listCloserCandidates` still selects it and
 *      `closeSessionRun`'s own `isCloserEligible` still admits it; the retry
 *      CASes from whatever token it observes. Unchanged.
 *
 * `closed_at IS NOT NULL` is asserted here rather than left to the caller.
 * `closeSessionRun` already refuses a live run, and any closed -> live
 * transition bumps the epoch so the CAS would fail anyway — but "the closer
 * only claims closed rows" is now load-bearing for the flip above, and an
 * invariant that a status transition depends on belongs in the statement that
 * performs it, not in a caller two layers up.
 */
export async function claimSessionTriage(
  tx: TenantTx,
  userId: string,
  claim: {
    sessionRunId: string
    activationEpoch: number
    observedAttemptId: string | null
    attemptId: string
  },
): Promise<boolean> {
  const rows = await tx
    .update(agentSessions)
    .set({
      triageAttemptId: claim.attemptId,
      triageStatus: sql`CASE WHEN ${agentSessions.triageStatus} = 'pending' THEN 'expired' ELSE ${agentSessions.triageStatus} END`,
    })
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.id, claim.sessionRunId),
        eq(agentSessions.activationEpoch, claim.activationEpoch),
        // The closer claims CLOSED rows only — see the flip's justification above.
        isNotNull(agentSessions.closedAt),
        // IS NOT DISTINCT FROM, not `=`: the common case is a NULL attempt id,
        // and `= NULL` is never true. Drizzle has no helper for it.
        sql`${agentSessions.triageAttemptId} IS NOT DISTINCT FROM ${claim.observedAttemptId}`,
        inArray(agentSessions.triageStatus, [...CLOSER_ELIGIBLE_STATUSES, 'completed']),
      ),
    )
    .returning({ id: agentSessions.id })
  return rows.length === 1
}

/**
 * Finish the attempt: stamp the terminal `triage_status`, replace the watermark
 * with the full bounded set of event ids VISIBLE now (the page's cumulative-set
 * rule, not a since-attempt delta), and clear the excerpt — the one durable
 * consumption the retention rule allows.
 *
 * Fenced on BOTH the epoch and this attempt's own claim token. A resurrection
 * mid-generation moves the epoch, so this write-back no-ops and the closer's
 * work is abandoned rather than landed on a session the user has resumed.
 * Returns false when the fence rejected it.
 *
 * `clearExcerpt` is false for the `overflowed` path: that run is terminal and
 * was never consumed, so its excerpt is left for the TTL sweep instead of being
 * dropped as if a closer had read it.
 */
export async function finishSessionTriage(
  tx: TenantTx,
  userId: string,
  finish: {
    sessionRunId: string
    activationEpoch: number
    attemptId: string
    triageStatus: Extract<AgentSessionTriageStatus, 'completed' | 'overflowed'>
    visibleEventIds: string[]
    clearExcerpt: boolean
  },
): Promise<boolean> {
  const rows = await tx
    .update(agentSessions)
    .set({
      triageStatus: finish.triageStatus,
      lastTriagedEventIds: finish.visibleEventIds.slice(0, MAX_SESSION_EVENT_IDS),
      ...(finish.clearExcerpt ? { lastMessageExcerpt: null } : {}),
    })
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.id, finish.sessionRunId),
        eq(agentSessions.activationEpoch, finish.activationEpoch),
        eq(agentSessions.triageAttemptId, finish.attemptId),
      ),
    )
    .returning({ id: agentSessions.id })
  if (rows.length !== 1) return false
  // The stamp just moved the watermark, so the flag it implies must be recomputed
  // against it — including the case this closer pass was RACED by a write that
  // committed after the listing it stamped. See {@link settleNeedsLook}.
  await settleNeedsLook(tx, userId, finish.sessionRunId)
  return true
}

/**
 * TTL sweep for `last_message_excerpt` — the page's "TTL sweep leftovers".
 * Bounded by `before` AND by `limit`; returns the count cleared (never the text).
 *
 * SCOPE: every CLOSED row past the floor, whatever its triage status.
 *
 * An earlier version restricted this to `completed` and `overflowed`, reasoning
 * that an `idle`/`pending`/`expired` row is still closer-eligible and needs its
 * excerpt. That leaves a hole with no bottom: a closed, eligible row is only
 * consumed if a closer actually runs, and it may never run — the flag is
 * default-off, the gateway may be unconfigured, the pass may keep reporting
 * `no-gateway`. Those rows would retain user/assistant content indefinitely,
 * which is the one thing the retention rule exists to prevent. A TTL that only
 * fires on the happy path is not a TTL.
 *
 * The trade is explicit: past the floor, RETENTION WINS over a stale input. A
 * closer pass on such a row still has the briefed commitments and the run's
 * event kinds; it loses only the excerpt, and an excerpt that old is poor
 * evidence anyway.
 *
 * OPEN rows are never touched. `closed_at IS NULL` means the session can still
 * come back, and its excerpt is current turn state rather than a leftover — a
 * live row's `last_seen_at` is recent enough that the floor already excludes it,
 * and this predicate is the explicit guarantee rather than a consequence.
 *
 * BOUNDED like the other two legs. Without a limit one pass over a tenant with a
 * long session history would UPDATE and materialise every matching row in a
 * single transaction, holding row locks on the shared maintenance worker far
 * past the advertised per-tenant batch. The remainder is cleared on the next
 * tick; nothing about a TTL needs to finish in one pass. Postgres has no
 * `UPDATE ... LIMIT`, so the bound is a sub-select of ids.
 */
export async function expireStaleExcerpts(
  tx: TenantTx,
  userId: string,
  before: Date,
  limit: number,
): Promise<number> {
  const stale = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        isNotNull(agentSessions.lastMessageExcerpt),
        isNotNull(agentSessions.closedAt),
        lt(agentSessions.lastSeenAt, before),
      ),
    )
    .orderBy(agentSessions.lastSeenAt)
    .limit(limit)
  if (stale.length === 0) return 0

  const rows = await tx
    .update(agentSessions)
    .set({ lastMessageExcerpt: null })
    .where(
      and(
        eq(agentSessions.userId, userId),
        isNotNull(agentSessions.lastMessageExcerpt),
        // Re-assert: a resurrection between the two statements reopens the row,
        // and a live session's excerpt is current turn state, not a leftover.
        isNotNull(agentSessions.closedAt),
        inArray(
          agentSessions.id,
          stale.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: agentSessions.id })
  return rows.length
}
