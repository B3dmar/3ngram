// SPDX-License-Identifier: Apache-2.0
// BullMQ `error` listeners: no Redis, no database, no network.
//
// Since bullmq 5.81.2 a Queue or Worker forwards a connection error only when
// it has an `error` listener, so an unregistered listener means the blocking
// connection's failures vanish without a trace. bullmq is mocked with real
// EventEmitters so the emit path is Node's own, not a stub's.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const warn = vi.fn()

async function boot() {
  vi.doMock('bullmq', () => ({
    Queue: class extends EventEmitter {
      upsertJobScheduler = vi.fn(async () => ({}))
      removeJobScheduler = vi.fn(async () => true)
      close = vi.fn(async () => {})
    },
    Worker: class extends EventEmitter {
      close = vi.fn(async () => {})
    },
  }))
  vi.doMock('@3ngram/config', () => ({
    log: () => ({ info: vi.fn(), warn, error: vi.fn() }),
    loadLlmGatewayConfig: () => undefined,
    loadSessionCloserConfig: () => ({ enabled: false }),
    loadBudgetConfig: () => ({ defaultCapUsd: 5, defaultWindowDays: 30 }),
  }))
  const { startQueues, QUEUE_NAME } = await import('../src/queues.js')
  const handles = await startQueues({} as never)
  return {
    queue: handles.queue as unknown as EventEmitter,
    worker: handles.worker as unknown as EventEmitter,
    QUEUE_NAME,
  }
}

afterEach(() => {
  vi.doUnmock('bullmq')
  vi.doUnmock('@3ngram/config')
  vi.resetModules()
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
