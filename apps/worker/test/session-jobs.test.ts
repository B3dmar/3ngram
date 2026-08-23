// SPDX-License-Identifier: Apache-2.0
// Session sweep + closer HARNESS tests: no Redis, no database, no network.
//
// The policy itself is covered in packages/core (session-closer.test.ts,
// session-sweep.test.ts). What is only testable here is the wiring:
//
//   - DEFAULT-OFF actually means off — the sweep scheduler is not registered,
//     so nothing produces closer jobs and no generation is billed;
//   - the closer job id is keyed (run, epoch), so the sweep's two producers
//     collapse into one job while a genuine resurrection does not;
//   - the job payload is parsed at the boundary, so a stale or malformed
//     payload is a loud failure rather than `undefined` reaching withTenant.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionCloserJobDataSchema, sessionCloserJobId } from '../src/jobs/session-closer.js'

const DATA = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionRunId: '22222222-2222-4222-8222-222222222222',
  activationEpoch: 3,
}

describe('sessionCloserJobDataSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(sessionCloserJobDataSchema.parse(DATA)).toEqual(DATA)
  })

  it('rejects a renamed or extra field rather than silently defaulting it', () => {
    expect(() => sessionCloserJobDataSchema.parse({ ...DATA, extra: 1 })).toThrow()
    const { activationEpoch: _drop, ...withoutEpoch } = DATA
    expect(() => sessionCloserJobDataSchema.parse(withoutEpoch)).toThrow()
  })

  it('rejects a non-uuid tenant — the payload feeds withTenant directly', () => {
    expect(() => sessionCloserJobDataSchema.parse({ ...DATA, userId: 'admin' })).toThrow()
  })

  it('rejects a non-positive epoch (the column starts at 1)', () => {
    expect(() => sessionCloserJobDataSchema.parse({ ...DATA, activationEpoch: 0 })).toThrow()
  })
})

describe('sessionCloserJobId', () => {
  it('is stable for one run at one epoch, so duplicate enqueues collapse', () => {
    expect(sessionCloserJobId(DATA)).toBe(sessionCloserJobId({ ...DATA }))
  })

  it('CHANGES when the epoch advances, so a resurrection is a genuinely new job', () => {
    // Keying on the run alone would let BullMQ dedupe away the pass for a
    // session that was resumed and closed again — the epoch is what keeps a
    // real second activation distinguishable from a duplicate delivery.
    expect(sessionCloserJobId({ ...DATA, activationEpoch: 4 })).not.toBe(sessionCloserJobId(DATA))
  })
})

/** Mount startQueues with bullmq and the job modules stubbed. */
async function bootQueues(closerEnabled: boolean) {
  let processor: ((job: { name: string; data?: unknown }) => Promise<unknown>) | undefined
  const added: {
    name: string
    data: unknown
    opts: { jobId?: string; removeOnComplete?: unknown; removeOnFail?: unknown }
  }[] = []
  const upsert = vi.fn(async () => ({}))
  const removeScheduler = vi.fn(async () => true)

  vi.doMock('bullmq', () => ({
    Queue: class {
      upsertJobScheduler = upsert
      removeJobScheduler = removeScheduler
      add = vi.fn(
        async (
          name: string,
          data: unknown,
          opts: { jobId?: string; removeOnComplete?: unknown; removeOnFail?: unknown },
        ) => {
          added.push({ name, data, opts })
          return {}
        },
      )
      close = vi.fn(async () => {})
    },
    Worker: class {
      constructor(_name: string, fn: (job: { name: string; data?: unknown }) => Promise<unknown>) {
        processor = fn
      }
      on = vi.fn()
      close = vi.fn(async () => {})
    },
  }))
  vi.doMock('@3ngram/config', () => ({
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    loadLlmGatewayConfig: () => undefined,
    loadSessionCloserConfig: () => ({ enabled: closerEnabled }),
    loadBudgetConfig: () => ({ defaultCapUsd: 5, defaultWindowDays: 30 }),
  }))

  const sweepRun = vi.fn(async () => ({}))
  const closerRun = vi.fn(async () => ({}))
  // The three pre-existing jobs are stubbed too: dispatching them for real would
  // reach @3ngram/core and then a database, and this suite has neither.
  vi.doMock('../src/jobs/consolidation.js', () => ({
    CONSOLIDATION_JOB: 'consolidation',
    runConsolidation: vi.fn(async () => ({ ran: 'consolidation' })),
  }))
  vi.doMock('../src/jobs/surfacing.js', () => ({
    SURFACING_JOB: 'surfacing',
    runSurfacing: vi.fn(async () => ({ ran: 'surfacing' })),
  }))
  vi.doMock('../src/jobs/gc-clients.js', () => ({
    GC_CLIENTS_JOB: 'gc-clients',
    runGcClients: vi.fn(async () => ({ ran: 'gc-clients' })),
  }))
  vi.doMock('../src/jobs/session-sweep.js', () => ({
    SESSION_SWEEP_JOB: 'session-sweep',
    runSessionSweep: sweepRun,
  }))
  vi.doMock('../src/jobs/session-closer.js', async () => ({
    SESSION_CLOSER_JOB: 'session-closer',
    runSessionCloser: closerRun,
    sessionCloserJobId: (
      await vi.importActual<typeof import('../src/jobs/session-closer.js')>(
        '../src/jobs/session-closer.js',
      )
    ).sessionCloserJobId,
  }))

  const { startQueues } = await import('../src/queues.js')
  const handles = await startQueues({} as never)
  return { handles, processor, added, upsert, removeScheduler, sweepRun, closerRun }
}

function unmountQueues(): void {
  vi.doUnmock('bullmq')
  vi.doUnmock('@3ngram/config')
  vi.doUnmock('../src/jobs/consolidation.js')
  vi.doUnmock('../src/jobs/surfacing.js')
  vi.doUnmock('../src/jobs/gc-clients.js')
  vi.doUnmock('../src/jobs/session-sweep.js')
  vi.doUnmock('../src/jobs/session-closer.js')
  vi.resetModules()
}

// Unmount even when an expectation fails. Without this a single failure leaves
// the module registry mocked, and every later boot silently reuses the CACHED
// queues module — which turns one red test into a cascade that hides its cause.
afterEach(unmountQueues)

describe('queue wiring — the closer is default-off', () => {
  it('does NOT register the sweep scheduler when the flag is unset', async () => {
    const { upsert } = await bootQueues(false)
    // The three pre-existing repeatable jobs, and nothing else. With no sweep
    // there is no producer, so no closer job and no LLM spend.
    expect(upsert).toHaveBeenCalledTimes(3)
    expect(upsert.mock.calls.map(([name]) => name)).not.toContain('session-sweep')
    unmountQueues()
  })

  it('registers it when the flag is on, carrying the shared retry policy', async () => {
    const { upsert } = await bootQueues(true)
    expect(upsert).toHaveBeenCalledTimes(4)
    const sweep = upsert.mock.calls.find(([name]) => name === 'session-sweep')
    expect(sweep).toBeDefined()
    // Without attempts, a transient DB blip silently skips the pass until the
    // next tick — the same reason the other three carry it.
    expect((sweep?.[2] as { opts: { attempts: number } }).opts.attempts).toBeGreaterThan(1)
    unmountQueues()
  })
})

describe('queue wiring — dispatch and enqueue', () => {
  it('routes both new job names to their runners', async () => {
    const { processor, sweepRun, closerRun } = await bootQueues(true)
    await processor?.({ name: 'session-sweep' })
    await processor?.({ name: 'session-closer', data: DATA })
    expect(sweepRun).toHaveBeenCalledOnce()
    expect(closerRun).toHaveBeenCalledOnce()
    // The payload reaches the runner unmodified; the runner parses it.
    expect(closerRun.mock.calls[0]?.[0]).toEqual(DATA)
    unmountQueues()
  })

  it('enqueues closer jobs with the deterministic (run, epoch) id', async () => {
    const { processor, sweepRun, added } = await bootQueues(true)
    await processor?.({ name: 'session-sweep' })

    // The sweep receives an enqueue port; drive it the way core would.
    const enqueue = sweepRun.mock.calls[0]?.[0] as (r: typeof DATA) => Promise<void>
    await enqueue(DATA)
    await enqueue(DATA)

    expect(added).toHaveLength(2)
    for (const job of added) {
      expect(job.name).toBe('session-closer')
      expect(job.opts.jobId).toBe(sessionCloserJobId(DATA))
    }
    // Two adds with ONE job id: BullMQ collapses them. The test asserts the id,
    // not the collapse, because the collapse is BullMQ's behaviour and stubbing
    // it here would only assert the stub.
    expect(new Set(added.map((job) => job.opts.jobId)).size).toBe(1)
    unmountQueues()
  })

  it('passes no gateway when none is configured, so the closer degrades', async () => {
    // Self-host with no LLM configured: every pass reports `no-gateway` and
    // writes nothing, rather than the worker failing to boot.
    const { processor, closerRun } = await bootQueues(true)
    await processor?.({ name: 'session-closer', data: DATA })
    expect(closerRun.mock.calls[0]?.[1]).toBeUndefined()
    unmountQueues()
  })
})

describe('the flag is a KILL SWITCH, not just a first-boot default', () => {
  it('REMOVES the durable scheduler when the flag is off', async () => {
    // BullMQ writes a repeat entry into Redis that outlives the process, so a
    // deployment that once ran with the closer on would otherwise keep sweeping
    // forever from a scheduler no code registers any more — still closing rows,
    // still billing generation. Skipping the upsert is not enough; the entry has
    // to go.
    const { removeScheduler } = await bootQueues(false)
    expect(removeScheduler).toHaveBeenCalledWith('session-sweep')
    unmountQueues()
  })

  it('does not remove it while the flag is on', async () => {
    const { removeScheduler } = await bootQueues(true)
    expect(removeScheduler).not.toHaveBeenCalled()
    unmountQueues()
  })

  it('no-ops a residual sweep job that arrives after disabling', async () => {
    // The queue can still hold work produced while the flag was on, and a
    // scheduler removal does not drain it.
    const { processor, sweepRun } = await bootQueues(false)
    const result = await processor?.({ name: 'session-sweep' })
    expect(sweepRun).not.toHaveBeenCalled()
    expect(result).toEqual({ skipped: 'closer-disabled' })
    unmountQueues()
  })

  it('no-ops a residual closer job that arrives after disabling', async () => {
    const { processor, closerRun } = await bootQueues(false)
    const result = await processor?.({ name: 'session-closer', data: DATA })
    expect(closerRun).not.toHaveBeenCalled()
    // A completed no-op, not a failure: three retries and a failed-set entry
    // would be noise for a deliberate operator action.
    expect(result).toEqual({ skipped: 'closer-disabled' })
    unmountQueues()
  })

  it('still runs the three unrelated maintenance jobs while disabled', async () => {
    // The kill switch is scoped to the closer. Turning it off must not silently
    // stop consolidation, surfacing or OAuth GC.
    const { processor } = await bootQueues(false)
    for (const name of ['consolidation', 'surfacing', 'gc-clients']) {
      await expect(processor?.({ name })).resolves.not.toEqual({ skipped: 'closer-disabled' })
    }
    unmountQueues()
  })
})

describe('closer job removal policy', () => {
  it('frees the job id on both completion and failure', async () => {
    // The id is deterministic on (run, epoch) and BullMQ keeps terminal jobs by
    // default — and a kept job keeps its id RESERVED, so `add()` is silently
    // ignored. Without a removal policy the first pass over a run would burn
    // that id forever: a pass that returned `no-gateway`, or one that exhausted
    // its retries, would block every later attempt on the same run and epoch,
    // and configuring the gateway on the next deploy would not rescue it.
    const { processor, sweepRun, added } = await bootQueues(true)
    await processor?.({ name: 'session-sweep' })
    const enqueue = sweepRun.mock.calls[0]?.[0] as (r: typeof DATA) => Promise<void>
    await enqueue(DATA)

    expect(added[0]?.opts.removeOnComplete).toBeDefined()
    expect(added[0]?.opts.removeOnFail).toBeDefined()
    unmountQueues()
  })
})

describe('the job id is legal for BullMQ 5', () => {
  it('contains no colon at all', () => {
    // BullMQ 5.78.0 rejects a custom id containing ':' UNLESS it splits into
    // exactly three segments — a backwards-compatibility carve-out for legacy
    // repeatable ids (`name:id:millis`), carrying an in-source TODO to become a
    // blanket rejection. A three-segment colon id would pass today only by
    // coincidence, on a branch that exists for a different feature.
    expect(sessionCloserJobId(DATA)).not.toContain(':')
  })

  it('satisfies BullMQ 5.78.0 addJob validation directly', () => {
    // The check, transcribed from bullmq/dist/cjs/classes/job.js:
    //   if (jobId.includes(':') && jobId.split(':').length !== 3) throw
    //   if (`${parseInt(jobId, 10)}` === jobId) throw   // "cannot be integers"
    const id = sessionCloserJobId(DATA)
    expect(id.includes(':') && id.split(':').length !== 3).toBe(false)
    expect(`${Number.parseInt(id, 10)}` === id).toBe(false)
  })
})
