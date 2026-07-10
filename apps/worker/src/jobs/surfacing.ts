// SPDX-License-Identifier: Apache-2.0
// Surfacing/overdue job. The BullMQ HARNESS side:
// the function the Worker runs per scheduled tick. ZERO business logic (hard
// rule 5) — it invokes @3ngram/core's surface() with the production db-backed
// repo at the current instant and logs content-free counts (hard rule 6). All
// sweep policy lives in packages/core/src/admin/surfacing.ts.
import { log } from '@3ngram/config'
import { dbSurfacingRepo, type SurfacingResult, surface } from '@3ngram/core'

/** The repeatable BullMQ job name for the surfacing/overdue pass. */
export const SURFACING_JOB = 'surfacing'

/**
 * Run one surfacing/overdue pass (all tenants) at the current instant. Advisory:
 * expires overdue commitments and clears fired one-shot surfacing instants;
 * NEVER mutates the memory a commitment rides. The instant is captured HERE (the
 * harness boundary) and injected into core so the business logic stays clock-free
 * (no datetime.now() in core). Throws on failure so BullMQ retries.
 */
export async function runSurfacing(): Promise<SurfacingResult> {
  const result = await surface(dbSurfacingRepo, new Date())
  log().info(
    { tenants: result.tenantsScanned, expired: result.expired, surfaced: result.surfaced },
    'worker: surfacing pass complete',
  )
  return result
}
