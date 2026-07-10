// SPDX-License-Identifier: Apache-2.0
// OAuth client GC job (30-day idle policy). The BullMQ HARNESS side:
// this is the function the Worker runs per scheduled tick. It contains ZERO
// business logic (hard rule 5) — it invokes @3ngram/core's
// garbageCollectClients() with the production db-backed repo and logs the
// content-free result counts (hard rule 6). All age/predicate logic lives in
// packages/core/src/admin/gc-clients.ts.
import { log } from '@3ngram/config'
import { dbGcClientsRepo, type GcClientsResult, garbageCollectClients } from '@3ngram/core'

/** The repeatable BullMQ job name for the client-GC pass. */
export const GC_CLIENTS_JOB = 'gc-clients'

/**
 * Run one client-GC pass: delete registered-but-never-used OAuth clients older
 * than the idle threshold (GC_CLIENT_IDLE_DAYS). Returns the run counts so
 * BullMQ records them on the completed job; throws on failure so BullMQ marks
 * the job failed and retries per JOB_RETRY_OPTS (stamped on the scheduler
 * template in src/queues.ts). Counts only — no client_id is ever logged.
 */
export async function runGcClients(): Promise<GcClientsResult> {
  const result = await garbageCollectClients(dbGcClientsRepo)
  log().info(
    { candidates: result.candidates, collected: result.collected },
    'worker: oauth client GC pass complete',
  )
  return result
}
