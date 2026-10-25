// SPDX-License-Identifier: Apache-2.0
// One-shot entrypoint HARNESS tests: no Redis, no database, no network.
// The job runners and the pool teardown are mocked; what is tested here is the
// dispatch, the exit-code contract (0/1/2), that the pool is always closed
// once a pass ran, and that the BullMQ/Redis graph is never loaded.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@3ngram/config', () => ({
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  loadEnv: vi.fn(),
}))
vi.mock('@3ngram/config/otel', () => ({
  initObservability: vi.fn(),
  flushObservability: vi.fn(async () => {}),
}))
vi.mock('@3ngram/core', () => ({ closeDb: vi.fn(async () => {}) }))
vi.mock('../src/jobs/consolidation.js', () => ({ runConsolidation: vi.fn(async () => ({})) }))
vi.mock('../src/jobs/surfacing.js', () => ({ runSurfacing: vi.fn(async () => ({})) }))
vi.mock('../src/jobs/gc-clients.js', () => ({ runGcClients: vi.fn(async () => ({})) }))
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
  // session-sweep is not a one-shot job yet; it is rejected like any unknown name.
  for (const job of [undefined, 'bogus', 'session-sweep']) {
    it(`${job ?? 'a missing job'} exits 2 without running a pass or touching the DB`, async () => {
      expect(await main(argv(job))).toBe(2)
      for (const runner of Object.values(RUNNERS)) expect(runner).not.toHaveBeenCalled()
      expect(closeDb).not.toHaveBeenCalled()
    })
  }

  it('parseOnceJob names the accepted jobs', () => {
    expect(() => parseOnceJob('bogus')).toThrow(UnknownOnceJobError)
    expect(() => parseOnceJob('bogus')).toThrow(/consolidation, surfacing, gc-clients/)
  })
})
