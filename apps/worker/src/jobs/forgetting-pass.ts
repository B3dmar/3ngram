// SPDX-License-Identifier: Apache-2.0
// Forgetting-pass job. The HARNESS side: the function both worker modes run
// once a day. ZERO business logic (hard rule 5): it calls @3ngram/core's
// forgetAllTenants with the gateway and budget the worker resolved at boot,
// logs the content-free counts (hard rule 6), and fails the job when a tenant's
// pass threw, so BullMQ retries and the one-shot exits 1.
import { log } from '@3ngram/config'
import { type BudgetEnforcement, type ForgettingSweepResult, forgetAllTenants } from '@3ngram/core'
import type { Gateway } from '@3ngram/llm'

/** The repeatable BullMQ job name, and the one-shot job name. */
export const FORGETTING_PASS_JOB = 'forgetting-pass'

/** Some tenants' passes threw; the rest ran and staged what they judged. */
export class ForgettingPassFailedError extends Error {
  override name = 'ForgettingPassFailedError'
  constructor(readonly failed: number) {
    super(`${failed} tenant forgetting pass(es) failed`)
  }
}

/**
 * Run the daily pass over every tenant. With no gateway configured (a
 * self-host without LLM settings) it is a logged no-op, like the closer's
 * `no-gateway`, rather than a failure.
 */
export async function runForgettingPassJob(
  gateway: Gateway | undefined,
  budget: BudgetEnforcement,
): Promise<ForgettingSweepResult | { skipped: 'no-gateway' }> {
  if (gateway === undefined) {
    log().info({ skipped: 'no-gateway' }, 'worker: forgetting pass has no gateway')
    return { skipped: 'no-gateway' }
  }
  const result = await forgetAllTenants({ gateway, budget })
  log().info(
    {
      tenants: result.tenants,
      judged: result.judged,
      proposed: result.proposed,
      dismissed: result.dismissed,
      skipped: result.skipped,
      staged: result.staged,
      failed: result.failed,
      failedBy: result.failedBy,
      notOptedIn: result.stopped['not-opted-in'],
      noGateway: result.stopped['no-gateway'],
      budget: result.stopped.budget,
    },
    'worker: forgetting pass complete',
  )
  if (result.stopped['no-gateway'] > 0) {
    // Deployment-wide: JEV_API_KEY and JEV_MODEL are not set, so no tenant can be judged.
    log().warn({}, 'worker: forgetting pass found no judgment gateway')
  }
  if (result.failed > 0) throw new ForgettingPassFailedError(result.failed)
  return result
}
