// SPDX-License-Identifier: Apache-2.0
// The Stop-nudge HANDSHAKE: arm an attempt, then absorb what the continuation
// wrote (docs/concepts/session-continuity.mdx layer 4, "Pending vs complete" and
// "Debounce"). Issue #166 step 7a — the server half; the hook that injects on an
// armed answer is 7b.
//
// SQL ONLY. Core validates at the schema boundary and wraps these in
// withTenant(), so RLS scopes every statement. Addressed by the NATURAL KEY
// (user_id, agent, session_id): Stop is a separate process holding the harness
// conversation id and nothing else.
//
// ---------------------------------------------------------------------------
// WHY `last_triaged_event_ids` IS STAMPED AT BEGIN AS WELL AS AT COMPLETE
// ---------------------------------------------------------------------------
// The page's complete rule needs TWO listings that differ:
//
//   since_begin = event ids for this run since attempt begin   -> zero-write check
//   visible     = all event ids for this run now               -> the watermark
//
// `since_begin` cannot be recovered at complete from `visible` alone, and the
// page forbids both shortcuts that would fake it: not `max(createdAt)`, and not
// "ids greater than X in uuidv7 order" — a late-committing write can hold an
// EARLIER uuidv7, which is exactly the race the watermark is a SET to catch. So
// something must be recorded at BEGIN.
//
// It is recorded in the column that already exists. `begin` stamps the set
// visible when it arms, which generalises the column's invariant from "the set
// visible at the last complete/expire" to "the set already ACCOUNTED FOR by
// triage bookkeeping" — identical at every terminal state (complete replaces it
// with the full visible set, a superset, since visibility only grows), and
// strictly more correct in between: the events that ARMED this attempt are the
// ones the injected debrief is about, so they must not also re-arm the next one.
// `since_begin` is then a set difference over the one listing complete already
// takes, which is why complete needs no second query and no new column.
//
// If the attempt never completes — the hook crashed, the terminal was killed —
// the row is left `pending`, which is UNCONDITIONALLY closer-eligible
// (session-closer.ts). Nothing is stranded by the early stamp.
//
// ---------------------------------------------------------------------------
// COEXISTENCE WITH THE CLOSER (session-closer.ts). READ BEFORE CHANGING EITHER.
// ---------------------------------------------------------------------------
// Both mechanisms write `triage_status` and `triage_attempt_id` on the same row,
// and they are separated by the LIVENESS of the row, not by a lock:
//
//   the closer  runs on CLOSED rows      (listCloserCandidates: closed_at IS NOT NULL)
//   the nudge   runs on LEASED-OPEN rows (begin declines `not-live` otherwise)
//
// (a) LEASE EXPIRES MID-HANDSHAKE. `begin` arms attempt A on a live row; the
//     session dies; the sweep stamps an implicit `closed_at`; the closer selects
//     the row because `pending` is in CLOSER_ELIGIBLE_STATUSES, and its CAS
//     (`triage_attempt_id IS NOT DISTINCT FROM A` -> B, at the observed epoch)
//     succeeds. A late `complete(A)` from the crashed hook then fails BOTH legs
//     of its predicate — the attempt id is B, and the status is no longer
//     `pending` once the closer finishes — so it is a 409, never a clobber. This
//     composes in either order: if the late complete lands FIRST it stamps a
//     terminal status under A, and the closer's own CAS + fenced write-back then
//     govern. The cost of that ordering is one closer pass that re-reads an
//     already-triaged run; it is resolve-only with a live re-read per candidate,
//     so it writes nothing and merely re-stamps the same watermark.
//
// (b) `begin` NEVER ARMS A CLOSED ROW, and never resurrects one. It is the one
//     hook path that does not refresh the lease: the shipped Stop hook already
//     calls `/heartbeat` every turn (step 5b), which is the path the page gives
//     resurrection to, so a nudge that also resurrected would let a mere
//     "should I inject?" question reopen a session the closer may have claimed
//     and bump the epoch under it. Deciding is not touching.
//
// (c) THE EPOCH IS NOT IN THE HANDSHAKE PREDICATE, deliberately. The epoch is a
//     fence for work that spans an ASYNCHRONOUS gap — the closer observes the
//     epoch, then runs an LLM round-trip, then writes back, and needs proof that
//     nothing resurrected the row in between. The handshake has no such gap: both
//     statements read the row `FOR UPDATE` and write it in the SAME transaction,
//     so the row lock already gives what the epoch buys the closer, with no way
//     for an activation to interleave. Requiring it would also force Stop to
//     carry an `activation_epoch` it does not have — the page rejects exactly
//     that for `close` ("SessionEnd has no run mapping"), and Stop is no better
//     placed. What IS in the predicate is the attempt id, which is the thing a
//     stale hook delivery can actually be wrong about.
import {
  type AgentSessionNaturalKey,
  type AgentSessionTriageStatus,
  MAX_SESSION_EVENT_IDS,
  MAX_SESSION_EVENTS_LIMIT,
  type TriageDeclineReason,
  type TriageOutcomeStatus,
} from '@3ngram/schema'
import { and, eq } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { agentSessions } from './schema/agent-sessions.js'
import { hasUntriagedSessionEvent } from './session-closer.js'
import { listSessionEvents } from './session-events-read.js'
import { isLeased } from './session-lease.js'
import { AgentSessionNotFoundError } from './session-lifecycle.js'

/**
 * A `triage/complete` whose attempt is no longer the current one, or whose run
 * is no longer `pending`. The stale-complete case the attempt-id predicate
 * exists for: a crashed hook retrying, a second Stop, or a closer that re-claimed
 * the row after the lease expired mid-handshake. Reported rather than silently
 * ignored so the hook can stop nagging instead of retrying forever.
 */
export class AgentSessionTriageConflictError extends Error {
  readonly agent: string
  readonly sessionId: string
  readonly attemptId: string
  constructor(key: AgentSessionNaturalKey, attemptId: string) {
    super('triage attempt is not the current one')
    this.name = 'AgentSessionTriageConflictError'
    this.agent = key.agent
    this.sessionId = key.sessionId
    this.attemptId = attemptId
  }
}

/** Tunable debounce floors (packages/config). The CONDITION is not optional; these are. */
export interface TriageDebounceThresholds {
  minTurns: number
  minElapsedMs: number
}

/** The arm-or-decline verdict, plus the row state that justified it. */
export interface BeginTriageResult {
  sessionRunId: string
  armed: boolean
  attemptId?: string
  triageStatus: AgentSessionTriageStatus
  reason?: TriageDeclineReason
}

/** The absorb receipt. Counts only — the ids stay on the row. */
export interface CompleteTriageResult {
  sessionRunId: string
  triageStatus: TriageOutcomeStatus
  eventCount: number
  sinceBeginCount: number
  truncated: boolean
}

interface TriageRow {
  id: string
  openedAt: Date
  closedAt: Date | null
  lastSeenAt: Date
  triageStatus: AgentSessionTriageStatus
  triageAttemptId: string | null
  lastTriagedEventIds: string[]
}

const TRIAGE_COLUMNS = {
  id: agentSessions.id,
  openedAt: agentSessions.openedAt,
  closedAt: agentSessions.closedAt,
  lastSeenAt: agentSessions.lastSeenAt,
  triageStatus: agentSessions.triageStatus,
  triageAttemptId: agentSessions.triageAttemptId,
  lastTriagedEventIds: agentSessions.lastTriagedEventIds,
} as const

function keyPredicate(userId: string, key: AgentSessionNaturalKey) {
  return and(
    eq(agentSessions.userId, userId),
    eq(agentSessions.agent, key.agent),
    eq(agentSessions.sessionId, key.sessionId),
  )
}

/**
 * Read the handshake's row, ROW-LOCKED for the rest of the transaction.
 *
 * LOCK ORDER (repo-wide: advisory BEFORE row). Both handshake statements take a
 * row lock and NEVER take the session-attach advisory lock, which is what makes
 * that safe rather than an inversion — the same argument `closeSession` makes.
 * A path that never waits on an advisory lock cannot be the cycle in one. It is
 * also honest about scope: the handshake changes neither the leased-open set nor
 * the epoch, so it has no reason to serialize against the attach path; it only
 * needs its own row to hold still between the decision and the write it
 * justifies.
 */
async function lockTriageRow(
  tx: TenantTx,
  userId: string,
  key: AgentSessionNaturalKey,
): Promise<TriageRow | undefined> {
  const [row] = await tx
    .select(TRIAGE_COLUMNS)
    .from(agentSessions)
    .where(keyPredicate(userId, key))
    .for('update')
  if (row === undefined) return undefined
  // `triage_status` is a TEXT column with a generated CHECK, so the driver types
  // it as string; the enum is the schema boundary's (agentSessionTriageStatusSchema),
  // and the CHECK is what makes the narrowing true. Same shape readCloserSession uses.
  return { ...row, triageStatus: row.triageStatus as AgentSessionTriageStatus }
}

/** Does this run hold a provenance event outside its watermark? The page's re-arm signal. */
async function hasUntriagedEvent(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.id, sessionRunId),
        hasUntriagedSessionEvent,
      ),
    )
    .limit(1)
  return row !== undefined
}

/**
 * Every provenance event id for one run, in uuidv7 order, bounded by the per-run
 * ceiling. REUSES the typed provenance read (session-events-read.ts) rather than
 * hand-rolling a second query over `memory_events`, so the payload projection,
 * the index-compatible predicate and the truncation rule have one definition.
 *
 * `truncated` is the page's terminal overflow signal, carried out of the loop
 * because it can be raised on any page.
 */
async function listVisibleEventIds(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
  ceiling: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = []
  let cursor: string | undefined
  let truncated = false
  for (;;) {
    const page = await listSessionEvents(tx, userId, sessionRunId, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: MAX_SESSION_EVENTS_LIMIT,
      ceiling,
    })
    for (const event of page.items) ids.push(event.id)
    if (page.truncated) truncated = true
    if (page.nextCursor === undefined) break
    cursor = page.nextCursor
  }
  return { ids, truncated }
}

/** What {@link evaluateTriageEntry} decides, before any listing is taken. */
export type TriageEntryDecision = { arm: true } | { arm: false; reason: TriageDeclineReason }

/**
 * THE ENTRY RULE, as a pure function so the whole matrix
 * (triage_status x signal x debounce) is unit-testable without a database.
 *
 * | triage_status | untriaged event | entry                                    |
 * |---------------|-----------------|------------------------------------------|
 * | any, row dead | any             | `not-live` — a nudge needs a live session |
 * | `overflowed`  | any             | `terminal` — past the ceiling, forever    |
 * | `pending`     | any             | `pending` — finish the attempt, no re-arm |
 * | `idle`        | no              | debounce decides (turns / elapsed)        |
 * | `idle`        | yes             | ARM (signal satisfies the debounce)       |
 * | `completed`   | no              | `no-signal`                               |
 * | `completed`   | yes             | ARM                                       |
 * | `expired`     | no              | `no-signal`                               |
 * | `expired`     | yes             | ARM                                       |
 *
 * `expired` BEHAVES LIKE `completed` FOR ENTRY, and that is the nag-loop rule,
 * not an oversight: "*a zero-write continuation must not re-inject on every later
 * Stop — the numeric cap bounds within-turn continuations, not cross-turn nags*".
 * An `expired` run is one whose last nudge produced nothing; re-injecting on the
 * strength of elapsed time alone would nag the same unresponsive session every
 * ten minutes forever. It re-enters only on real new signal. `expired` stays
 * closer-eligible throughout — declining a nudge is not declining a debrief.
 *
 * DEBOUNCE (the page: *require session substance before a nudge: a minimum turn
 * count OR elapsed time OR a provenance event that is not itself a prior-triage
 * write*). The third disjunct is the untriaged-event signal — "not itself a
 * prior-triage write" is precisely "not in `last_triaged_event_ids`", which is
 * why the same probe serves both the entry rule and the debounce.
 */
export function evaluateTriageEntry(input: {
  live: boolean
  triageStatus: AgentSessionTriageStatus
  untriagedEvent: boolean
  turnCount: number
  elapsedMs: number
  thresholds: TriageDebounceThresholds
}): TriageEntryDecision {
  if (!input.live) return { arm: false, reason: 'not-live' }
  if (input.triageStatus === 'overflowed') return { arm: false, reason: 'terminal' }
  if (input.triageStatus === 'pending') return { arm: false, reason: 'pending' }
  if (input.triageStatus !== 'idle' && !input.untriagedEvent) {
    return { arm: false, reason: 'no-signal' }
  }
  const substantial =
    input.untriagedEvent ||
    input.turnCount >= input.thresholds.minTurns ||
    input.elapsedMs >= input.thresholds.minElapsedMs
  return substantial ? { arm: true } : { arm: false, reason: 'debounce' }
}

export interface BeginTriageOptions {
  /** The attempt token to stamp. Minted by core so a test can pin it. */
  attemptId: string
  /** The hook's turn-count hint. Absent reads as zero — the other two disjuncts still apply. */
  turnCount?: number | undefined
  thresholds: TriageDebounceThresholds
  now: Date
  /**
   * Per-run ceiling. Injected ONLY so a test can exercise the truncation branch
   * without inserting MAX_SESSION_EVENT_IDS + 1 events; production always takes
   * the default. Same seam `ListSessionEventsOptions.ceiling` opens.
   */
  ceiling?: number | undefined
}

/**
 * ARM an attempt, or explain why not.
 *
 * Order matters: the cheap row checks and the single-row signal probe decide
 * first, and the full bounded listing is taken ONLY when the answer is "arm".
 * A Stop that declines — the common case, since a live run sits `completed`
 * between nudges — costs one locked row read plus one EXISTS that stops at the
 * first untriaged event.
 */
export async function beginSessionTriage(
  tx: TenantTx,
  userId: string,
  key: AgentSessionNaturalKey,
  options: BeginTriageOptions,
): Promise<BeginTriageResult> {
  const row = await lockTriageRow(tx, userId, key)
  // Stop deliberately never CREATES a missing row (the page: SessionStart owns
  // the open, and an unattributed session is better than one Stop invented).
  if (row === undefined) throw new AgentSessionNotFoundError(key)

  const live = row.closedAt === null && isLeased(row.lastSeenAt, options.now)
  // Skip the probe entirely when no status can use it — a dead, terminal or
  // pending row declines whatever the signal says.
  const needsSignal = live && row.triageStatus !== 'overflowed' && row.triageStatus !== 'pending'
  const untriagedEvent = needsSignal ? await hasUntriagedEvent(tx, userId, row.id) : false

  const decision = evaluateTriageEntry({
    live,
    triageStatus: row.triageStatus,
    untriagedEvent,
    turnCount: options.turnCount ?? 0,
    elapsedMs: options.now.getTime() - row.openedAt.getTime(),
    thresholds: options.thresholds,
  })
  if (!decision.arm) {
    return {
      sessionRunId: row.id,
      armed: false,
      // The `pending` decline hands back the attempt already in flight: the page
      // wants that later Stop to FINISH the attempt, not to inject a second one.
      ...(decision.reason === 'pending' && row.triageAttemptId !== null
        ? { attemptId: row.triageAttemptId }
        : {}),
      triageStatus: row.triageStatus,
      reason: decision.reason,
    }
  }
  return armAttempt(tx, userId, key, row, options)
}

/**
 * Stamp `pending` + the attempt token + the begin watermark.
 *
 * TRUNCATION IS CHECKED HERE TOO, not only at complete. A run already past the
 * per-run ceiling is `overflowed` — terminal, no closer retry — so arming it
 * would inject a debrief whose `complete` can only stamp `overflowed` anyway,
 * and declining WITHOUT stamping would re-list the whole ceiling on every later
 * Stop (the signal is present, so the debounce cannot stop it). Stamping the
 * terminal status is what converges.
 *
 * No `WHERE` beyond the natural key: the row is held `FOR UPDATE` from
 * {@link lockTriageRow} in this same transaction, so the state the decision read
 * is the state this statement writes over. See coexistence note (c) for why the
 * epoch is not here.
 */
async function armAttempt(
  tx: TenantTx,
  userId: string,
  key: AgentSessionNaturalKey,
  row: TriageRow,
  options: BeginTriageOptions,
): Promise<BeginTriageResult> {
  const visible = await listVisibleEventIds(
    tx,
    userId,
    row.id,
    options.ceiling ?? MAX_SESSION_EVENT_IDS,
  )
  const overflowed = visible.truncated
  await tx
    .update(agentSessions)
    .set({
      triageStatus: overflowed ? 'overflowed' : 'pending',
      ...(overflowed
        ? {}
        : { triageAttemptId: options.attemptId, lastTriagedEventIds: visible.ids }),
    })
    .where(keyPredicate(userId, key))
  if (overflowed) {
    return {
      sessionRunId: row.id,
      armed: false,
      triageStatus: 'overflowed',
      reason: 'overflowed',
    }
  }
  return {
    sessionRunId: row.id,
    armed: true,
    attemptId: options.attemptId,
    triageStatus: 'pending',
  }
}

export interface CompleteTriageOptions {
  /** The attempt this call claims to be finishing. The fence. */
  attemptId: string
  /** Test-only per-run ceiling override; see {@link BeginTriageOptions.ceiling}. */
  ceiling?: number | undefined
}

/**
 * ABSORB the continuation's writes and stamp the outcome, exactly per the page:
 *
 *   since_begin = visible \ last_triaged_event_ids  (the set stamped at begin)
 *   visible     = every event id for the run now, bounded by the ceiling
 *   -> truncated            : `overflowed`  (terminal; the closer does not retry)
 *   -> since_begin is empty : `expired`     (zero-write; the closer still runs)
 *   -> otherwise            : `completed`
 *   last_triaged_event_ids  = visible       (CUMULATIVE, never the since-begin slice)
 *
 * The cumulative watermark is the part the page explicitly fixed: storing only
 * `since_begin` would re-arm immediately on the pre-attempt events that armed
 * the debounce in the first place.
 *
 * THE FENCE is `triage_attempt_id = attemptId AND triage_status = 'pending'`,
 * asserted in code under the row lock and re-asserted in the UPDATE. The status
 * leg is what makes a REPEAT complete of the same attempt a clean 409 instead of
 * a re-computation that would demote a `completed` run to `expired` (the second
 * call sees zero writes since begin). See coexistence note (a) for the closer.
 *
 * NOT guarded on liveness. The session may have ended or been swept between
 * begin and complete, and absorbing the writes is strictly better information
 * than leaving the row `pending` — the attempt id, not the lease, is what says
 * whether this caller still speaks for the attempt.
 *
 * `last_message_excerpt` is NOT cleared. Retention is unchanged: only the closer
 * durably consumes it, or the TTL sweep drops it.
 */
export async function completeSessionTriage(
  tx: TenantTx,
  userId: string,
  key: AgentSessionNaturalKey,
  options: CompleteTriageOptions,
): Promise<CompleteTriageResult> {
  const row = await lockTriageRow(tx, userId, key)
  if (row === undefined) throw new AgentSessionNotFoundError(key)
  if (row.triageStatus !== 'pending' || row.triageAttemptId !== options.attemptId) {
    throw new AgentSessionTriageConflictError(key, options.attemptId)
  }

  const visible = await listVisibleEventIds(
    tx,
    userId,
    row.id,
    options.ceiling ?? MAX_SESSION_EVENT_IDS,
  )
  const accounted = new Set(row.lastTriagedEventIds)
  const sinceBegin = visible.ids.filter((id) => !accounted.has(id))
  const triageStatus: TriageOutcomeStatus = visible.truncated
    ? 'overflowed'
    : sinceBegin.length === 0
      ? 'expired'
      : 'completed'

  const stamped = await tx
    .update(agentSessions)
    .set({ triageStatus, lastTriagedEventIds: visible.ids.slice(0, MAX_SESSION_EVENT_IDS) })
    .where(
      and(
        keyPredicate(userId, key),
        eq(agentSessions.triageAttemptId, options.attemptId),
        eq(agentSessions.triageStatus, 'pending'),
      ),
    )
    .returning({ id: agentSessions.id })
  if (stamped.length !== 1) throw new AgentSessionTriageConflictError(key, options.attemptId)

  return {
    sessionRunId: row.id,
    triageStatus,
    eventCount: Math.min(visible.ids.length, MAX_SESSION_EVENT_IDS),
    sinceBeginCount: sinceBegin.length,
    truncated: visible.truncated,
  }
}
