// SPDX-License-Identifier: Apache-2.0
// BullMQ wiring. The HARNESS: it constructs the Queue
// + Worker, registers the repeatable job schedulers, dispatches each tick to
// the matching core-backed job runner, and exposes a graceful shutdown. It holds
// NO business logic (hard rule 5) — every job body delegates to src/jobs/*,
// which delegate to @3ngram/core.
//
// One queue, four repeatable schedulers (upsertJobScheduler is idempotent: a
// re-deploy upserts the schedule rather than duplicating it) plus ONE on-demand
// job name: the session closer runs per enqueued run, not on a clock, because
// its unit of work is a session that ended rather than an interval. The
// processor switches on job.name to the right runner.
//
// The session sweep and closer are DEFAULT-OFF (docs/concepts/session-continuity.mdx
// layer 5) and the flag is a real KILL SWITCH, not merely a first-boot default:
// turning it off REMOVES the durable scheduler from Redis and makes the two
// processors no-op, so a deployment that once ran with it on stops closing rows
// and stops billing generation as soon as it restarts with the flag off.
import {
  loadBudgetConfig,
  loadLlmGatewayConfig,
  loadSessionCloserConfig,
  log,
} from '@3ngram/config'
import { type BudgetEnforcement, type CloserEnqueueRequest, SELFHOST_LIMITS } from '@3ngram/core'
import { createOpenAIGateway, type Gateway } from '@3ngram/llm'
import { type Job, Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import { CONSOLIDATION_JOB, runConsolidation } from './jobs/consolidation.js'
import { GC_CLIENTS_JOB, runGcClients } from './jobs/gc-clients.js'
import { runSessionCloser, SESSION_CLOSER_JOB, sessionCloserJobId } from './jobs/session-closer.js'
import { runSessionSweep, SESSION_SWEEP_JOB } from './jobs/session-sweep.js'
import { runSurfacing, SURFACING_JOB } from './jobs/surfacing.js'

/** The single BullMQ queue the worker service owns. */
export const QUEUE_NAME = 'admin-maintenance'

/**
 * Cron schedules for the three repeatable jobs (cron-parser 6-field form, the
 * leading field is seconds). Conservative low frequencies — these are advisory
 * background passes, not latency-sensitive:
 *   - consolidation: hourly at minute 0 (similarity scan is the heavier pass).
 *   - surfacing: every 15 minutes (keeps overdue/stale briefing sections fresh).
 *   - gc-clients: once daily at 03:10 (deletes 30-day-idle never-used OAuth
 *     clients; the 30-day threshold makes a daily cadence ample, and the
 *     off-peak hour keeps it clear of the hourly consolidation tick).
 */
export const CONSOLIDATION_CRON = '0 0 * * * *'
export const SURFACING_CRON = '0 */15 * * * *'
export const GC_CLIENTS_CRON = '0 10 3 * * *'
/**
 * Lease-expiry sweep: every 20 minutes, offset off the hour so it never lands on
 * the consolidation tick. Cadence only bounds LATENCY, never correctness — the
 * sweep closes rows already quiet for a 24h lease plus an hour of grace, so a
 * pass arriving twenty minutes late changes nothing about which rows qualify.
 */
export const SESSION_SWEEP_CRON = '0 5,25,45 * * * *'

/**
 * Retry policy stamped on every scheduled job via the scheduler template.
 * Without it BullMQ defaults to a single attempt, so a transient DB/Redis blip
 * would silently skip the pass until the next cron tick. 3 attempts with
 * exponential backoff (30s, then 60s) stays well inside even the 15-minute
 * surfacing cadence, so retries never overlap the next tick.
 */
export const JOB_RETRY_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
} as const

/** The handles the harness must close on shutdown. */
export interface WorkerHandles {
  queue: Queue
  worker: Worker
}

/**
 * Removal policy for the DEDUPLICATED closer job: IMMEDIATE on both terminal
 * states.
 *
 * The job id is deterministic on `(run, epoch)` so the sweep's two producers
 * collapse into one job. BullMQ keeps completed and failed jobs by default, and
 * a kept job KEEPS ITS ID RESERVED: `add()` with an existing id is silently
 * ignored (addStandardJob's duplicate branch). Without a removal policy the
 * first pass over a run burns that id forever.
 *
 * `true`, NOT `{ count: n }`. A count policy only bounds the retained set — the
 * newest n terminal jobs keep their ids, and eviction is evaluated on a
 * best-effort basis only when ANOTHER job finishes (BullMQ runs no background
 * timer for it). On a low-volume deployment that window never rotates, so the
 * bug the policy was meant to fix survives: a pass that returned `no-gateway`
 * still blocks its run after the gateway is configured, and even a SUCCESSFUL
 * pass blocks the late-event reprocessing path for the same epoch. A count only
 * ever mitigated the high-volume case.
 *
 * TERMINAL ONLY. `removeOnFail` reaches `moveToFailedArgs` exclusively on the
 * non-retry branch of `Job.moveToFailed` (bullmq 5.78.0), so a job failing
 * attempt 1 of 3 stays in the retry chain untouched — the id is freed once, when
 * the attempts are exhausted.
 *
 * WORST CASE, and why it is acceptable: a row that keeps failing is re-enqueued
 * once per sweep tick instead of once ever. That is bounded churn on a 20-minute
 * cadence, it is SELF-HEALING (the moment the cause clears, the next tick
 * succeeds), and the generation behind it is budget-capped, so a permanently
 * broken row cannot run up spend. Losing the failed-set entry is a real cost;
 * the `worker: job failed` handler below is the observability story that
 * replaces it, and it carries the deterministic job id — which encodes the run
 * and epoch — precisely so a vanished job is still traceable.
 */
export const CLOSER_JOB_OPTS = {
  ...JOB_RETRY_OPTS,
  removeOnComplete: true,
  removeOnFail: true,
} as const

/**
 * Enqueue one closer job, deduplicated by `(run, epoch)`. Held as a closure over
 * the queue so core never learns that BullMQ exists (hard rule 5): the sweep
 * takes an `enqueueCloser` port and this is the production implementation.
 *
 * Deduplication here is a COST control, never a correctness one. The row stays
 * eligible until a pass stamps a terminal `triage_status`, so a de-duplicated
 * add is simply a later sweep finding the run still eligible and enqueuing it
 * again — the epoch-fenced claim is what makes a duplicate pass safe.
 */
function closerEnqueuer(queue: Queue): (request: CloserEnqueueRequest) => Promise<void> {
  return async (request) => {
    const data = {
      userId: request.userId,
      sessionRunId: request.sessionRunId,
      activationEpoch: request.activationEpoch,
    }
    await queue.add(SESSION_CLOSER_JOB, data, {
      jobId: sessionCloserJobId(data),
      ...CLOSER_JOB_OPTS,
    })
  }
}

/**
 * Dispatch a BullMQ job to its core-backed runner. Unknown names throw (visible
 * failure).
 *
 * The two session jobs are gated on the flag HERE as well as at registration.
 * Schedulers are durable in Redis and a queue can hold already-enqueued closer
 * jobs, so a deployment that flips the flag off must not keep draining work that
 * was produced while it was on. Startup removes the scheduler; this stops
 * anything already in flight.
 */
async function process(
  job: Job,
  queue: Queue,
  gateway: Gateway | undefined,
  budget: BudgetEnforcement,
  closerEnabled: boolean,
): Promise<unknown> {
  switch (job.name) {
    case CONSOLIDATION_JOB:
      return runConsolidation()
    case SURFACING_JOB:
      return runSurfacing()
    case GC_CLIENTS_JOB:
      return runGcClients()
    case SESSION_SWEEP_JOB:
      if (!closerEnabled) return closerDisabled(job.name)
      return runSessionSweep(closerEnqueuer(queue))
    case SESSION_CLOSER_JOB:
      if (!closerEnabled) return closerDisabled(job.name)
      return runSessionCloser(job.data, gateway, budget)
    default:
      throw new Error(`worker: unknown job name ${job.name}`)
  }
}

/**
 * A residual session job that arrived after the closer was disabled. Reported as
 * a completed no-op rather than a failure: a failure would retry three times and
 * then sit in the failed set, which is noise for an operator action that was
 * deliberate.
 */
function closerDisabled(jobName: string): { skipped: 'closer-disabled' } {
  log().info({ jobName }, 'worker: session closer disabled; skipping residual job')
  return { skipped: 'closer-disabled' }
}

/**
 * Build the Queue + Worker on the given connection and register both repeatable
 * job schedulers. The connection MUST be the worker's BullMQ-tuned client
 * (maxRetriesPerRequest:null — see src/redis.ts). Idempotent: upsertJobScheduler
 * re-registers the same schedule across deploys without duplicating it.
 */
export async function startQueues(connection: Redis): Promise<WorkerHandles> {
  const queue = new Queue(QUEUE_NAME, { connection })
  // The closer is the only job that needs generation. Resolve the gateway ONCE
  // at boot (env-gated, exactly as apps/server does) rather than per job: it is
  // a pure factory, and re-reading env per tick would let a live process drift.
  // Absent config → undefined → every closer pass reports `no-gateway` and
  // writes nothing, which is the correct degraded behaviour for a self-host
  // deployment with no LLM configured.
  const gatewayConfig = loadLlmGatewayConfig()
  const gateway = gatewayConfig === undefined ? undefined : createOpenAIGateway(gatewayConfig)
  const closer = loadSessionCloserConfig()
  // Budget enforcement for the ONE metered operation the worker owns. Mirrors
  // apps/server's composition root: self-host resolves empty limits and falls
  // through to the config default cap, so a self-host worker is capped too. The
  // closer is a background job, so an over-cap pass must be REJECTED rather than
  // silently billed — this is the seam that does it.
  const budget: BudgetEnforcement = {
    resolveLimits: async () => SELFHOST_LIMITS,
    config: loadBudgetConfig(),
    logger: { warn: (obj, msg) => log().warn(obj, msg) },
  }
  const worker = new Worker(
    QUEUE_NAME,
    (job) => process(job, queue, gateway, budget, closer.enabled),
    { connection },
  )

  worker.on('failed', (job, err) => {
    // ids + counts + error name only — never job data / memory content (hard
    // rule 6). This is now the ONLY durable trace of a failed closer pass:
    // CLOSER_JOB_OPTS removes terminal jobs immediately, so nothing survives in
    // Redis to inspect afterwards. `jobId` carries the run and epoch for the
    // closer (the id is derived from them), and `attemptsMade` distinguishes a
    // transient blip that later succeeded from a run that exhausted its retries
    // and was then re-enqueued by the next sweep tick.
    log().error(
      {
        jobId: job?.id,
        jobName: job?.name,
        attemptsMade: job?.attemptsMade,
        attemptsAllowed: job?.opts.attempts,
        err: err.name,
      },
      'worker: job failed',
    )
  })

  await queue.upsertJobScheduler(
    CONSOLIDATION_JOB,
    { pattern: CONSOLIDATION_CRON },
    {
      name: CONSOLIDATION_JOB,
      opts: JOB_RETRY_OPTS,
    },
  )
  await queue.upsertJobScheduler(
    SURFACING_JOB,
    { pattern: SURFACING_CRON },
    {
      name: SURFACING_JOB,
      opts: JOB_RETRY_OPTS,
    },
  )
  await queue.upsertJobScheduler(
    GC_CLIENTS_JOB,
    { pattern: GC_CLIENTS_CRON },
    {
      name: GC_CLIENTS_JOB,
      opts: JOB_RETRY_OPTS,
    },
  )

  // DEFAULT-OFF, AND A REAL KILL SWITCH. Turning it on is a later, MEASURED
  // decision (docs/concepts/session-continuity.mdx "Validation bar").
  //
  // BullMQ job schedulers are DURABLE: `upsertJobScheduler` writes a repeat entry
  // into Redis that survives the process. So an operator who ran with the flag on
  // and then turns it off would otherwise keep the sweep firing forever from a
  // scheduler no code registers any more — still implicitly closing rows, still
  // spending on generation. Removing it here is what makes "off" mean off. The
  // processors are gated too (see `process`), because the queue can still hold
  // closer jobs produced while it was on.
  if (closer.enabled) {
    await queue.upsertJobScheduler(
      SESSION_SWEEP_JOB,
      { pattern: SESSION_SWEEP_CRON },
      {
        name: SESSION_SWEEP_JOB,
        opts: JOB_RETRY_OPTS,
      },
    )
  } else {
    // Idempotent: returns false when there was nothing registered, which is the
    // overwhelmingly common case (a deployment that never enabled the closer).
    await queue.removeJobScheduler(SESSION_SWEEP_JOB)
  }

  log().info(
    { queue: QUEUE_NAME, sessionCloser: closer.enabled, gateway: gateway !== undefined },
    'worker: queues started',
  )
  return { queue, worker }
}

/**
 * Graceful shutdown: stop accepting new jobs and wait for in-flight jobs to
 * finalize (worker.close), then close the queue. The shared connection is closed
 * by the caller (src/index.ts) after both, since it backs both handles.
 */
export async function stopQueues(handles: WorkerHandles): Promise<void> {
  await handles.worker.close()
  await handles.queue.close()
  log().info({ queue: QUEUE_NAME }, 'worker: queues stopped')
}
