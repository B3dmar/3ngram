// SPDX-License-Identifier: Apache-2.0
// Consolidation job. The BullMQ HARNESS side: this
// is the function the Worker runs per scheduled tick. It contains ZERO business
// logic (hard rule 5) — it invokes @3ngram/core's consolidate() with the
// production db-backed repo and logs the content-free result counts (hard rule
// 6). All scanning/similarity/policy lives in packages/core/src/admin.
import { log } from '@3ngram/config'
import { type ConsolidateResult, consolidate, dbConsolidateRepo } from '@3ngram/core'

/** The repeatable BullMQ job name for the consolidation pass. */
export const CONSOLIDATION_JOB = 'consolidation'

/**
 * Run one consolidation pass (all tenants). Advisory-only: INSERTs proposal
 * suggestion rows, NEVER mutates memories (docs/concepts/memory-model.mdx "Consolidation is advisory"). Returns the run counts
 * so BullMQ records them on the completed job; throws on failure so BullMQ marks
 * the job failed and retries per JOB_RETRY_OPTS (stamped on the scheduler
 * template in src/queues.ts).
 */
export async function runConsolidation(): Promise<ConsolidateResult> {
  const result = await consolidate(dbConsolidateRepo)
  log().info(
    {
      tenants: result.tenantsScanned,
      pairs: result.pairsConsidered,
      proposals: result.proposalsInserted,
    },
    'worker: consolidation pass complete',
  )
  return result
}
