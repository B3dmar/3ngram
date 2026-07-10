// SPDX-License-Identifier: Apache-2.0
// BullMQ wiring. The HARNESS: it constructs the Queue
// + Worker, registers the two repeatable job schedulers, dispatches each tick to
// the matching core-backed job runner, and exposes a graceful shutdown. It holds
// NO business logic (hard rule 5) — every job body delegates to src/jobs/*,
// which delegate to @3ngram/core.
//
// One queue, two repeatable schedulers (upsertJobScheduler is idempotent: a
// re-deploy upserts the schedule rather than duplicating it). The processor
// switches on job.name to the right runner.
import { log } from '@3ngram/config'
import { type Job, Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import { CONSOLIDATION_JOB, runConsolidation } from './jobs/consolidation.js'
import { GC_CLIENTS_JOB, runGcClients } from './jobs/gc-clients.js'
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

/** Dispatch a BullMQ job to its core-backed runner. Unknown names throw (visible failure). */
async function process(job: Job): Promise<unknown> {
  switch (job.name) {
    case CONSOLIDATION_JOB:
      return runConsolidation()
    case SURFACING_JOB:
      return runSurfacing()
    case GC_CLIENTS_JOB:
      return runGcClients()
    default:
      throw new Error(`worker: unknown job name ${job.name}`)
  }
}

/**
 * Build the Queue + Worker on the given connection and register both repeatable
 * job schedulers. The connection MUST be the worker's BullMQ-tuned client
 * (maxRetriesPerRequest:null — see src/redis.ts). Idempotent: upsertJobScheduler
 * re-registers the same schedule across deploys without duplicating it.
 */
export async function startQueues(connection: Redis): Promise<WorkerHandles> {
  const queue = new Queue(QUEUE_NAME, { connection })
  const worker = new Worker(QUEUE_NAME, process, { connection })

  worker.on('failed', (job, err) => {
    // ids + error name only — never job data / memory content (hard rule 6).
    log().error({ jobId: job?.id, jobName: job?.name, err: err.name }, 'worker: job failed')
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

  log().info({ queue: QUEUE_NAME }, 'worker: queues started')
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
