// SPDX-License-Identifier: Apache-2.0
// One-shot entrypoint HARNESS tests: no Redis, no database, no network.
// The job runners and the pool teardown are mocked; what is tested here is the
// dispatch, the exit-code contract (0/1/2), that the pool is always closed
// once a pass ran, and that the BullMQ/Redis graph is never loaded.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@3ngram/config', () => ({
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  loadEnv: vi.fn(),
  loadSessionCloserConfig: vi.fn(() => ({ enabled: true })),
  loadLlmGatewayConfig: () => undefined,
  loadJevGatewayConfig: () => undefined,
  loadBudgetConfig: () => ({}),
}))
vi.mock('@3ngram/llm', () => ({
  createOpenAIGateway: vi.fn(),
  createJevGateway: vi.fn(),
  composeGateway: vi.fn(({ base }) => base),
}))
vi.mock('@3ngram/config/otel', () => ({
  initObservability: vi.fn(),
  flushObservability: vi.fn(async () => {}),
}))
vi.mock('@3ngram/core', () => ({ closeDb: vi.fn(async () => {}), SELFHOST_LIMITS: {} }))
vi.mock('../src/jobs/consolidation.js', () => ({ runConsolidation: vi.fn(async () => ({})) }))
vi.mock('../src/jobs/surfacing.js', () => ({ runSurfacing: vi.fn(async () => ({})) }))
vi.mock('../src/jobs/gc-clients.js', () => ({ runGcClients: vi.fn(async () => ({})) }))
const RUN_A = { userId: 'u1', sessionRunId: 'run-a', activationEpoch: 1 }
const RUN_B = { userId: 'u1', sessionRunId: 'run-b', activationEpoch: 2 }
const events: string[] = []
vi.mock('../src/jobs/session-sweep.js', () => ({
  // The sweep hands over a duplicated (run, epoch) pair, as its two producers can.
  runSessionSweep: vi.fn(async (enqueue: (r: typeof RUN_A) => Promise<void>) => {
    for (const r of [RUN_A, RUN_A, RUN_B]) await enqueue(r)
    events.push('sweep resolved')
    return {}
  }),
}))
vi.mock('../src/jobs/session-closer.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/jobs/session-closer.js')>()),
  runSessionCloser: vi.fn(async (req: typeof RUN_A) => {
    events.push(`closer ${req.sessionRunId}`)
    return {}
  }),
}))
vi.mock('bullmq', () => {
  throw new Error('bullmq must not load')
})
vi.mock('ioredis', () => {
  throw new Error('ioredis must not load')
})

const { closeDb } = await import('@3ngram/core')
const { runConsolidation } = await import('../src/jobs/consolidation.js')
const { runSurfacing } = await import('../src/jobs/surfacing.js')
const { runGcClients } = await import('../src/jobs/gc-clients.js')
const { loadSessionCloserConfig } = await import('@3ngram/config')
const { runSessionSweep } = await import('../src/jobs/session-sweep.js')
const { runSessionCloser } = await import('../src/jobs/session-closer.js')
const { main, parseOnceJob, UnknownOnceJobError } = await import('../src/once.js')

const RUNNERS = {
  consolidation: runConsolidation,
  surfacing: runSurfacing,
  'gc-clients': runGcClients,
} as const

const argv = (job?: string): string[] =>
  job === undefined ? ['node', 'once.js'] : ['node', 'once.js', job]

afterEach(() => {
  vi.clearAllMocks()
  events.length = 0
})

describe('worker once: dispatch', () => {
  for (const [job, runner] of Object.entries(RUNNERS)) {
    it(`'${job}' runs exactly its runner, closes the pool and exits 0`, async () => {
      expect(await main(argv(job))).toBe(0)
      expect(runner).toHaveBeenCalledTimes(1)
      for (const other of Object.values(RUNNERS)) {
        if (other !== runner) expect(other).not.toHaveBeenCalled()
      }
      expect(closeDb).toHaveBeenCalledTimes(1)
    })
  }
})

describe('worker once: failures', () => {
  it('a throwing runner exits 1 and still closes the pool', async () => {
    vi.mocked(runSurfacing).mockRejectedValueOnce(new Error('boom'))
    expect(await main(argv('surfacing'))).toBe(1)
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('a pool close rejection after a successful pass exits 1', async () => {
    vi.mocked(closeDb).mockRejectedValueOnce(new Error('end failed'))
    expect(await main(argv('gc-clients'))).toBe(1)
    expect(runGcClients).toHaveBeenCalledTimes(1)
  })
})

describe('worker once: usage errors', () => {
  for (const job of [undefined, 'bogus']) {
    it(`${job ?? 'a missing job'} exits 2 without running a pass or touching the DB`, async () => {
      expect(await main(argv(job))).toBe(2)
      for (const runner of Object.values(RUNNERS)) expect(runner).not.toHaveBeenCalled()
      expect(closeDb).not.toHaveBeenCalled()
    })
  }

  it('parseOnceJob names the accepted jobs', () => {
    expect(() => parseOnceJob('bogus')).toThrow(UnknownOnceJobError)
    expect(() => parseOnceJob('bogus')).toThrow(
      /consolidation, surfacing, gc-clients, session-sweep/,
    )
  })
})

describe('worker once: session-sweep', () => {
  it('with the closer disabled exits 0 without sweeping', async () => {
    vi.mocked(loadSessionCloserConfig).mockReturnValueOnce({ enabled: false } as never)
    expect(await main(argv('session-sweep'))).toBe(0)
    expect(runSessionSweep).not.toHaveBeenCalled()
    expect(runSessionCloser).not.toHaveBeenCalled()
  })

  it('drains deduped closers after the sweep resolves, as last attempts, and exits 0', async () => {
    expect(await main(argv('session-sweep'))).toBe(0)
    expect(events).toEqual(['sweep resolved', 'closer run-a', 'closer run-b'])
    expect(vi.mocked(runSessionCloser).mock.calls.map((c) => [c[0], c[3]])).toEqual([
      [RUN_A, true],
      [RUN_B, true],
    ])
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('one failing closer exits 1 and the other closers still run', async () => {
    vi.mocked(runSessionCloser).mockRejectedValueOnce(new Error('provider down'))
    expect(await main(argv('session-sweep'))).toBe(1)
    expect(runSessionCloser).toHaveBeenCalledTimes(2)
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('a throwing sweep exits 1 and drains nothing', async () => {
    vi.mocked(runSessionSweep).mockImplementationOnce(async (enqueue) => {
      await enqueue(RUN_A)
      throw new Error('db down')
    })
    expect(await main(argv('session-sweep'))).toBe(1)
    expect(runSessionCloser).not.toHaveBeenCalled()
    expect(closeDb).toHaveBeenCalledTimes(1)
  })
})
