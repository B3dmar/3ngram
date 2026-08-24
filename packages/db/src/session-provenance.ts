// SPDX-License-Identifier: Apache-2.0
// Resolve native write-time session provenance (docs/concepts/session-continuity.mdx).
// SQL ONLY: core validates the optional sessionRunId at the schema boundary and
// hands it here inside withTenant. Import never calls this. The one exception to
// "caller owns the tx" is assertSessionRunOwned, which core's idempotent no-op
// path calls without a transaction of its own.
import type { SessionProvenancePayload } from '@3ngram/schema'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { lockSessionAttach, type TenantTx, withTenant } from './client.js'
import { agentSessions } from './schema/agent-sessions.js'
import { isExplicitClose, isLeased, leaseFloor, monotonicLastSeen } from './session-lease.js'

/** A syntactically valid sessionRunId that is not a tenant-owned row. */
export class UnknownSessionRunError extends Error {
  readonly sessionRunId: string
  constructor(sessionRunId: string) {
    super('session run is not owned by this tenant')
    this.name = 'UnknownSessionRunError'
    this.sessionRunId = sessionRunId
  }
}

export function sessionPayload(
  sessionRunId: string | undefined,
): SessionProvenancePayload | undefined {
  return sessionRunId === undefined ? undefined : { sessionRunId }
}

function projectPredicate(project: string | null | undefined) {
  return project == null ? isNull(agentSessions.project) : eq(agentSessions.project, project)
}

/**
 * Attach-lock attempts before giving up unattributed. Erasure moves a row's
 * project at most once (to NULL), so one re-lock always suffices; the extra
 * headroom exists so an unforeseen mutation degrades instead of spinning.
 */
const MAX_ATTACH_LOCK_ATTEMPTS = 3

interface SessionRow {
  id: string
  project: string | null
  closedAt: Date | null
  lastSeenAt: Date
}

/**
 * Read one session row.
 *
 * `forUpdate` takes a ROW lock for the rest of the transaction. The advisory
 * attach lock alone serializes attachers against each other, but close
 * (`POST /api/v1/agent-sessions/close`) is a bare UPDATE of `closed_at` that
 * never takes it — so without the row lock a close can commit BETWEEN the
 * re-read under the advisory lock and the resurrect UPDATE that read decided on,
 * and the resurrect then silently reopens a session the tenant just closed
 * explicitly. `FOR UPDATE` makes that close queue behind the attaching
 * transaction instead, so the decision and the write it justifies see the same
 * row state.
 *
 * LOCK ORDER: only ever taken AFTER {@link lockSessionAttach} (advisory -> row,
 * the repo-wide order). The pre-lock read stays unlocked on purpose: the fast
 * path (leased-open row) must not serialize every concurrent write of a live
 * session behind one row lock.
 */
async function readSession(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
  opts?: { forUpdate?: boolean },
): Promise<SessionRow | undefined> {
  const query = tx
    .select({
      id: agentSessions.id,
      project: agentSessions.project,
      closedAt: agentSessions.closedAt,
      lastSeenAt: agentSessions.lastSeenAt,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.id, sessionRunId)))
    .limit(1)
  const [row] = opts?.forUpdate === true ? await query.for('update') : await query
  return row
}

/**
 * RE-ARM ON WRITE (docs/concepts/session-continuity.mdx, "Debounce"): *a later
 * provenance event of create / supersede / resolve / unresolve / archive whose
 * id is not in `last_triaged_event_ids` … atomically sets `triage_status` back
 * to `idle`*. `completed` is not terminal.
 *
 * NO SET RESCAN, AND NONE IS POSSIBLE TO NEED. The transaction this expression
 * rides in is INSERTing brand-new `memory_events` rows whose uuidv7 ids are
 * minted now, after the watermark was stamped — so those ids are BY DEFINITION
 * not in the stored set. Membership is already decided by construction;
 * re-reading the jsonb array to confirm it would spend a scan per write to learn
 * something the insert guarantees.
 *
 * FOLDED INTO THE UPDATE THE ATTACH ALREADY RUNS, so the flip is atomic with the
 * lease refresh: one statement, no extra lock, and under READ COMMITTED the CASE
 * is evaluated against the row version this UPDATE takes. The fast attach path
 * holds no row lock, which is exactly why this must be an expression rather than
 * a read-then-write.
 *
 * ONLY `completed` FLIPS.
 *   - `pending` is an attempt in flight, and the events this transaction is
 *     writing are precisely what its `triage/complete` will absorb. Flipping it
 *     would strand the attempt and lose the zero-write check.
 *   - `expired` is left alone ON PURPOSE. The nudge's entry rule
 *     (session-triage.ts) already re-admits an `expired` run on this same
 *     untriaged-event signal, so the observable behaviour matches the page —
 *     while leaving the status alone keeps the page's other rule intact, that a
 *     zero-write continuation must not re-inject on every later Stop. `expired`
 *     is unconditionally closer-eligible either way, so nothing is lost.
 *   - `overflowed` is terminal; `idle` is already armed.
 */
const rearmTriage = sql`CASE WHEN ${agentSessions.triageStatus} = 'completed' THEN 'idle' ELSE ${agentSessions.triageStatus} END`

async function heartbeat(tx: TenantTx, userId: string, id: string, now: Date): Promise<void> {
  await tx
    .update(agentSessions)
    .set({ lastSeenAt: monotonicLastSeen(now), triageStatus: rearmTriage })
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.id, id)))
}

/**
 * Reopen a stale-lease row and advance its activation epoch. Callers MUST hold
 * the attach lock keyed by the row's CURRENT project (see attachKnownRun) —
 * the epoch is a fence, so a double increment invalidates a closer's claim.
 * `lastSeenAt` uses the same monotonic floor as heartbeat: a resurrect that
 * loses a race to a newer heartbeat must not shorten the lease it just revived.
 */
async function resurrect(tx: TenantTx, userId: string, id: string, now: Date): Promise<void> {
  await tx
    .update(agentSessions)
    .set({
      closedAt: null,
      lastSeenAt: monotonicLastSeen(now),
      activationEpoch: sql`${agentSessions.activationEpoch} + 1`,
      // Same re-arm as heartbeat: this write attaches a new event id, and the
      // resurrect branch is still an attach. See {@link rearmTriage}.
      triageStatus: rearmTriage,
    })
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.id, id)))
}

async function attachKnownRun(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
  now: Date,
): Promise<string | undefined> {
  const row = await readSession(tx, userId, sessionRunId)
  if (row === undefined) throw new UnknownSessionRunError(sessionRunId)
  if (isExplicitClose(row.closedAt, row.lastSeenAt)) return undefined
  if (isLeased(row.lastSeenAt, now)) {
    await heartbeat(tx, userId, row.id, now)
    return row.id
  }

  // Stale lease. Resurrecting changes the open-session set, so it must be
  // serialized with omitted-id attach.
  //
  // INVARIANT: the resurrect/heartbeat decision is made under the attach lock
  // keyed by the row's CURRENT project, AND under a row lock on the row itself
  // (readSession's `forUpdate`) so a close committing mid-decision cannot make
  // the resurrect reopen an explicitly closed session. Two things force the loop
  // below.
  //
  // (1) RE-READ under the lock. The first read was taken BEFORE the lock, so two
  //     concurrent writes carrying the SAME stale run id both saw it stale; the
  //     lock only serializes them. Resurrecting on both would bump
  //     activation_epoch TWICE for ONE resurrection, invalidating claims a
  //     closer fenced at the first epoch. The loser re-decides on committed
  //     state (READ COMMITTED gives each statement a fresh snapshot, and the
  //     winner's xact-scoped advisory lock is only released at its commit) and
  //     heartbeats the already-open row instead. The explicit-close guard is
  //     re-checked too: a SessionEnd may have committed while we waited.
  //
  // (2) RE-LOCK when the project moved. The key comes from the observed row, and
  //     `agent_sessions.project` is mutable in exactly one place: account erasure
  //     redacts it to NULL (account-delete.ts). Two attachers straddling that
  //     commit would otherwise lock DIFFERENT keys, lose serialization entirely,
  //     and both resurrect. Locking the new key too restores it. No inversion is
  //     possible: erasure only ever goes project -> NULL and happens once, so
  //     every attacher that takes both keys takes them in the same old -> new
  //     order and NULL is terminal. That bounds the loop at one extra iteration;
  //     the cap is a fail-safe, and exhausting it returns unattributed rather
  //     than resurrecting on a key we do not hold.
  let observed = row
  for (let attempt = 0; attempt < MAX_ATTACH_LOCK_ATTEMPTS; attempt++) {
    const lockedProject = observed.project
    await lockSessionAttach(tx, userId, lockedProject)

    const fresh = await readSession(tx, userId, sessionRunId, { forUpdate: true })
    if (fresh === undefined) throw new UnknownSessionRunError(sessionRunId)
    if (isExplicitClose(fresh.closedAt, fresh.lastSeenAt)) return undefined
    if (isLeased(fresh.lastSeenAt, now)) {
      await heartbeat(tx, userId, fresh.id, now)
      return fresh.id
    }
    if (fresh.project !== lockedProject) {
      observed = fresh
      continue
    }
    await resurrect(tx, userId, fresh.id, now)
    return fresh.id
  }
  return undefined
}

async function attachSingleOpen(
  tx: TenantTx,
  userId: string,
  project: string | null | undefined,
  now: Date,
): Promise<string | undefined> {
  // Held until commit: zero/one/many is only valid at commit, and uniqueness is
  // not on project. Skipping the lock when a pre-count ≠ 1 races a concurrent
  // open or resurrect.
  await lockSessionAttach(tx, userId, project)
  // ROW-LOCKED, for the same reason attachKnownRun's re-read is: close is a bare
  // UPDATE of `closed_at` that never takes the advisory lock, so between this
  // SELECT and the heartbeat+attach below it could commit and this write would
  // attribute itself to — and refresh the lease of — a session the tenant just
  // ended. FOR UPDATE makes that close queue behind this transaction. Advisory
  // lock first, then the row lock: the repo-wide order, preserved.
  const open = await tx
    .select({
      id: agentSessions.id,
      closedAt: agentSessions.closedAt,
      lastSeenAt: agentSessions.lastSeenAt,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        isNull(agentSessions.closedAt),
        gt(agentSessions.lastSeenAt, leaseFloor(now)),
        projectPredicate(project),
      ),
    )
    .limit(2)
    .for('update')
  const candidate = open.length === 1 ? open[0] : undefined
  if (candidate === undefined) return undefined
  // Re-check on the LOCKED row. Postgres re-evaluates the qual against the new
  // version under READ COMMITTED, so a row closed in the gap is normally already
  // excluded — this is the explicit belt to that braces, and the one place the
  // decision is stated in code rather than inferred from the planner.
  if (candidate.closedAt !== null || !isLeased(candidate.lastSeenAt, now)) return undefined
  await heartbeat(tx, userId, candidate.id, now)
  return candidate.id
}

/**
 * Assert that `sessionRunId` names a row this tenant owns, and nothing else.
 *
 * The write paths get this validation for free: resolveSessionProvenance throws
 * {@link UnknownSessionRunError} on an unowned id before it stamps anything. An
 * IDEMPOTENT no-op has no write to hang it on — a resolve to the status the
 * commitment already holds returns early without reaching the DB — yet the
 * contract is that a run id this tenant does not own FAILS the request, whatever
 * else the request does. This is that check standing alone.
 *
 * Deliberately inert beyond the check: no attach, no heartbeat, no epoch change,
 * no audit event. A no-op resolve must not refresh a lease as a side effect of
 * being validated, or "resolve to the current status" would become a way to keep
 * a session alive. Opens its own withTenant so RLS scopes the lookup and callers
 * in core need no transaction of their own.
 *
 * @throws {@link UnknownSessionRunError} the id is not a row of this tenant.
 */
export async function assertSessionRunOwned(userId: string, sessionRunId: string): Promise<void> {
  await withTenant(userId, async (tx) => {
    if ((await readSession(tx, userId, sessionRunId)) === undefined) {
      throw new UnknownSessionRunError(sessionRunId)
    }
  })
}

/**
 * Resolve the sessionRunId to stamp on this write's audit events, or undefined
 * to leave payload unset. Caller-supplied ids that are not this tenant's fail
 * the write. An explicitly closed row of this tenant succeeds unattributed. A
 * stale-lease row resurrects then attaches — exactly once: concurrent writers
 * carrying the same stale id re-decide under the attach lock, so
 * activation_epoch advances one step per resurrection, never one per writer.
 * Omitted id uses the single-open default (exactly one leased-open row for the
 * memory's project).
 *
 * LOCK ORDER: this takes the tenant/project attach advisory lock, so callers
 * must call it BEFORE taking any memory row lock (see memory-revise.ts).
 */
export async function resolveSessionProvenance(
  tx: TenantTx,
  userId: string,
  opts: { sessionRunId?: string | undefined; project?: string | null | undefined; now: Date },
): Promise<string | undefined> {
  if (opts.sessionRunId !== undefined) {
    return attachKnownRun(tx, userId, opts.sessionRunId, opts.now)
  }
  return attachSingleOpen(tx, userId, opts.project, opts.now)
}
