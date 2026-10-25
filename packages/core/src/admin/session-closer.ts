// SPDX-License-Identifier: Apache-2.0
// Session closer v1 — RESOLVE ONLY (docs/concepts/session-continuity.mdx layer 5).
//
// The BUSINESS LOGIC behind the apps/worker closer job. It reads one closed
// run's bounded bookkeeping, asks the model which of the commitments that run
// was BRIEFED on the work completed, and resolves those — nothing else.
//
// WHAT IT MAY WRITE, AND WHY THAT LIST IS SO SHORT.
//   - `resolve` on a briefed commitment, via the existing transitionCommitment
//     path.
//   - On the typed-judgment path only (issue #229): a RESOLUTION PROPOSAL for a
//     briefed commitment judged plausibly done (LOW <= p < HIGH). This revises
//     the page's original "no third proposal kind": with a calibrated
//     probability there is now a principled band that is neither safe to
//     auto-resolve nor right to drop, and review_proposals is the existing defer
//     surface. A proposal is not a corpus row — it lives in its own review table,
//     one OPEN row per commitment (a retry re-inserts nothing), and a reviewer's
//     accept is what resolves.
//   - NEVER `remember`. A retried LLM pass that could insert memories is how an
//     append-only corpus (hard rule 1: rows are never deleted) grows duplicates
//     that nothing can clean up. The page rejects it by name, and rejects the
//     machinery it would drag in with it — a claim table keyed
//     `(attempt_id, ordinal)`, epochs per write.
//   - NEVER `revise`, `archive` or `unresolve`. Only the one verb the 0%
//     commitment-recall hole is measured in.
// `resolve` is REVERSIBLE (`unresolve` is a legal FSM edge back to `open`), and
// that reversibility is the entire safety argument for letting a model drive
// this at all. A wrong resolve is a mistake a human undoes; a wrong `remember`
// is a corpus row that outlives the mistake.
//
// TWO CLASSIFIERS, ONE WRITE PATH. Tenants that opted in to judgment (issue
// #225) are classified by `gateway.decide()`, one typed Noul per briefed
// commitment (session-closer-judgment.ts, issue #229); everyone else, and any
// deployment without a judgment gateway, by the single `complete()` pass below.
// Either way the only corpus write is the same `resolve`.
//
// DEFAULT-OFF. The worker only schedules this behind a config flag. The
// validation bar for turning it on — a positive commitment-recall improvement
// against the 0% baseline, measured by a dogfood audit, not by CI — is a later,
// separate decision.
//
// Observability (hard rule 6): ids, counts, outcome labels. The excerpt is
// user/assistant content and the briefed topics are memory content: neither is
// ever logged, and neither is ever echoed in an error message, including the
// errors raised when the model returns something unparseable.
import {
  claimSessionTriage,
  finishSessionTriage,
  insertLlmUsage,
  insertResolutionProposals,
  listSessionEvents,
  readCloserSession,
  recordCloserFailure,
  withTenant,
} from '@3ngram/db'
import type { Gateway } from '@3ngram/llm'
import { type BriefedMemory, MAX_SESSION_EVENT_IDS, MAX_SESSION_EVENTS_LIMIT } from '@3ngram/schema'
import type { BudgetEnforcement } from '../budget/index.js'
import { isJudgmentEnabled } from '../settings/judgment.js'
import { type ClosedRunResolveOutcome, resolveForClosedRun } from '../write/commitments.js'
import { classify } from './session-closer-classify.js'

/**
 * Actor recorded on every event the closer emits.
 *
 * `worker` over `system`, and never `capture_hook` (removed by migration 0010
 * and forbidden by name in the page). The enum names the TRANSPORT that made
 * the write — `user_mcp`, `user_api`, `user_dashboard`, `importer` — and this
 * write's transport is the background worker, exactly like the surfacing
 * sweep's `archive` events, which already record `worker`. `system` is the
 * platform acting with no transport at all (provisioning's welcome memory,
 * embed re-failure); reusing it here would make the closer's writes
 * indistinguishable from those in an audit trail whose whole job is telling
 * writers apart.
 */
export const CLOSER_ACTOR_KIND = 'worker' as const

// Split-out modules (hard rule 5's file budget); re-exported so the public
// surface of this module is unchanged.
export {
  CLOSER_MAX_OUTPUT_TOKENS,
  CLOSER_OPERATION,
  COMPLETION_PRICE_USD_PER_TOKEN,
  completionCostUsd,
} from './session-closer-classify.js'
export {
  CloserVerdictError,
  fenceExcerpt,
  renderCloserPrompt,
  selectResolvable,
} from './session-closer-prompt.js'

/** Per-call page size for the closer's provenance read; the per-run ceiling caps the total. */
export const CLOSER_EVENTS_PAGE_SIZE = MAX_SESSION_EVENTS_LIMIT

/** Terminal reason a closer pass did no work. Content-free; safe to log/metric. */
export type CloserSkipReason =
  /** The run vanished, or is not this tenant's (RLS). */
  | 'not-found'
  /** `triage_status` is not closer-eligible — `overflowed` is terminal. */
  | 'not-eligible'
  /** The run is not closed: a heartbeat or resume revived it before we ran. */
  | 'not-closed'
  /** Another attempt holds the claim, or the epoch moved. */
  | 'claim-lost'
  /** The epoch moved DURING the pass; the attempt abandons without writing. */
  | 'fenced'
  /** More events than the per-run ceiling. Terminal `overflowed`, metric only. */
  | 'overflowed'
  /** The run was briefed on no commitments, so there is nothing to resolve. */
  | 'nothing-briefed'
  /** No gateway is configured, so the classification pass cannot run. */
  | 'no-gateway'

/** One closer pass's outcome. Ids and counts only. */
export interface CloserResult {
  sessionRunId: string
  /** Absent when the pass ran; set when it stopped early. */
  skipped?: CloserSkipReason
  /** Briefed commitments the model named, after intersecting with the briefed set. */
  candidates: number
  /** Ids the model returned that were NOT in the briefed set, and were dropped. */
  rejected: number
  /** Candidates that actually transitioned to `resolved`. */
  resolved: number
  /** Candidates skipped by the live re-read (already resolved, illegal, not a commitment). */
  skippedCandidates: number
  /**
   * Resolution proposals newly staged for review (typed-judgment mid band, issue
   * #229). 0 on the complete() path, and for a commitment that already had an
   * open proposal.
   */
  proposed?: number
}

/** One provenance event, narrowed to what the closer's prompt may see. */
export interface CloserEventSummary {
  id: string
  eventKind: string
}

/**
 * The seam the closer needs. Every member is injectable so the policy is
 * unit-tested with no database, no Redis and no network — the LLM included.
 */
export interface SessionCloserRepo {
  /** The run's bounded bookkeeping row, or undefined if absent / not owned. */
  readSession(userId: string, sessionRunId: string): Promise<CloserSessionInput | undefined>
  /**
   * Every provenance event id for this run, in uuidv7 order, paginated to the
   * per-run ceiling. `truncated` is the terminal overflow signal.
   */
  listEvents(userId: string, sessionRunId: string): Promise<CloserEventPage>
  /** Atomic compare-and-set claim at the observed epoch. */
  claim(userId: string, claim: CloserClaim): Promise<boolean>
  /**
   * Live re-read + resolve of one briefed commitment, stamping the run's
   * provenance. `expectedEpoch` is fenced INSIDE the same write transaction
   * (issue #185) — see {@link ClosedRunResolveOutcome}'s `epoch-fenced` member.
   */
  resolve(
    userId: string,
    memoryId: string,
    sessionRunId: string,
    expectedEpoch: number,
  ): Promise<ClosedRunResolveOutcome>
  /**
   * Stage resolution proposals for this run (issue #229): insert-only, one open
   * row per commitment (an existing open one is a no-op). Returns rows inserted.
   */
  propose(
    userId: string,
    sessionRunId: string,
    proposals: readonly { memoryId: string; probability: number }[],
  ): Promise<number>
  /** Epoch-fenced write-back of the terminal status, watermark and excerpt clear. */
  finish(userId: string, finish: CloserFinish): Promise<boolean>
  /** Record one `llm_usage` row for the generation call. Best-effort by contract. */
  recordUsage(userId: string, usage: CloserUsage): Promise<void>
  /** The run's CURRENT activation epoch, or undefined if it vanished. */
  currentEpoch(userId: string, sessionRunId: string): Promise<number | undefined>
  /**
   * Stamp the per-row backoff after a FAILED pass (issue #184) — see
   * {@link closeSessionRun}'s catch. Epoch-fenced, so a resurrection mid-pass
   * makes it a no-op; best-effort from the caller's side (it must never mask
   * the failure that triggered it). Deliberately carries NO count or delay —
   * see {@link CloserFailureInput}: the implementation derives both from the
   * row's value at write time, not a value this caller observed earlier.
   */
  recordFailure(userId: string, failure: CloserFailureInput): Promise<void>
  /**
   * Did this tenant opt in to typed judgments (issue #225)? Read once per pass,
   * after the claim. Only `true` routes the pass to `gateway.decide()`.
   */
  isJudgmentEnabled(userId: string): Promise<boolean>
}

/** Content-free accounting for one closer generation call. */
export interface CloserUsage {
  operation: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

/** The closer's bounded view of the session row. */
export interface CloserSessionInput {
  sessionRunId: string
  activationEpoch: number
  triageStatus: string
  triageAttemptId: string | null
  lastTriagedEventIds: string[]
  briefedMemories: BriefedMemory[]
  /** BOUNDED user/assistant content. Prompt input only — never logged. */
  lastMessageExcerpt: string | null
  project: string | null
  scope: string | null
  closedAt: Date | null
}

/**
 * Fence + clock the failure recording needs; see
 * {@link SessionCloserRepo.recordFailure}. Deliberately NOT a count or a
 * computed delay (Codex review of PR #196, comment 3843607494) — this used to
 * carry `failureCount`/`nextAttemptAt` computed from `CloserSessionInput`'s
 * count, read at the START of the pass. A `completeSessionTriage` that resets
 * the row's backoff between that read and this write (a durable write-back
 * with no epoch bump, unlike a resurrect) would then have its reset
 * overwritten by the stale pre-race count. The db-layer implementation now
 * computes both columns from the row's value AT WRITE TIME, atomically, in
 * one statement — so there is nothing left here to go stale.
 */
export interface CloserFailureInput {
  sessionRunId: string
  activationEpoch: number
  /** Injected clock (issue #184) — core reads no clock of its own. */
  now: Date
}

export interface CloserEventPage {
  items: CloserEventSummary[]
  truncated: boolean
}

export interface CloserClaim {
  sessionRunId: string
  activationEpoch: number
  observedAttemptId: string | null
  attemptId: string
}

export interface CloserFinish {
  sessionRunId: string
  activationEpoch: number
  attemptId: string
  triageStatus: 'completed' | 'overflowed'
  visibleEventIds: string[]
  clearExcerpt: boolean
}

/** Everything one closer pass needs beyond the repo. */
export interface CloserOptions {
  /** Injected Gateway. Absent → the pass skips with `no-gateway`; it never guesses. */
  gateway?: Gateway | undefined
  /** Mints the attempt id. Injected so a test can pin it. */
  newAttemptId: () => string
  /**
   * Injected budget enforcement. Present → the generation is reserved against
   * the tenant's cap BEFORE the call and released after, exactly as the embed
   * seam does. Absent → no gate (the same back-compat shape `EmbedOptions` uses).
   */
  budget?: BudgetEnforcement | undefined
  /**
   * Injected clock (issue #184) — core reads no clock of its own. The only use
   * is stamping `nextAttemptAt` on a FAILED pass, so a fake gateway that never
   * throws never needs to supply a meaningful one.
   */
  now: Date
  /**
   * Is this the LAST retry BullMQ will make for the enqueued job (issue #184
   * audit F3)? Core has no notion of a "job" or an "attempt" — this is a plain
   * boolean handed down from the one place that does: `apps/worker`'s queue
   * processor, off `job.attemptsMade`/`job.opts.attempts` (`CLOSER_JOB_OPTS`:
   * up to 3 tries, 30s/60s apart). WHY IT GATES THE STAMP: without it, a single
   * enqueue that fails three times racks up THREE row-level failures within
   * about ninety seconds — the row would be at the 4-HOUR cap before the first
   * sweep tick even ran again, for what might have been a sub-two-minute blip.
   * Stamping only on the attempt that will NOT retry makes one enqueued job
   * cost at most one row-level failure, which is what makes "the backoff grows
   * one step per sweep tick" (the doc/changeset claim) actually true rather
   * than aspirational.
   */
  isLastAttempt: boolean
  /**
   * Best-effort observability hook (issue #184 audit F5): called with whatever
   * `repo.recordFailure` threw, ONLY when it threw. Core never logs (hard rule
   * 5) — this is the seam the worker uses to emit a content-free warning
   * (run id + `err.name`, hard rule 6). Absent → the secondary failure is
   * silently dropped, same as before this hook existed.
   */
  onRecordFailureError?: (err: unknown) => void
}

/**
 * Triage states a CLOSED run is eligible in. Mirrors
 * CLOSER_ELIGIBLE_STATUSES in packages/db, plus the `completed` case, which is
 * conditional and therefore decided here rather than in a scan predicate.
 * `overflowed` is terminal and appears in neither.
 */
const UNCONDITIONALLY_ELIGIBLE = new Set(['idle', 'pending', 'expired'])

/**
 * Is this run eligible NOW? Re-checked inside the pass, not just by the sweep's
 * query, because the queue is asynchronous: a run can be resumed, triaged or
 * overflowed between being enqueued and being picked up.
 *
 * `completed` is eligible only with untriaged signal — a provenance event id
 * that is not in `last_triaged_event_ids`. That is the page's re-arm rule
 * evaluated over the cumulative watermark, and it is why the watermark is a SET
 * of ids rather than a high-water timestamp: a late-committing write can hold an
 * earlier uuidv7, so "greater than the last id" would miss exactly the event the
 * set exists to catch.
 */
export function isCloserEligible(
  triageStatus: string,
  visibleEventIds: readonly string[],
  lastTriagedEventIds: readonly string[],
): boolean {
  if (UNCONDITIONALLY_ELIGIBLE.has(triageStatus)) return true
  if (triageStatus !== 'completed') return false
  const triaged = new Set(lastTriagedEventIds)
  return visibleEventIds.some((id) => !triaged.has(id))
}

/**
 * Run one closer pass over one run.
 *
 * The shape, in order, and why each step is where it is:
 *
 *   1. READ + RE-CHECK ELIGIBILITY. The queue is asynchronous, so nothing the
 *      sweep observed is still guaranteed. A run that was resumed is `not-closed`
 *      and abandoned — the user is back, and a mid-conversation debrief is the
 *      failure mode the grace exists to avoid.
 *   2. LIST EVENTS. Truncated → terminal `overflowed`, stamped and never
 *      re-claimed: the page is explicit that a pathological run must not
 *      re-spend an LLM pass forever. Marking it is itself a fenced write.
 *   3. CLAIM. Compare-and-set at the observed epoch (see packages/db). A lost
 *      claim is a clean no-op.
 *   3b. RESERVE THE BUDGET SLOT, THEN RE-CHECK THE EPOCH, IMMEDIATELY BEFORE THE
 *      GATEWAY CALL (issue #185). Claiming, listing events and the reservation
 *      itself are all further awaited work — the reservation can block on a
 *      per-user advisory lock for as long as another metered call for this user
 *      is in flight — so the epoch the claim fenced on can already be stale by
 *      the time the prompt is about to go out. The check runs AFTER the
 *      reservation, not before, so that blocking wait never inflates the
 *      residual: this is the LAST awaited step before the excerpt and briefed
 *      topics leave the process. Once `gateway.complete` is called, that
 *      content is on the wire for up to the gateway's timeout regardless of
 *      anything that happens after, so the per-resolve check in step 5 (which
 *      runs only AFTER that round trip returns) is too late to stop the send,
 *      only to stop acting on the reply. Skip `fenced`, same as every other
 *      epoch miss; the reservation still gets released by the `finally` below.
 *      THIS IS A NARROWING FENCE, NOT A SERIALIZED HANDOFF: the check is a
 *      READ, not a lock, so it does not serialize against an erasure commit —
 *      it is adjacent to the dispatch (no awaited work sits between the check
 *      resolving and `gateway.complete` being called), but "adjacent" is a
 *      source-code property, not a wall-clock guarantee. Under ordinary
 *      execution the gap is negligible; under adversarial scheduling (a
 *      process pause, a GC stall, an event-loop delay between the check
 *      resolving and the call actually dispatching) it is not provably zero.
 *      The honest residual is PER PASS, not account-wide: the claim
 *      (claimSessionTriage, packages/db) is a fence, not an exclusive lease,
 *      so several of this account's runs can be claimed and mid-pass at
 *      once — ONE RACING DISPATCH PER CONCURRENTLY-EXECUTING CLOSER PASS,
 *      bounded by worker concurrency (one job at a time per replica today,
 *      apps/worker/src/queues.ts takes BullMQ's `Worker` default) times
 *      however many replicas are running, never a single request account-wide
 *      no matter how many passes race the same commit. Each one that does
 *      dispatch is still individually capped: on the wire for up to the
 *      gateway's timeout before it completes — not an absolute
 *      "residual ≤ timeout" bound. Closing the gap fully would require
 *      holding a lock (the account-lifecycle lock, or an equivalent) across
 *      every in-flight pass's network call — the design memo's option 2,
 *      which the owner rejected because it couples erasure latency to the
 *      gateway's and inverts the repo's no-lock-across-network-call rule.
 *   4. GENERATE. One call. The excerpt and topics go in as delimited data.
 *   5. RESOLVE. Per candidate, a LIVE re-read then a resolve. Skips are counted,
 *      not fatal.
 *   6. FINISH. Re-list events — the resolves in step 5 emitted provenance events
 *      of their own, and a watermark taken BEFORE them would leave those ids
 *      untriaged, re-arming this very run on the next pass. Then stamp
 *      `completed` + the cumulative watermark + clear the excerpt, all under the
 *      epoch AND attempt fence. A resurrection mid-pass makes this write-back
 *      fail, and the pass reports `fenced` having landed only reversible resolves.
 *
 * IDEMPOTENCE UNDER RETRY. BullMQ retries re-enter at step 1. The claim is a
 * fresh CAS from whatever attempt id it observes, so a retry either re-claims or
 * cleanly loses. It cannot duplicate corpus rows: step 5's only verb is
 * `resolve`, and a live re-read of an already-resolved commitment returns
 * `already-resolved` and writes nothing.
 *
 * CONVERGENCE. A skip whose cause is PERMANENT still settles the row (see
 * {@link settleWithoutWork} below). Otherwise the sweep re-selects it forever,
 * and a bounded batch of such runs starves every later one.
 */
export async function closeSessionRun(
  repo: SessionCloserRepo,
  userId: string,
  request: { sessionRunId: string; activationEpoch: number },
  options: CloserOptions,
): Promise<CloserResult> {
  const empty = { candidates: 0, rejected: 0, resolved: 0, skippedCandidates: 0 }
  const skip = (reason: CloserSkipReason): CloserResult => ({
    sessionRunId: request.sessionRunId,
    skipped: reason,
    ...empty,
  })

  const session = await repo.readSession(userId, request.sessionRunId)
  if (session === undefined) return skip('not-found')
  if (session.activationEpoch !== request.activationEpoch) return skip('fenced')
  if (session.closedAt === null) return skip('not-closed')

  try {
    return await runClosePass(repo, userId, request, options, session, skip)
  } catch (err) {
    // THE BACKOFF STAMP (issue #184). Everything `runClosePass` can throw past
    // this point is a genuine FAILURE — never one of the `skip(...)` returns
    // above or inside it, which either settle the row permanently
    // (`settleWithoutWork`) or stay eligible on purpose (no-gateway,
    // claim-lost, fenced). A row that keeps throwing must stop re-occupying
    // the `ORDER BY closed_at LIMIT` batch window on every sweep tick — see
    // `closerBackoffDelayMs` (packages/db/src/session-closer.ts) for the
    // growth curve and cap.
    //
    // ONLY ON THE LAST ATTEMPT (issue #184 audit F3). Without this gate, one
    // enqueued job that fails all of `CLOSER_JOB_OPTS`' 3 tries stamps the row
    // THREE times inside ~90 seconds — the second stamp already pushes past
    // the "one tick" the doc/changeset describe, and the third can reach the
    // 4-hour cap before the next sweep tick even runs, for what may have been
    // a sub-two-minute blip. `isLastAttempt` is what makes one JOB cost at
    // most one row-level failure, matching the growth curve to the prose that
    // describes it. BullMQ's own retry (unaffected — `throw err` below still
    // always runs) is what covers attempts 1 and 2.
    if (options.isLastAttempt) {
      // NO COUNT, NO COMPUTED DELAY (Codex review of PR #196, comment
      // 3843607494). `repo.recordFailure`'s db-layer implementation derives
      // both from the row's value AT WRITE TIME, atomically — never from
      // `session.closerFailureCount`, which was read at the START of this
      // pass and can go stale under a concurrent `completeSessionTriage`
      // reset (no epoch bump) between then and now. See
      // `CloserFailureInput`'s own doc for the full argument.
      //
      // Best-effort: `recordFailure`'s own epoch fence already makes a
      // resurrection a safe no-op, and a failure to WRITE the backoff must
      // never mask the real error — the job still fails and BullMQ still
      // retries either way. `onRecordFailureError` is the only way this
      // secondary failure becomes OBSERVABLE at all: core reads/writes no
      // logger of its own (hard rule 5), so a silent catch here would lose
      // the signal for good rather than merely defer it to the caller.
      await repo
        .recordFailure(userId, {
          sessionRunId: request.sessionRunId,
          activationEpoch: session.activationEpoch,
          now: options.now,
        })
        .catch((recordErr: unknown) => {
          // The hook itself is best-effort too: if it throws, that rejection
          // would otherwise escape this catch and REPLACE `err` below — the
          // exact masking this whole block exists to prevent, just one layer
          // deeper. Swallowing here is what keeps the promise real rather than
          // aspirational.
          try {
            options.onRecordFailureError?.(recordErr)
          } catch {
            // Nothing further to do with a failure to report a failure.
          }
        })
    }
    throw err
  }
}

/**
 * The body of one closer pass, once the run is confirmed closed at the
 * expected epoch. Split out so {@link closeSessionRun} can wrap it in the
 * try/catch that stamps a backoff on failure — see the module doc above for
 * the step-by-step shape this still follows unchanged.
 */
async function runClosePass(
  repo: SessionCloserRepo,
  userId: string,
  request: { sessionRunId: string; activationEpoch: number },
  options: CloserOptions,
  session: CloserSessionInput,
  skip: (reason: CloserSkipReason) => CloserResult,
): Promise<CloserResult> {
  /**
   * Stamp a terminal status on a run the closer will do NO work on, so it stops
   * being selected. Claim first — `finish` is fenced on the attempt token — and
   * treat a lost claim as fine: whoever holds it will settle the run.
   *
   * WHY A NO-WORK RUN MUST STILL BE STAMPED. `listCloserCandidates` selects
   * closed rows whose `triage_status` is `idle`/`pending`/`expired`, oldest
   * `closed_at` first, bounded per pass. A run that is skipped WITHOUT a
   * write-back keeps that status forever, so it is re-selected and re-enqueued
   * on every later sweep. Once enough of them accumulate they fill the batch
   * ahead of every newer run — sorted earlier by `closed_at` — and the closer
   * silently stops resolving anything for that tenant, with no error and no
   * metric that distinguishes it from a healthy pass. Only skips whose cause is
   * TRANSIENT (an unconfigured gateway, a lost claim, a resurrection) may return
   * without stamping; a permanent one must settle the row.
   *
   * The excerpt is deliberately NOT cleared: no closer ever consumed it, so it
   * is a TTL-sweep leftover rather than a durable consumption.
   */
  const settleWithoutWork = async (
    triageStatus: 'completed' | 'overflowed',
    eventIds: string[],
  ): Promise<void> => {
    const attemptId = options.newAttemptId()
    const claimed = await repo.claim(userId, {
      sessionRunId: request.sessionRunId,
      activationEpoch: session.activationEpoch,
      observedAttemptId: session.triageAttemptId,
      attemptId,
    })
    if (!claimed) return
    await repo.finish(userId, {
      sessionRunId: request.sessionRunId,
      activationEpoch: session.activationEpoch,
      attemptId,
      triageStatus,
      visibleEventIds: eventIds.slice(0, MAX_SESSION_EVENT_IDS),
      clearExcerpt: false,
    })
  }

  const events = await repo.listEvents(userId, request.sessionRunId)
  const visibleEventIds = events.items.map((event) => event.id)
  if (events.truncated) {
    // Terminal by contract: the closer must not re-claim and re-spend an LLM
    // pass on a run past the per-run ceiling. Stamp it, emit the metric, stop.
    await settleWithoutWork('overflowed', visibleEventIds)
    return skip('overflowed')
  }

  if (!isCloserEligible(session.triageStatus, visibleEventIds, session.lastTriagedEventIds)) {
    return skip('not-eligible')
  }
  if (session.briefedMemories.length === 0) {
    // PERMANENT, not transient. `briefed_memories` is a SessionStart stamp and
    // nothing rewrites it on a closed run, so this run will never have an id the
    // closer could legally resolve. It is a common shape — any session that
    // opened with no open or overdue commitments — so leaving it eligible is
    // exactly how the batch fills with runs that can never produce work.
    await settleWithoutWork('completed', visibleEventIds)
    return skip('nothing-briefed')
  }
  // TRANSIENT: configuration, not this run. Deliberately left eligible so the
  // pass runs for real once a gateway is configured.
  if (options.gateway === undefined) return skip('no-gateway')

  const attemptId = options.newAttemptId()
  const claimed = await repo.claim(userId, {
    sessionRunId: request.sessionRunId,
    activationEpoch: session.activationEpoch,
    observedAttemptId: session.triageAttemptId,
    attemptId,
  })
  if (!claimed) return skip('claim-lost')

  const eventKinds = [...new Set(events.items.map((event) => event.eventKind))].sort()
  const verdict = await classify({
    repo,
    userId,
    request,
    gateway: options.gateway,
    budget: options.budget,
    session,
    eventKinds,
  })
  if (verdict === 'fenced') return skip('fenced')
  const { candidates, rejected, proposals } = verdict

  const fence = {
    repo,
    userId,
    sessionRunId: request.sessionRunId,
    epoch: session.activationEpoch,
  }
  const { resolved, skippedCandidates, fenced } = await resolveCandidates(fence, candidates)
  const partial = {
    sessionRunId: request.sessionRunId,
    candidates: candidates.length,
    rejected,
    resolved,
    skippedCandidates,
  }
  if (fenced) return { ...partial, skipped: 'fenced' }
  const proposed = await stageProposals(fence, proposals)
  if (proposed === 'fenced') return { ...partial, skipped: 'fenced' }

  // Re-list AFTER the resolves so the watermark covers the events they emitted.
  // Without this the closer's own `resolve` rows would sit outside
  // `last_triaged_event_ids` and re-arm the run it just closed.
  const finalEvents = resolved === 0 ? events : await repo.listEvents(userId, request.sessionRunId)
  const finished = await repo.finish(userId, {
    sessionRunId: request.sessionRunId,
    activationEpoch: session.activationEpoch,
    attemptId,
    triageStatus: finalEvents.truncated ? 'overflowed' : 'completed',
    visibleEventIds: finalEvents.items.map((event) => event.id).slice(0, MAX_SESSION_EVENT_IDS),
    clearExcerpt: !finalEvents.truncated,
  })

  return {
    sessionRunId: request.sessionRunId,
    ...(finished ? {} : { skipped: 'fenced' as const }),
    candidates: candidates.length,
    rejected,
    resolved,
    skippedCandidates,
    ...(proposed > 0 ? { proposed } : {}),
  }
}

/** The run a pass is fenced at: whose rows it writes and the epoch it observed. */
interface PassFence {
  repo: SessionCloserRepo
  userId: string
  sessionRunId: string
  epoch: number
}

/**
 * Step 5, RESOLVE: per candidate, an epoch pre-check, then a live re-read +
 * resolve. Skips are counted, not fatal; an epoch miss abandons the batch.
 */
async function resolveCandidates(
  fence: PassFence,
  candidates: readonly string[],
): Promise<{ resolved: number; skippedCandidates: number; fenced: boolean }> {
  let resolved = 0
  let skippedCandidates = 0
  for (const memoryId of candidates) {
    // EPOCH PRE-CHECK before each resolve. A cheap best-effort read in its OWN
    // transaction, separate from the write below — it narrows the window from
    // "the whole generation" to "one statement" so a resurrection during a
    // slow generation stops the batch at the next candidate rather than at the
    // end, but it does not by itself CLOSE that one-statement window: the
    // write in `repo.resolve` runs in a later, separate transaction of its
    // own. That residual is what `expectedEpoch` below actually closes (issue
    // #185) — this pre-check is the cheap early exit, the write-time guard is
    // the authoritative one.
    const epoch = await fence.repo.currentEpoch(fence.userId, fence.sessionRunId)
    if (epoch !== fence.epoch) return { resolved, skippedCandidates, fenced: true }
    // THE RESOLVE-PATH EPOCH FENCE (issue #185). `expectedEpoch` threads
    // through to `transitionCommitment`, which locks the commitment row THEN
    // re-reads `activation_epoch` on a fresh statement inside the same
    // transaction as the write, aborting instead of writing when it no longer
    // matches. Against ERASURE this CLOSES the gap between the read above and
    // the write, not just narrows it — erasure's own bulk commitments UPDATE
    // takes the same row lock, forcing the two transactions to serialize.
    // Against a plain RESURRECTION (a heartbeat or SessionStart resuming the
    // row) it only NARROWS the gap to one fresh statement: resurrection never
    // touches `commitments`, so nothing forces an ordering against it the way
    // erasure's lock does. Harmless either way — a resolve is reversible
    // (`unresolve`). A 'epoch-fenced' outcome means the write never happened,
    // so this pass is ABANDONED exactly like every other epoch-fence hit —
    // never counted as a per-candidate skip, and never retried.
    const outcome = await fence.repo.resolve(
      fence.userId,
      memoryId,
      fence.sessionRunId,
      fence.epoch,
    )
    if (outcome === 'epoch-fenced') return { resolved, skippedCandidates, fenced: true }
    if (outcome === 'resolved') resolved += 1
    else skippedCandidates += 1
  }
  return { resolved, skippedCandidates, fenced: false }
}

/**
 * The mid band (issue #229): stage proposals AFTER the resolves, behind the same
 * cheap epoch pre-check. A proposal carries ids and a probability only and is
 * advisory, so the narrowing check is enough; an erasure that races it leaves a
 * content-free review row over redacted memories. The db layer stages only
 * still-open commitments and never one this run already proposed.
 */
async function stageProposals(
  fence: PassFence,
  proposals: readonly { memoryId: string; probability: number }[],
): Promise<number | 'fenced'> {
  if (proposals.length === 0) return 0
  const epoch = await fence.repo.currentEpoch(fence.userId, fence.sessionRunId)
  if (epoch !== fence.epoch) return 'fenced'
  return fence.repo.propose(fence.userId, fence.sessionRunId, proposals)
}

/**
 * The production {@link SessionCloserRepo}: @3ngram/db helpers wrapped in
 * withTenant() (hard rule 3). Each member opens its own transaction on purpose —
 * the pass spans an LLM round-trip, and holding one transaction across a network
 * call to a provider would pin a connection for the length of a generation.
 *
 * `resolve` goes through core's {@link resolveForClosedRun}, which does the live
 * re-read and the FSM check, and stamps the run id as PRE-RESOLVED provenance —
 * never through the attach path, which would resurrect the very row this pass is
 * closing. See the `stampedSessionRunId` doc in packages/db/src/commitments.ts.
 */
export const dbSessionCloserRepo: SessionCloserRepo = {
  readSession: (userId, sessionRunId) =>
    withTenant(userId, (tx) => readCloserSession(tx, userId, sessionRunId)),
  listEvents: async (userId, sessionRunId) => {
    // Page to the per-run ceiling. `truncated` on ANY page is terminal, so it is
    // carried out of the loop rather than only read from the last page.
    const items: CloserEventSummary[] = []
    let cursor: string | undefined
    let truncated = false
    for (;;) {
      const page = await withTenant(userId, (tx) =>
        listSessionEvents(tx, userId, sessionRunId, {
          ...(cursor === undefined ? {} : { cursor }),
          limit: CLOSER_EVENTS_PAGE_SIZE,
          ceiling: MAX_SESSION_EVENT_IDS,
        }),
      )
      for (const event of page.items) items.push({ id: event.id, eventKind: event.eventKind })
      if (page.truncated) truncated = true
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }
    return { items, truncated }
  },
  claim: (userId, claim) => withTenant(userId, (tx) => claimSessionTriage(tx, userId, claim)),
  resolve: (userId, memoryId, sessionRunId, expectedEpoch) =>
    resolveForClosedRun(userId, memoryId, CLOSER_ACTOR_KIND, sessionRunId, expectedEpoch),
  finish: (userId, finish) => withTenant(userId, (tx) => finishSessionTriage(tx, userId, finish)),
  recordUsage: (userId, usage) =>
    insertLlmUsage(userId, {
      operation: usage.operation,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    }),
  currentEpoch: async (userId, sessionRunId) => {
    const row = await withTenant(userId, (tx) => readCloserSession(tx, userId, sessionRunId))
    return row?.activationEpoch
  },
  recordFailure: (userId, failure) =>
    withTenant(userId, (tx) => recordCloserFailure(tx, userId, failure)),
  isJudgmentEnabled: (userId) => isJudgmentEnabled(userId),
  propose: (userId, sessionRunId, proposals) =>
    withTenant(userId, (tx) => insertResolutionProposals(tx, userId, sessionRunId, proposals)),
}
