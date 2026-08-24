// SPDX-License-Identifier: Apache-2.0
// Lease-expiry sweep job. The BullMQ HARNESS side: this is the function the
// Worker runs per scheduled tick. It contains ZERO business logic (hard rule 5)
// — it invokes @3ngram/core's sweepSessions() with the production db-backed
// repo and logs the content-free result counts (hard rule 6). All lease
// arithmetic, the implicit-close classification and the eligibility rules live
// in packages/core/src/admin/session-sweep.ts and packages/db.
//
// It is the PRODUCER the crash path lacks: a killed terminal touches no row, so
// without this tick a dead session's commitments are never triaged at all
// (docs/concepts/session-continuity.mdx, "Lease").
import { log } from '@3ngram/config'
import {
  type CloserEnqueueRequest,
  dbSessionSweepRepo,
  type SessionSweepResult,
  sweepSessions,
} from '@3ngram/core'

/** The repeatable BullMQ job name for the lease-expiry sweep. */
export const SESSION_SWEEP_JOB = 'session-sweep'

/**
 * Run one lease-expiry sweep across all tenants at `now`, handing each swept run
 * to `enqueueCloser`. Time is injected at this boundary (core reads no clock).
 * Returns the run counts so BullMQ records them on the completed job; throws on
 * failure so BullMQ marks the job failed and retries per JOB_RETRY_OPTS.
 *
 * Counts only — never a session id, a project, or the excerpt.
 */
export async function runSessionSweep(
  enqueueCloser: (request: CloserEnqueueRequest) => Promise<void>,
): Promise<SessionSweepResult> {
  const result = await sweepSessions(dbSessionSweepRepo(enqueueCloser), new Date())
  log().info(
    {
      tenants: result.tenantsScanned,
      closed: result.implicitlyClosed,
      enqueued: result.enqueued,
      excerptsExpired: result.excerptsExpired,
    },
    'worker: session lease sweep complete',
  )
  return result
}
