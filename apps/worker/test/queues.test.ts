// SPDX-License-Identifier: Apache-2.0
// isLastAttempt: no Redis, no BullMQ Worker/Queue instance — a pure read of a
// duck-typed job shape. Pinned separately from session-jobs.test.ts because
// that file mocks 'bullmq' wholesale to test the queue-wiring behaviour; this
// property is about the arithmetic alone (issue #184 audit F3).
import type { Job } from 'bullmq'
import { describe, expect, it } from 'vitest'
import { isLastAttempt } from '../src/queues.js'

function job(attemptsMade: number, attempts: number | undefined): Job {
  return { attemptsMade, opts: { attempts } } as unknown as Job
}

describe('isLastAttempt', () => {
  it('is false on the first two of three attempts', () => {
    expect(isLastAttempt(job(0, 3))).toBe(false)
    expect(isLastAttempt(job(1, 3))).toBe(false)
  })

  it('is true on the third of three attempts — CLOSER_JOB_OPTS shape', () => {
    expect(isLastAttempt(job(2, 3))).toBe(true)
  })

  it('is true for a single-attempt job (no retry policy at all)', () => {
    expect(isLastAttempt(job(0, 1))).toBe(true)
    expect(isLastAttempt(job(0, undefined))).toBe(true)
  })

  it('mirrors the moment BullMQ itself reads attemptsMade — BEFORE this attempt is counted', () => {
    // job.js `shouldRetryJob`: `this.attemptsMade + 1 < this.opts.attempts`.
    // Our processor runs before moveToFinished increments attemptsMade for
    // the CURRENT try, so this function reads the same pre-increment value
    // BullMQ's own retry decision reads — same formula, same timing.
    for (const attemptsMade of [0, 1, 2, 3]) {
      expect(isLastAttempt(job(attemptsMade, 4))).toBe(attemptsMade + 1 >= 4)
    }
  })

  it('is defensive against a duck-typed job with no attemptsMade/opts (test doubles)', () => {
    expect(isLastAttempt({} as unknown as Job)).toBe(true)
  })
})
