// SPDX-License-Identifier: Apache-2.0
// BullMQ `error` listeners: no Redis, no database, no network.
//
// Since bullmq 5.81.2 a Queue or Worker forwards a connection error only when
// it has an `error` listener, so an unregistered listener means the blocking
// connection's failures vanish without a trace. bullmq is mocked with real
// EventEmitters so the emit path is Node's own, not a stub's.
import type { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks and a static import: the module graph loads once at collection,
// outside any test's timeout, instead of cold inside the first test.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('bullmq', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    Queue: class extends Emitter {
      upsertJobScheduler = vi.fn(async () => ({}))
      removeJobScheduler = vi.fn(async () => true)
      close = vi.fn(async () => {})
    },
    Worker: class extends Emitter {
      close = vi.fn(async () => {})
    },
  }
})
vi.mock('@3ngram/config', () => ({
  log: () => ({ info: vi.fn(), warn, error: vi.fn() }),
  loadLlmGatewayConfig: () => undefined,
  loadSessionCloserConfig: () => ({ enabled: false }),
  loadBudgetConfig: () => ({ defaultCapUsd: 5, defaultWindowDays: 30 }),
}))
// The job modules reach @3ngram/core and a database; this suite needs neither.
vi.mock('../src/jobs/consolidation.js', () => ({
  CONSOLIDATION_JOB: 'consolidation',
  runConsolidation: vi.fn(),
}))
vi.mock('../src/jobs/surfacing.js', () => ({ SURFACING_JOB: 'surfacing', runSurfacing: vi.fn() }))
vi.mock('../src/jobs/gc-clients.js', () => ({
  GC_CLIENTS_JOB: 'gc-clients',
  runGcClients: vi.fn(),
}))
vi.mock('../src/jobs/session-sweep.js', () => ({
  SESSION_SWEEP_JOB: 'session-sweep',
  runSessionSweep: vi.fn(),
}))
vi.mock('../src/jobs/session-closer.js', () => ({
  SESSION_CLOSER_JOB: 'session-closer',
  runSessionCloser: vi.fn(),
  sessionCloserJobId: vi.fn(),
}))

import { QUEUE_NAME, startQueues } from '../src/queues.js'

async function boot() {
  const handles = await startQueues({} as never)
  return {
    queue: handles.queue as unknown as EventEmitter,
    worker: handles.worker as unknown as EventEmitter,
    QUEUE_NAME,
  }
}

afterEach(() => {
  warn.mockReset()
})

describe('bullmq error listeners', () => {
  it('registers exactly one error listener on the Queue and on the Worker', async () => {
    const { queue, worker } = await boot()
    expect(queue.listenerCount('error')).toBe(1)
    expect(worker.listenerCount('error')).toBe(1)
  })

  it('routes an emitted error to the logger without throwing', async () => {
    const { queue, worker, QUEUE_NAME } = await boot()
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:6379')

    expect(() => queue.emit('error', refused)).not.toThrow()
    expect(() => worker.emit('error', refused)).not.toThrow()

    expect(warn).toHaveBeenCalledTimes(2)
    const expected = { queue: QUEUE_NAME, err: 'Error' }
    expect(warn).toHaveBeenNthCalledWith(1, expected, 'worker: bullmq queue error')
    expect(warn).toHaveBeenNthCalledWith(2, expected, 'worker: bullmq worker error')
  })

  it('never logs the error object, so command arguments cannot leak a job payload', async () => {
    const { worker } = await boot()
    // ioredis attaches the failed command (name + args) to a ReplyError, and
    // an add's args carry the serialized job data.
    const reply = Object.assign(new Error('ERR script failed'), {
      name: 'ReplyError',
      command: { name: 'evalsha', args: ['{"sessionRunId":"payload-marker"}'] },
    })

    worker.emit('error', reply)

    const [fields] = warn.mock.calls[0] ?? []
    expect(Object.keys(fields as object).sort()).toEqual(['err', 'queue'])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('payload-marker')
  })

  it('never logs the message, which can quote stored job data', async () => {
    const { worker } = await boot()
    // The Worker forwards a JSON.parse failure on corrupted job data. For some
    // inputs V8's message quotes the start of the unparseable text, as here.
    const parseError = new SyntaxError(
      `Unexpected token 'p', "payload-marker{"sessionRunId"..." is not valid JSON`,
    )

    worker.emit('error', parseError)

    expect(warn).toHaveBeenCalledWith(
      { queue: expect.any(String), err: 'SyntaxError' },
      'worker: bullmq worker error',
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('payload-marker')
  })

  it('does not throw on a non-Error value', async () => {
    const { queue } = await boot()
    expect(() => queue.emit('error', 'bare string')).not.toThrow()
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ err: 'string' })
  })
})
