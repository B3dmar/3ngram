// SPDX-License-Identifier: Apache-2.0
// Resolve native write-time session provenance (docs/concepts/session-continuity.mdx).
// SQL ONLY: core validates the optional sessionRunId at the schema boundary and
// hands it here inside withTenant. Import never calls this. The one exception to
// "caller owns the tx" is assertSessionRunOwned, which core's idempotent no-op
// path calls without a transaction of its own.
import { SESSION_LEASE_MS, type SessionProvenancePayload } from '@3ngram/schema'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { lockSessionAttach, type TenantTx, withTenant } from './client.js'
import { agentSessions } from './schema/agent-sessions.js'

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

function leaseFloor(now: Date): Date {
  return new Date(now.getTime() - SESSION_LEASE_MS)
}

/** Explicit SessionEnd: closed while the lease was still live. Durable — lastSeenAt freezes at close. */
function isExplicitClose(closedAt: Date | null, lastSeenAt: Date): boolean {
  return closedAt !== null && closedAt.getTime() <= lastSeenAt.getTime() + SESSION_LEASE_MS
}

function projectPredicate(project: string | null | undefined) {
  return project == null ? isNull(agentSessions.project) : eq(agentSessions.project, project)
}

/** Lease still live at `now` (a stale lease is the resurrect trigger). */
function isLeased(lastSeenAt: Date, now: Date): boolean {
  return lastSeenAt.getTime() > leaseFloor(now).getTime()
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

async function readSession(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
): Promise<SessionRow | undefined> {
  const [row] = await tx
    .select({
      id: agentSessions.id,
      project: agentSessions.project,
      closedAt: agentSessions.closedAt,
      lastSeenAt: agentSessions.lastSeenAt,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.id, sessionRunId)))
    .limit(1)
  return row
}

/**
 * MONOTONIC lease refresh: never move `last_seen_at` backwards.
 *
 * `now` is captured in the caller's process before the statement runs, so a
 * slow attacher can reach its UPDATE after a later attacher already committed a
 * NEWER heartbeat. A bare `SET last_seen_at = now` would then overwrite the
 * fresher timestamp with the older captured one, SHORTENING the lease — enough
 * for the next write to read the run as stale and resurrect it for no reason.
 * GREATEST makes a successful heartbeat a floor, never a rollback. The
 * `::timestamptz` cast is the repo's convention for an interpolated timestamp
 * param (search.ts, search-list.ts) — without it the param arrives untyped.
 */
function monotonicLastSeen(now: Date) {
  return sql`GREATEST(${agentSessions.lastSeenAt}, ${now.toISOString()}::timestamptz)`
}

async function heartbeat(tx: TenantTx, userId: string, id: string, now: Date): Promise<void> {
  await tx
    .update(agentSessions)
    .set({ lastSeenAt: monotonicLastSeen(now) })
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
  // keyed by the row's CURRENT project. Two things force the loop below.
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

    const fresh = await readSession(tx, userId, sessionRunId)
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
  const open = await tx
    .select({ id: agentSessions.id })
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
  const id = open.length === 1 ? open[0]?.id : undefined
  if (id !== undefined) await heartbeat(tx, userId, id, now)
  return id
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
