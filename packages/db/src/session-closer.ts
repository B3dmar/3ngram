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
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
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
 * (3) cannot be dropped on the grounds that a write-time re-arm will flip such a
 * row back to `idle`: no write path in this repository does that yet (it is
 * step 7), and even once it exists there is a real race it cannot cover. A
 * memory-event row takes its uuidv7 `id` at INSERT but becomes visible at
 * COMMIT, so a transaction that started before the closer's final listing and
 * committed after it holds an id the watermark never saw. Its `sessionRunId`
 * payload is written inside that same transaction, so nothing outside it can
 * observe the row in time to re-arm the session. Without this leg that event is
 * missed permanently — which is precisely the failure the watermark is a SET of
 * ids, rather than a high-water mark, to avoid.
 *
 * COST. The `completed` leg rides an EXISTS, not a per-row listing: it stops at
 * the first untriaged event. The inner scan is served by
 * `memory_events_session_idx` — `(user_id, (payload->>'sessionRunId'), id)`
 * partial on that key being present — which is the same index the typed
 * provenance read keysets on, so this adds no new index on the events side. The
 * outer scan is bounded by `agent_sessions_closer_idx` (migration 0033).
 */
export async function listCloserCandidates(
  tx: TenantTx,
  userId: string,
  limit: number,
): Promise<CloserCandidate[]> {
  const rows = await tx
    .select({ id: agentSessions.id, activationEpoch: agentSessions.activationEpoch })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        isNotNull(agentSessions.closedAt),
        or(
          inArray(agentSessions.triageStatus, [...CLOSER_ELIGIBLE_STATUSES]),
          and(eq(agentSessions.triageStatus, 'completed'), hasUntriagedSessionEvent),
        ),
      ),
    )
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
    .set({ triageAttemptId: claim.attemptId })
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.id, claim.sessionRunId),
        eq(agentSessions.activationEpoch, claim.activationEpoch),
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
  return rows.length === 1
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
