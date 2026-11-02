// SPDX-License-Identifier: Apache-2.0
// Forgetting pass, one run (docs/concepts/forgetting-pass.mdx): no database, no
// network. Pinned here:
//   - an opted-out tenant reads nothing and sends nothing;
//   - every batch is reserved, re-checks the opt-in, sends under its own
//     operation, records usage unpriced, is staged, and is released;
//   - the run stops on an opt-out mid-run, on no judgment gateway (no
//     fallback), and on a refused reservation, keeping what was staged;
//   - any other gateway error propagates after earlier batches were staged.
import type { ForgettingMemory, RetentionVerdictWrite } from '@3ngram/db'
import {
  createFakeGateway,
  type DecideAnswer,
  FAKE_DECIDE_MODEL,
  type Gateway,
  NotImplementedError,
} from '@3ngram/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@3ngram/db', () => ({ reserveBudget: vi.fn(), releaseReservation: vi.fn() }))

import { releaseReservation, reserveBudget } from '@3ngram/db'
import { FORGET_DECIDE_OPERATION } from '../src/admin/forgetting-judgment.js'
import {
  type ForgettingCandidates,
  type ForgettingRepo,
  type ForgettingUsage,
  runForgettingPass,
} from '../src/admin/forgetting-pass.js'
import type { BudgetEnforcement } from '../src/budget/index.js'

const mockReserve = vi.mocked(reserveBudget)
const mockRelease = vi.mocked(releaseReservation)
mockRelease.mockResolvedValue(undefined)

const USER = '00000000-0000-7000-8000-00000000000a'
const NOW = new Date('2026-10-27T04:30:00.000Z')
const AT = new Date('2026-06-01T00:00:00.000Z')
const budget: BudgetEnforcement = {
  resolveLimits: async () => ({}),
  config: { defaultCapUsd: 10, defaultWindowDays: 30 },
}

let seq = 0
const memory = (): ForgettingMemory => {
  seq += 1
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    memoryType: 'decision',
    scope: 'work',
    project: '3ngram',
    topic: `topic ${seq}`,
    content: `content ${seq}`,
    recordedAt: AT,
    lastTouchedAt: AT,
  }
}
const candidates = (singles: number): ForgettingCandidates => ({
  singles: Array.from({ length: singles }, memory),
  pairs: [],
  neighbours: [],
})
const choice = (key: string, p: number): DecideAnswer => ({
  type: 'choice',
  choice: key,
  confidence: p,
  probabilities: { [key]: p },
})

/** A recording repo; `optIn` answers each isJudgmentEnabled call in turn, then repeats the last. */
function repo(opts: { optIn?: boolean[]; candidates?: ForgettingCandidates } = {}) {
  const optIn = opts.optIn ?? [true]
  const calls = {
    optIn: 0,
    reads: 0,
    staged: [] as RetentionVerdictWrite[][],
    usage: [] as ForgettingUsage[],
  }
  const r: ForgettingRepo = {
    isJudgmentEnabled: async () => optIn[Math.min(calls.optIn++, optIn.length - 1)] as boolean,
    readCandidates: async () => {
      calls.reads += 1
      return opts.candidates ?? candidates(1)
    },
    stage: async (_userId, verdicts) => {
      calls.staged.push([...verdicts])
      return verdicts.length
    },
    recordUsage: async (_userId, usage) => {
      calls.usage.push(usage)
    },
  }
  return { repo: r, calls }
}

afterEach(() => {
  mockReserve.mockReset()
  mockRelease.mockClear()
})

describe('runForgettingPass', () => {
  it('reads and sends nothing for a tenant that has not opted in', async () => {
    const gateway = createFakeGateway()
    const { repo: r, calls } = repo({ optIn: [false] })
    const result = await runForgettingPass(USER, { gateway, repo: r, now: NOW })
    expect(result).toMatchObject({ stopped: 'not-opted-in', items: 0, batches: 0 })
    expect(calls.reads).toBe(0)
    expect(gateway.calls.decide).toEqual([])
  })

  it('reserves, sends, records, stages and releases every batch', async () => {
    mockReserve.mockResolvedValue({ allowed: true, reservationId: 'res' } as never)
    const gateway = createFakeGateway({
      decisions: {
        [FORGET_DECIDE_OPERATION]: {
          s0: choice('archive', 0.9),
          s1: choice('archive', 0.5),
          s2: choice('keep', 0.8),
          s12: choice('archive', 0.95),
        },
      },
    })
    const { repo: r, calls } = repo({ candidates: candidates(13) })
    const result = await runForgettingPass(USER, { gateway, repo: r, budget, now: NOW })
    // 13 items: two batches. Unanswered items get the fake's default first key
    // ('keep') at a low probability, which is a keep.
    expect(result).toEqual({
      items: 13,
      batches: 2,
      proposed: 2,
      dismissed: 11,
      skipped: 0,
      staged: 13,
    })
    expect(gateway.calls.decide.map((c) => c.operation)).toEqual([
      FORGET_DECIDE_OPERATION,
      FORGET_DECIDE_OPERATION,
    ])
    expect(calls.staged.map((batch) => batch.length)).toEqual([12, 1])
    expect(calls.usage).toEqual([
      expect.objectContaining({ operation: FORGET_DECIDE_OPERATION, model: FAKE_DECIDE_MODEL }),
      expect.objectContaining({ operation: FORGET_DECIDE_OPERATION, model: FAKE_DECIDE_MODEL }),
    ])
    expect(mockReserve).toHaveBeenCalledTimes(2)
    expect(mockRelease).toHaveBeenCalledTimes(2)
    // pre-check plus one authoritative read per batch
    expect(calls.optIn).toBe(3)
  })

  it('stops before sending when the tenant opts out mid-run', async () => {
    const gateway = createFakeGateway()
    const { repo: r, calls } = repo({ optIn: [true, false], candidates: candidates(2) })
    const result = await runForgettingPass(USER, { gateway, repo: r, now: NOW })
    expect(result).toMatchObject({ stopped: 'opted-out', items: 2, batches: 0 })
    expect(gateway.calls.decide).toEqual([])
    expect(calls.staged).toEqual([])
  })

  it('stops without a fallback when no judgment gateway is configured', async () => {
    const fake = createFakeGateway()
    const gateway: Gateway = {
      ...fake,
      decide: () => Promise.reject(new NotImplementedError('decide')),
    }
    const { repo: r, calls } = repo()
    const result = await runForgettingPass(USER, { gateway, repo: r, now: NOW })
    expect(result).toMatchObject({ stopped: 'no-gateway', batches: 0 })
    expect(fake.calls.complete).toEqual([])
    expect(calls.usage).toEqual([])
  })

  it('stops at a refused reservation instead of billing past the cap', async () => {
    mockReserve.mockResolvedValueOnce({ allowed: true, reservationId: 'res' } as never)
    mockReserve.mockResolvedValueOnce({ allowed: false } as never)
    const gateway = createFakeGateway()
    const { repo: r, calls } = repo({ candidates: candidates(13) })
    const result = await runForgettingPass(USER, { gateway, repo: r, budget, now: NOW })
    expect(result).toMatchObject({ stopped: 'budget', batches: 1, staged: 12 })
    expect(gateway.calls.decide).toHaveLength(1)
    expect(calls.staged).toHaveLength(1)
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('releases the reservation when it stops on an opt-out or a missing gateway', async () => {
    mockReserve.mockResolvedValue({ allowed: true, reservationId: 'res' } as never)
    const optedOut = repo({ optIn: [true, false] })
    await runForgettingPass(USER, {
      gateway: createFakeGateway(),
      repo: optedOut.repo,
      budget,
      now: NOW,
    })
    const fake = createFakeGateway()
    const noGateway: Gateway = {
      ...fake,
      decide: () => Promise.reject(new NotImplementedError('decide')),
    }
    await runForgettingPass(USER, { gateway: noGateway, repo: repo().repo, budget, now: NOW })
    expect(mockRelease).toHaveBeenCalledTimes(2)
  })

  it('still sends when the reservation lookup fails open, and has nothing to release', async () => {
    mockReserve.mockRejectedValue(new Error('budget store down'))
    const gateway = createFakeGateway()
    const result = await runForgettingPass(USER, { gateway, repo: repo().repo, budget, now: NOW })
    expect(result).toMatchObject({ batches: 1 })
    expect(gateway.calls.decide).toHaveLength(1)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('keeps the verdicts when recording usage fails', async () => {
    const gateway = createFakeGateway()
    const { repo: r, calls } = repo()
    r.recordUsage = () => Promise.reject(new NotImplementedError('usage'))
    const result = await runForgettingPass(USER, { gateway, repo: r, now: NOW })
    expect(result).toMatchObject({ batches: 1, staged: 1 })
    expect(result.stopped).toBeUndefined()
    expect(calls.staged).toHaveLength(1)
  })

  it('propagates any other gateway error, keeping the batches already staged', async () => {
    const fake = createFakeGateway()
    let call = 0
    const gateway: Gateway = {
      ...fake,
      decide: (request, operation) => {
        call += 1
        return call === 1
          ? fake.decide(request, operation)
          : Promise.reject(new Error('gateway 503'))
      },
    }
    const { repo: r, calls } = repo({ candidates: candidates(13) })
    await expect(runForgettingPass(USER, { gateway, repo: r, now: NOW })).rejects.toThrow(
      'gateway 503',
    )
    expect(calls.staged).toHaveLength(1)
  })
})
