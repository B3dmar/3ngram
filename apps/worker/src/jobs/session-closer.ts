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
import { type CloserResult, closeSessionRun, dbSessionCloserRepo } from '@3ngram/core'
import type { Gateway } from '@3ngram/llm'
import { z } from 'zod'

/** The BullMQ job name for one run's closer pass. */
export const SESSION_CLOSER_JOB = 'session-closer'

/**
 * The job payload, parsed at the harness boundary.
 *
 * A queue is an untrusted-ish input surface: a payload can outlive a deploy, and
 * a malformed one must be a loud failure rather than a `userId` of `undefined`
 * reaching `withTenant`. `.strict()` so a renamed field is caught rather than
 * silently defaulted. Content-free by construction — ids and an integer.
 */
export const sessionCloserJobDataSchema = z
  .object({
    userId: z.uuid(),
    sessionRunId: z.uuid(),
    activationEpoch: z.number().int().positive(),
  })
  .strict()
export type SessionCloserJobData = z.infer<typeof sessionCloserJobDataSchema>

/**
 * The deterministic BullMQ job id for one run at one epoch.
 *
 * Two producers can name the same run in one pass (the sweep closes it, then
 * lists it as a candidate), and the sweep runs again before a long generation
 * finishes. BullMQ drops an add() whose job id already exists, so this collapses
 * those into one job — which is a COST control, not a correctness one: the
 * epoch-fenced claim is what makes a duplicate pass safe, and resolve-only is
 * what makes it harmless. Keying on the epoch means a genuine resurrection is a
 * genuinely new job rather than being deduplicated away.
 */
export function sessionCloserJobId(data: SessionCloserJobData): string {
  return `${SESSION_CLOSER_JOB}:${data.sessionRunId}:${data.activationEpoch}`
}

/**
 * Run the closer for one enqueued run. Returns the pass's counts so BullMQ
 * records them on the completed job; throws on failure so BullMQ marks the job
 * failed and retries per JOB_RETRY_OPTS. A retry re-enters through the claim,
 * which is idempotent: it either re-claims or cleanly loses, and resolve-only
 * means a second pass over the same candidates writes nothing new.
 */
export async function runSessionCloser(
  data: unknown,
  gateway: Gateway | undefined,
): Promise<CloserResult> {
  const job = sessionCloserJobDataSchema.parse(data)
  const result = await closeSessionRun(
    dbSessionCloserRepo,
    job.userId,
    { sessionRunId: job.sessionRunId, activationEpoch: job.activationEpoch },
    { gateway, newAttemptId: () => crypto.randomUUID() },
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
