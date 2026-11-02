// SPDX-License-Identifier: Apache-2.0
// Forgetting pass across tenants (docs/concepts/forgetting-pass.mdx, "Flag and
// schedule"): the body of the daily worker job. It walks every tenant and runs
// one forgetting pass each. A tenant without the judgment opt-in is skipped by
// the pass's own pre-check, which reads nothing else. That keeps the loop on the
// same tenant enumeration consolidation uses, with no cross-tenant read of the
// FORCE-RLS policy table.
//
// One tenant's failure does not stop the others: it is counted by error name,
// and the caller decides what a non-zero count means (the worker fails the job, so BullMQ
// retries and the one-shot exits 1). A missing judgment gateway is
// deployment-wide, so the first `no-gateway` ends the loop.
//
// Observability (hard rule 6): counts only.
import { listTenantIds } from '@3ngram/db'
import type { Gateway } from '@3ngram/llm'
import type { BudgetEnforcement } from '../budget/index.js'
import { type ForgettingStop, runForgettingPass } from './forgetting-pass.js'

/** Counts only: what one sweep over the tenants did. */
export interface ForgettingSweepResult {
  tenants: number
  /** Tenants whose pass judged at least one batch. */
  judged: number
  /** Tenants whose pass stopped, by reason. */
  stopped: Record<ForgettingStop, number>
  proposed: number
  dismissed: number
  skipped: number
  staged: number
  /** Tenants whose pass threw. */
  failed: number
  /** Those failures by error name: the cause without its message (hard rule 6). */
  failedBy: Record<string, number>
}

export interface ForgettingSweepOptions {
  gateway: Gateway
  budget?: BudgetEnforcement | undefined
  now?: Date | undefined
  /** Injected for tests; defaults to the shared tenant enumeration. */
  listTenantIds?: (() => Promise<string[]>) | undefined
  /** Injected for tests; defaults to {@link runForgettingPass}. */
  runPass?: typeof runForgettingPass | undefined
}

/** Run the forgetting pass for every tenant. */
export async function forgetAllTenants(
  options: ForgettingSweepOptions,
): Promise<ForgettingSweepResult> {
  const tenants = await (options.listTenantIds ?? listTenantIds)()
  const runPass = options.runPass ?? runForgettingPass
  const result: ForgettingSweepResult = {
    tenants: tenants.length,
    judged: 0,
    stopped: { 'not-opted-in': 0, 'opted-out': 0, 'no-gateway': 0, budget: 0 },
    proposed: 0,
    dismissed: 0,
    skipped: 0,
    staged: 0,
    failed: 0,
    failedBy: {},
  }
  for (const userId of tenants) {
    let pass: Awaited<ReturnType<typeof runForgettingPass>>
    try {
      pass = await runPass(userId, {
        gateway: options.gateway,
        budget: options.budget,
        now: options.now,
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown'
      result.failed += 1
      result.failedBy[name] = (result.failedBy[name] ?? 0) + 1
      continue
    }
    if (pass.batches > 0) result.judged += 1
    result.proposed += pass.proposed
    result.dismissed += pass.dismissed
    result.skipped += pass.skipped
    result.staged += pass.staged
    if (pass.stopped !== undefined) {
      result.stopped[pass.stopped] += 1
      if (pass.stopped === 'no-gateway') break
    }
  }
  return result
}
