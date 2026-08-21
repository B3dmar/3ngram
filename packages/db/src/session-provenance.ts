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

function projectPredicate(project: string | null | undefined) {
  return project == null ? isNull(agentSessions.project) : eq(agentSessions.project, project)
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
  const [row] = await tx
    .select({
      id: agentSessions.id,
      closedAt: agentSessions.closedAt,
      lastSeenAt: agentSessions.lastSeenAt,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.id, sessionRunId)))
    .limit(1)
  if (row === undefined) throw new UnknownSessionRunError(sessionRunId)
  const leased = row.lastSeenAt.getTime() > leaseFloor(now).getTime()
  // Explicit SessionEnd: closed while the lease was still live. Do not resurrect.
  if (row.closedAt !== null && leased) return undefined
  if (!leased) {
    await resurrect(tx, userId, row.id, now)
  }
  return row.id
}

async function attachSingleOpen(
  tx: TenantTx,
  userId: string,
  project: string | null | undefined,
  now: Date,
): Promise<string | undefined> {
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
  return open.length === 1 ? open[0]?.id : undefined
}

/**
 * Resolve the sessionRunId to stamp on this write's audit events, or undefined
 * to leave payload unset. Caller-supplied ids that are not this tenant's fail
 * the write. An explicitly closed row of this tenant succeeds unattributed. A
 * stale-lease row resurrects then attaches. Omitted id uses the single-open
 * default (exactly one leased-open row for the memory's project).
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
