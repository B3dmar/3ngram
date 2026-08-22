// SPDX-License-Identifier: Apache-2.0
// Resolve native write-time session provenance (docs/concepts/session-continuity.mdx).
// SQL ONLY: core validates the optional sessionRunId at the schema boundary and
// hands it here inside withTenant. Import never calls this.
import { SESSION_LEASE_MS, type SessionProvenancePayload } from '@3ngram/schema'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { lockSessionAttach, type TenantTx } from './client.js'
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

async function heartbeat(tx: TenantTx, userId: string, id: string, now: Date): Promise<void> {
  await tx
    .update(agentSessions)
    .set({ lastSeenAt: now })
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.id, id)))
}

async function resurrect(tx: TenantTx, userId: string, id: string, now: Date): Promise<void> {
  await tx
    .update(agentSessions)
    .set({
      closedAt: null,
      lastSeenAt: now,
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

  // Stale lease. Resurrecting changes the open-session set; serialize with
  // omitted-id attach.
  await lockSessionAttach(tx, userId, row.project)

  // RE-READ under the lock. The read above was taken BEFORE the lock, so two
  // concurrent writes carrying the SAME stale run id both saw it stale; the lock
  // only serializes them. Resurrecting on both would bump activation_epoch TWICE
  // for ONE resurrection, invalidating claims that a closer fenced at the first
  // epoch. The loser must therefore re-decide on committed state (READ COMMITTED
  // gives each statement a fresh snapshot, and the winner's xact-scoped advisory
  // lock is only released at its commit) and heartbeat the already-open row
  // instead. The explicit-close guard is re-checked too: the row may have been
  // closed by a SessionEnd that committed while we waited.
  const fresh = await readSession(tx, userId, sessionRunId)
  if (fresh === undefined) throw new UnknownSessionRunError(sessionRunId)
  if (isExplicitClose(fresh.closedAt, fresh.lastSeenAt)) return undefined
  if (isLeased(fresh.lastSeenAt, now)) {
    await heartbeat(tx, userId, fresh.id, now)
    return fresh.id
  }
  await resurrect(tx, userId, fresh.id, now)
  return fresh.id
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
