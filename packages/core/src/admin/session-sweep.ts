// SPDX-License-Identifier: Apache-2.0
// Lease-expiry sweep policy (docs/concepts/session-continuity.mdx, "Lease").
//
// This is the BUSINESS LOGIC the apps/worker BullMQ harness invokes on a
// repeatable schedule; the harness only schedules/invokes/shuts down (hard rule
// 5). Its job is to be the PRODUCER the crash path otherwise lacks: lease-at-read
// resurrects a row when something touches it, but a killed terminal touches
// nothing, so without a sweeper that session never reaches the closer at all.
//
// CROSS-TENANT, WITHOUT A PRIVILEGED HANDLE. `agent_sessions` is user-owned with
// RLS + FORCE, so an admin-handle scan would return zero rows by design. The
// sanctioned pattern — the one consolidate() and surface() already use — is the
// single pre-tenant read `listTenantIds()` (the RLS-less `users` system table)
// followed by a per-tenant fan-out where every statement runs inside
// `withTenant()`. This module copies that shape exactly and adds no new
// privilege path.
//
// Observability (hard rule 6): tenant/row COUNTS only. No session id, no
// project, and above all never the excerpt.
import {
  type CloserCandidate,
  expireStaleExcerpts,
  listCloserCandidates,
  listTenantIds,
  sweepExpiredLeases,
  withTenant,
} from '@3ngram/db'
import { MAX_SESSION_SWEEP_BATCH, SESSION_EXCERPT_TTL_MS } from '@3ngram/schema'

/** Where a swept run should be sent for triage. Content-free by construction. */
export interface CloserEnqueueRequest {
  userId: string
  sessionRunId: string
  /** The epoch observed at sweep time. The closer claims at it and no-ops if it moved. */
  activationEpoch: number
}

/**
 * The data + dispatch seam the sweep needs, injectable so the policy is
 * unit-tested against fakes with NO database and NO Redis (the worker test stubs
 * both). The default implementation ({@link dbSessionSweepRepo}) wraps the
 * @3ngram/db helpers in withTenant(); the worker supplies `enqueueCloser`.
 */
export interface SessionSweepRepo {
  /** Every tenant's user id (the per-tenant fan-out seed). */
  listTenantIds(): Promise<string[]>
  /** Stamp implicit `closed_at` on this tenant's lease-expired rows; return them. */
  sweepExpiredLeases(userId: string, now: Date, limit: number): Promise<CloserCandidate[]>
  /** Closed rows of this tenant whose triage never ran. */
  listCloserCandidates(userId: string, limit: number): Promise<CloserCandidate[]>
  /** Clear excerpts on rows the closer will never process (the TTL leftovers). */
  expireStaleExcerpts(userId: string, before: Date, limit: number): Promise<number>
  /** Hand one run to the closer queue. Idempotent by the job id the harness derives. */
  enqueueCloser(request: CloserEnqueueRequest): Promise<void>
}

/** Tunables for one sweep pass. */
export interface SessionSweepOptions {
  /** Rows closed and rows enqueued per tenant per pass. Defaults to the schema bound. */
  limitPerTenant?: number
}

/** Per-run outcome, content-free — safe to log. */
export interface SessionSweepResult {
  tenantsScanned: number
  /** Rows this pass stamped with an implicit `closed_at`. */
  implicitlyClosed: number
  /** Closer jobs enqueued (swept rows plus already-closed, untriaged rows). */
  enqueued: number
  /** Excerpts cleared by the TTL leg. */
  excerptsExpired: number
}

/**
 * Run one lease-expiry sweep across all tenants. Per tenant, in order:
 *
 *   1. CLOSE. Stamp `closed_at` on rows quiet for lease + grace. The stamp lands
 *      strictly outside the `closed_at <= last_seen_at + lease` window, so the
 *      row classifies as an IMPLICIT close and stays resurrectable — see the
 *      invariant in packages/db/src/session-closer.ts.
 *   2. ENQUEUE. Hand every closed-and-untriaged row to the closer. This covers
 *      both producers the page names in one query: the rows step 1 just closed,
 *      and rows an explicit SessionEnd closed whose triage never ran. Step 1's
 *      own output is not enqueued separately — it is a subset of step 2's, and
 *      enqueueing it twice would double the LLM spend for one run.
 *   3. TTL. Clear excerpts left on rows the closer will never process.
 *
 * A per-tenant failure is NOT swallowed: it propagates so BullMQ marks the job
 * failed and retries, rather than reporting a falsely-green pass. Every step is
 * idempotent under that retry — a re-close is guarded by `closed_at IS NULL`,
 * and a re-enqueue collapses on the harness's deterministic job id.
 */
export async function sweepSessions(
  repo: SessionSweepRepo,
  now: Date,
  options: SessionSweepOptions = {},
): Promise<SessionSweepResult> {
  const limitPerTenant = options.limitPerTenant ?? MAX_SESSION_SWEEP_BATCH
  const excerptFloor = new Date(now.getTime() - SESSION_EXCERPT_TTL_MS)
  const tenants = await repo.listTenantIds()
  let implicitlyClosed = 0
  let enqueued = 0
  let excerptsExpired = 0
  for (const userId of tenants) {
    const closed = await repo.sweepExpiredLeases(userId, now, limitPerTenant)
    implicitlyClosed += closed.length

    const candidates = await repo.listCloserCandidates(userId, limitPerTenant)
    for (const candidate of candidates) {
      await repo.enqueueCloser({
        userId,
        sessionRunId: candidate.sessionRunId,
        activationEpoch: candidate.activationEpoch,
      })
      enqueued += 1
    }

    excerptsExpired += await repo.expireStaleExcerpts(userId, excerptFloor, limitPerTenant)
  }
  return { tenantsScanned: tenants.length, implicitlyClosed, enqueued, excerptsExpired }
}

/**
 * Build the production {@link SessionSweepRepo}: the @3ngram/db helpers wrapped
 * in withTenant() (hard rule 3 — RLS scopes every per-tenant read/write). Tenant
 * enumeration is the one pre-tenant read (listTenantIds, system table).
 *
 * `enqueueCloser` is injected rather than defaulted because core must not know
 * BullMQ exists; the worker passes a closure over its queue handle.
 */
export function dbSessionSweepRepo(
  enqueueCloser: (request: CloserEnqueueRequest) => Promise<void>,
): SessionSweepRepo {
  return {
    listTenantIds,
    sweepExpiredLeases: (userId, now, limit) =>
      withTenant(userId, (tx) => sweepExpiredLeases(tx, userId, now, limit)),
    listCloserCandidates: (userId, limit) =>
      withTenant(userId, (tx) => listCloserCandidates(tx, userId, limit)),
    expireStaleExcerpts: (userId, before, limit) =>
      withTenant(userId, (tx) => expireStaleExcerpts(tx, userId, before, limit)),
    enqueueCloser,
  }
}
