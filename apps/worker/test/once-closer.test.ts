// SPDX-License-Identifier: Apache-2.0
// In-process closer collector: (run, epoch) dedup, insertion order, failure
// isolation and strictly sequential runs. Pure: no Redis, no database.
import { describe, expect, it, vi } from 'vitest'

vi.mock('@3ngram/config', () => ({
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('@3ngram/core', () => ({ SELFHOST_LIMITS: {} }))
vi.mock('@3ngram/llm', () => ({ createOpenAIGateway: vi.fn() }))

const { createCloserCollector } = await import('../src/once-closer.js')

const req = (sessionRunId: string, activationEpoch = 1, userId = 'u1') => ({
  userId,
  sessionRunId,
  activationEpoch,
})

describe('createCloserCollector', () => {
  it('collapses a duplicate (run, epoch) into one run, keeping the first entry', async () => {
    const c = createCloserCollector()
    await c.enqueue(req('a'))
    await c.enqueue(req('a'))
    await c.enqueue(req('a', 1, 'u2')) // the job id ignores userId, as BullMQ's does
    const run = vi.fn(async () => {})
    expect(await c.drain(run)).toEqual({ attempted: 1, failed: 0 })
    expect(run).toHaveBeenCalledWith(req('a'))
  })

  it('runs a new epoch of the same run separately, in insertion order', async () => {
    const c = createCloserCollector()
    for (const r of [req('b'), req('a', 1), req('a', 2)]) await c.enqueue(r)
    const run = vi.fn(async () => {})
    expect(await c.drain(run)).toEqual({ attempted: 3, failed: 0 })
    expect(run.mock.calls.map(([r]) => r)).toEqual([req('b'), req('a', 1), req('a', 2)])
  })

  it('counts a throwing run as failed and still runs the later entries', async () => {
    const c = createCloserCollector()
    for (const r of [req('a'), req('b'), req('c')]) await c.enqueue(r)
    const run = vi.fn(async (r: { sessionRunId: string }) => {
      if (r.sessionRunId === 'a') throw new Error('boom')
    })
    expect(await c.drain(run)).toEqual({ attempted: 3, failed: 1 })
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('does not start the next run before the previous one settles', async () => {
    const c = createCloserCollector()
    await c.enqueue(req('a'))
    await c.enqueue(req('b'))
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: string[] = []
    const run = vi.fn(async (r: { sessionRunId: string }) => {
      started.push(r.sessionRunId)
      if (r.sessionRunId === 'a') await first
    })
    const drained = c.drain(run)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started).toEqual(['a'])
    release()
    expect(await drained).toEqual({ attempted: 2, failed: 0 })
    expect(started).toEqual(['a', 'b'])
  })
})
