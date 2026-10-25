// SPDX-License-Identifier: Apache-2.0
// One-shot entrypoint (`node dist/once.js <job>`, exit 0/1/2); never loads
// bullmq or ioredis. Load order is a contract (config/otel.ts, as index.ts):
// Sentry's OTel must initialize BEFORE the modules it instruments load, so the
// job modules and the pg graph behind them are DYNAMIC imports.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadEnv, loadSessionCloserConfig, log } from '@3ngram/config'
import { flushObservability, initObservability } from '@3ngram/config/otel'

export const ONCE_JOBS = ['consolidation', 'surfacing', 'gc-clients', 'session-sweep'] as const
export type OnceJob = (typeof ONCE_JOBS)[number]

export class UnknownOnceJobError extends Error {
  override name = 'UnknownOnceJobError'
}

export function parseOnceJob(arg: string | undefined): OnceJob {
  const job = ONCE_JOBS.find((name) => name === arg)
  if (job === undefined) {
    throw new UnknownOnceJobError(`expected one of: ${ONCE_JOBS.join(', ')}`)
  }
  return job
}

/** Some closer passes failed; their rows are stamped, the next sweep tick retries. */
export class CloserDrainError extends Error {
  override name = 'CloserDrainError'
  constructor(readonly failed: number) {
    super(`${failed} session closer pass(es) failed`)
  }
}

/**
 * The one-shot sweep: closers drain in-process, one at a time, strictly after
 * sweepSessions resolves. A sweep that throws drains nothing. isLastAttempt is
 * true because there is no in-process retry: each failure stamps
 * closer_next_attempt_at once (#184) and the next sweep tick is the retry.
 */
async function runSessionSweepOnce(job: OnceJob): Promise<unknown> {
  if (!loadSessionCloserConfig().enabled) {
    log().info({ job, skipped: 'closer-disabled' }, 'worker once: session closer disabled')
    return { skipped: 'closer-disabled' }
  }
  const { buildCloserDeps, createCloserCollector } = await import('./once-closer.js')
  const { runSessionSweep } = await import('./jobs/session-sweep.js')
  const { runSessionCloser } = await import('./jobs/session-closer.js')
  const { gateway, budget } = buildCloserDeps()
  const collector = createCloserCollector()
  const sweep = await runSessionSweep(collector.enqueue)
  const drained = await collector.drain((req) => runSessionCloser(req, gateway, budget, true))
  log().info({ job, ...drained }, 'worker once: closers drained')
  if (drained.failed > 0) throw new CloserDrainError(drained.failed)
  return { sweep, ...drained }
}

export async function runOnce(job: OnceJob): Promise<unknown> {
  switch (job) {
    case 'consolidation':
      return (await import('./jobs/consolidation.js')).runConsolidation()
    case 'surfacing':
      return (await import('./jobs/surfacing.js')).runSurfacing()
    case 'gc-clients':
      return (await import('./jobs/gc-clients.js')).runGcClients()
    case 'session-sweep':
      return runSessionSweepOnce(job)
  }
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown')

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const arg = argv[2]
  let job: OnceJob
  try {
    job = parseOnceJob(arg)
  } catch (err) {
    log().error({ err: errName(err), job: arg }, 'worker once: unknown job')
    return 2
  }

  log().info({ job }, 'worker once: start')
  const started = performance.now()
  let code: number
  try {
    await runOnce(job)
    const durationMs = Math.round(performance.now() - started)
    log().info({ job, durationMs }, 'worker once: complete')
    code = 0
  } catch (err) {
    // err.name only (hard rule 6): no messages or payloads.
    log().error({ job, err: errName(err) }, 'worker once: failed')
    code = 1
  } finally {
    try {
      const { closeDb } = await import('@3ngram/core')
      await closeDb()
    } catch (err) {
      log().error({ err: errName(err) }, 'worker once: pool close failed')
      code = 1
    }
  }
  return code
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && fileURLToPath(import.meta.url) === realpathSync(entrypoint)
}

if (isEntrypoint()) {
  initObservability({ role: 'worker' })
  loadEnv({ role: 'worker' }) // refuse-by-construction: a misconfigured process dies at boot
  const code = await main()
  await flushObservability()
  // Exit explicitly so no stray handle can hang a scheduled execution.
  process.exit(code)
}
