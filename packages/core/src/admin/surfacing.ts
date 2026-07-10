// SPDX-License-Identifier: Apache-2.0
// Background surfacing/overdue policy. The BUSINESS
// LOGIC the apps/worker BullMQ harness invokes (hard rule 5: the harness only
// schedules/invokes/shuts down).
//
// A periodic, ADVISORY sweep over commitments that keeps the briefing's
// overdue/stale sections honest: open|waiting commitments past their due_at are
// expired, and commitments whose next_surfacing_at has passed are surfaced
// (their one-shot surfacing instant cleared). NEVER mutates the memory a
// commitment rides (a commitment legitimately UPDATEs its OWN status column —
// the FSM; the riding memory is untouched, append-and-supersede preserved).
//
// INJECTED TIME (no datetime.now() in business logic): the caller passes `now`
// (the worker passes new Date() at the top of the job, tests pass a fixed
// instant), so the sweep is deterministic and unit-testable.
//
// Observability (hard rule 6): ids/counts only — never memory content.
import { listTenantIds, type SurfacingSweepResult, sweepCommitments, withTenant } from '@3ngram/db'

/**
 * The data seam the surfacing job needs, injectable so the policy is unit-tested
 * against a fake repo with NO database (the worker test stubs this). The default
 * implementation ({@link dbSurfacingRepo}) wraps the @3ngram/db helpers in
 * withTenant().
 */
export interface SurfacingRepo {
  /** Every tenant's user id (the per-tenant fan-out seed). */
  listTenantIds(): Promise<string[]>
  /** Run the advisory overdue/surfacing sweep for one tenant at `now`. */
  sweepCommitments(userId: string, now: Date): Promise<SurfacingSweepResult>
}

/** Per-run outcome across all tenants, content-free — safe to log. */
export interface SurfacingResult {
  tenantsScanned: number
  expired: number
  surfaced: number
}

/**
 * Run one surfacing/overdue pass across all tenants. For each
 * tenant, run the advisory sweep at the injected `now`; aggregate the
 * content-free counts. NEVER mutates memories.
 *
 * A per-tenant failure propagates (the BullMQ job is marked failed and retried
 * by the harness) rather than reporting a falsely-green run.
 */
export async function surface(repo: SurfacingRepo, now: Date): Promise<SurfacingResult> {
  const tenants = await repo.listTenantIds()
  let expired = 0
  let surfaced = 0
  for (const userId of tenants) {
    const result = await repo.sweepCommitments(userId, now)
    expired += result.expired
    surfaced += result.surfaced
  }
  return { tenantsScanned: tenants.length, expired, surfaced }
}

/**
 * The production {@link SurfacingRepo}: the @3ngram/db helpers wrapped in
 * withTenant() (hard rule 3). Tenant enumeration is the one pre-tenant read.
 */
export const dbSurfacingRepo: SurfacingRepo = {
  listTenantIds,
  sweepCommitments: (userId, now) => withTenant(userId, (tx) => sweepCommitments(tx, userId, now)),
}
