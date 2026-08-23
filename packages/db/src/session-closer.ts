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
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { agentSessions } from './schema/agent-sessions.js'

/**
 * Triage states a CLOSED row is closer-eligible in, unconditionally
 * (docs/concepts/session-continuity.mdx layer 5). `completed` is eligible only
 * with untriaged event ids, which is not a scan predicate — see
 * {@link listCloserCandidates}. `overflowed` is terminal and never eligible.
 */
export const CLOSER_ELIGIBLE_STATUSES = ['idle', 'pending', 'expired'] as const

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

  // Re-assert `closed_at IS NULL` in the UPDATE, not just the SELECT: an
  // explicit SessionEnd close can commit between the two statements, and
  // re-stamping would move `closed_at` past the explicit-close window and
  // silently reclassify a close the tenant made deliberately.
  const closed = await tx
    .update(agentSessions)
    .set({ closedAt: now })
    .where(
      and(
        eq(agentSessions.userId, userId),
        isNull(agentSessions.closedAt),
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
 * Covers BOTH producers the page names: the rows the sweep just implicitly
 * closed (they are closed and still `idle`) and rows closed explicitly by
 * SessionEnd whose triage never ran. The `completed`-with-untriaged-events case
 * is deliberately NOT a predicate here — deciding it needs a per-row event
 * listing, which is the closer's job, and the write-time re-arm rule
 * (layer 4) flips such a row back to `idle`, where this query already sees it.
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
        inArray(agentSessions.triageStatus, [...CLOSER_ELIGIBLE_STATUSES]),
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
 * TTL sweep for excerpts on rows the closer will never process: terminal
 * `overflowed` runs, and `completed` runs whose excerpt outlived its
 * consumption. Bounded by `before`; returns the count cleared (never the text).
 *
 * Deliberately narrow. It must not touch an `idle`/`pending`/`expired` row, however
 * old: those are still closer-eligible, and dropping the excerpt would silently
 * remove the closer's only input in the common case.
 */
export async function expireStaleExcerpts(
  tx: TenantTx,
  userId: string,
  before: Date,
): Promise<number> {
  const rows = await tx
    .update(agentSessions)
    .set({ lastMessageExcerpt: null })
    .where(
      and(
        eq(agentSessions.userId, userId),
        isNotNull(agentSessions.lastMessageExcerpt),
        inArray(agentSessions.triageStatus, ['completed', 'overflowed']),
        lt(agentSessions.lastSeenAt, before),
      ),
    )
    .returning({ id: agentSessions.id })
  return rows.length
}
