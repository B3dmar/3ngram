// SPDX-License-Identifier: Apache-2.0
// Session closer job. The BullMQ HARNESS side: this is the function the Worker
// runs per ENQUEUED job (one per swept or explicitly-closed run) — not a
// schedule. It contains ZERO business logic (hard rule 5): it validates the job
// payload, resolves the injected gateway, invokes @3ngram/core's
// closeSessionRun() with the production db-backed repo, and logs the
// content-free counts. The claim, the epoch fence, the prompt, the strict parse
// and the live re-read all live in packages/core/src/admin/session-closer.ts.
//
// RESOLVE-ONLY (docs/concepts/session-continuity.mdx layer 5): the only corpus
// effect reachable from here is a commitment moving to `resolved`, which
// `unresolve` reverses. Nothing here can create a memory.
//
// Observability (hard rule 6): counts and outcome labels. The excerpt this job's
// prompt carries is user/assistant content and never reaches a log line — which
// is also why a failure logs `err.name`, never a provider message that may quote
// the prompt back.
import { log } from '@3ngram/config'
import {
  type BudgetEnforcement,
  type CloserResult,
  closeSessionRun,
  dbSessionCloserRepo,
} from '@3ngram/core'
import type { Gateway } from '@3ngram/llm'
import { sessionCloserJobDataSchema } from '@3ngram/schema'

/** The BullMQ job name for one run's closer pass. */
export const SESSION_CLOSER_JOB = 'session-closer'

// The payload schema and the job-id derivation live at the validation boundary
// (@3ngram/schema, hard rule 2): they re-state the session row's own
// constraints — a tenant id, a sessionRunId, the positive-integer
// activation_epoch — so a worker-local copy would be a second boundary for the
// same facts, free to drift. Re-exported so the queue wiring still imports one
// module per job.
export {
  type SessionCloserJobData,
  sessionCloserJobDataSchema,
  sessionCloserJobId,
} from '@3ngram/schema'

/**
 * Run the closer for one enqueued run. Returns the pass's counts so BullMQ
 * records them on the completed job; throws on failure so BullMQ marks the job
 * failed and retries per JOB_RETRY_OPTS. A retry re-enters through the claim,
 * which is idempotent: it either re-claims or cleanly loses, and resolve-only
 * means a second pass over the same candidates writes nothing new.
 *
 * `isLastAttempt` (issue #184) is the harness's own knowledge of BullMQ's
 * retry state — `job.attemptsMade`/`job.opts.attempts`, computed by the caller
 * (`apps/worker/src/queues.ts`'s `isLastAttempt` helper) — handed down as a
 * plain boolean so core never learns BullMQ exists (hard rule 5). It gates
 * whether a thrown failure stamps the row-level backoff at all: see
 * `CloserOptions.isLastAttempt` in packages/core for why that matters.
 */
export async function runSessionCloser(
  data: unknown,
  gateway: Gateway | undefined,
  budget: BudgetEnforcement,
  isLastAttempt: boolean,
): Promise<CloserResult> {
  const job = sessionCloserJobDataSchema.parse(data)
  const result = await closeSessionRun(
    dbSessionCloserRepo,
    job.userId,
    { sessionRunId: job.sessionRunId, activationEpoch: job.activationEpoch },
    {
      gateway,
      budget,
      newAttemptId: () => crypto.randomUUID(),
      now: new Date(),
      isLastAttempt,
      // Content-free (hard rule 6): run id + error NAME only, never a DB driver
      // message that could quote back anything content-shaped.
      onRecordFailureError: (err) =>
        log().warn(
          {
            sessionRunId: job.sessionRunId,
            err: err instanceof Error ? err.name : 'unknown',
          },
          'worker: session closer failed to record its own backoff',
        ),
    },
  )
  log().info(
    {
      // The run id is an opaque uuid, not content — it is what makes a pass
      // traceable at all. Topics, the excerpt and the model's reply are not here.
      sessionRunId: result.sessionRunId,
      skipped: result.skipped ?? null,
      candidates: result.candidates,
      rejected: result.rejected,
      resolved: result.resolved,
      skippedCandidates: result.skippedCandidates,
    },
    'worker: session closer pass complete',
  )
  return result
}
