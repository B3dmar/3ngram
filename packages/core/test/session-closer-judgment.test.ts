// SPDX-License-Identifier: Apache-2.0
// Session closer, typed-judgment pass (issue #229): no database, no network.
//
// Pinned here:
//   - only an OPTED-IN tenant's pass calls decide(); everyone else keeps complete();
//   - one Noul per briefed commitment, the excerpt fenced as untrusted data;
//   - p >= CLOSER_RESOLVE_PROBABILITY resolves, anything below changes nothing;
//   - no judgment gateway (typed NotImplementedError) falls back to complete();
//   - the judgment call is metered under its own operation and recorded unpriced;
//   - the pre-dispatch epoch fence holds on this path too.
import {
  createFakeGateway,
  type DecideAnswer,
  FAKE_DEFAULT_PROBABILITY,
  NotImplementedError,
} from '@3ngram/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@3ngram/db', () => ({ reserveBudget: vi.fn(), releaseReservation: vi.fn() }))

import { releaseReservation, reserveBudget } from '@3ngram/db'
import {
  CLOSER_OPERATION,
  type CloserSessionInput,
  type CloserUsage,
  closeSessionRun,
  type SessionCloserRepo,
} from '../src/admin/session-closer.js'
import {
  CLOSER_DECIDE_OPERATION,
  CLOSER_RESOLVE_PROBABILITY,
  renderCloserJudgment,
  selectByJudgment,
} from '../src/admin/session-closer-judgment.js'
import type { BudgetEnforcement } from '../src/budget/index.js'

const mockReserve = vi.mocked(reserveBudget)
const mockRelease = vi.mocked(releaseReservation)
mockRelease.mockResolvedValue(undefined)
afterEach(() => {
  mockReserve.mockReset()
  mockRelease.mockClear()
})

const USER = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const MEM_A = '33333333-3333-4333-8333-333333333333'
const MEM_B = '44444444-4444-4444-8444-444444444444'
const BRIEFED = [
  { id: MEM_A, topic: 'ship the closer', status: 'open' },
  { id: MEM_B, topic: 'write the migration', status: 'open' },
]
const REQUEST = { sessionRunId: RUN, activationEpoch: 3 }
const OPTIONS = { newAttemptId: () => 'attempt-1', now: new Date(0), isLastAttempt: true }

function session(overrides: Partial<CloserSessionInput> = {}): CloserSessionInput {
  return {
    sessionRunId: RUN,
    activationEpoch: 3,
    triageStatus: 'idle',
    triageAttemptId: null,
    lastTriagedEventIds: [],
    briefedMemories: BRIEFED,
    lastMessageExcerpt: 'Shipped the closer. The migration is still open.',
    project: '3ngram',
    scope: 'work',
    closedAt: new Date('2026-08-23T12:00:00.000Z'),
    ...overrides,
  }
}

function repo(judgment: boolean, overrides: Partial<SessionCloserRepo> = {}) {
  const resolved: string[] = []
  const usages: CloserUsage[] = []
  const r: SessionCloserRepo = {
    readSession: async () => session(),
    listEvents: async () => ({ items: [{ id: 'e1', eventKind: 'create' }], truncated: false }),
    claim: async () => true,
    resolve: async (_u, memoryId) => {
      resolved.push(memoryId)
      return 'resolved'
    },
    finish: async () => true,
    recordUsage: async (_u, usage) => {
      usages.push(usage)
    },
    currentEpoch: async () => 3,
    recordFailure: async () => undefined,
    isJudgmentEnabled: async () => judgment,
    ...overrides,
  }
  return { repo: r, resolved, usages }
}

const noul = (probability: number): DecideAnswer => ({ type: 'noul', probability })

describe('renderCloserJudgment', () => {
  it('asks one positional Noul per briefed commitment with framed criteria', () => {
    const request = renderCloserJudgment({
      briefed: BRIEFED,
      eventKinds: ['create'],
      fencedExcerpt: '```json\n"x"\n```',
    })
    expect(Object.keys(request.questions)).toEqual(['c0', 'c1'])
    const q = request.questions.c0
    expect(q?.type).toBe('noul')
    expect(q?.instructions).toContain(JSON.stringify('ship the closer'))
    if (q?.type !== 'noul') throw new Error('expected noul')
    expect(q.criteria?.false).toMatch(/assertion of completion alone is\s+not evidence/)
    expect(request.state).toMatch(/untrusted data/)
    expect(request.state).toContain('```json\n"x"\n```')
    expect(request.state).toContain('Write kinds recorded for this run: create')
  })
})

describe('selectByJudgment', () => {
  it('resolves only at or above the threshold and fails closed on a missing answer', () => {
    expect(
      selectByJudgment({ c0: noul(CLOSER_RESOLVE_PROBABILITY), c1: noul(0.89) }, BRIEFED).resolve,
    ).toEqual([MEM_A])
    expect(selectByJudgment({ c1: noul(0.99) }, BRIEFED).resolve).toEqual([MEM_B])
    expect(selectByJudgment({}, BRIEFED).resolve).toEqual([])
  })
})

describe('closeSessionRun — typed judgment for opted-in tenants (issue #229)', () => {
  it('calls decide(), resolves only p >= HIGH, and never calls complete()', async () => {
    const gateway = createFakeGateway({
      decisions: { [CLOSER_DECIDE_OPERATION]: { c0: noul(0.97), c1: noul(0.6) } },
    })
    const r = repo(true)
    const result = await closeSessionRun(r.repo, USER, REQUEST, { ...OPTIONS, gateway })
    expect(gateway.calls.decide).toHaveLength(1)
    expect(gateway.calls.complete).toHaveLength(0)
    expect(r.resolved).toEqual([MEM_A])
    expect(result).toMatchObject({ candidates: 1, rejected: 0, resolved: 1 })
    // Excerpt reaches the state only inside the fence; topics only inside questions.
    const sent = gateway.calls.decide[0]?.request
    expect(sent?.state).toContain('```json')
    expect(sent?.state).not.toContain('ship the closer')
  })

  it('records usage under the judgment operation, unpriced', async () => {
    const r = repo(true)
    await closeSessionRun(r.repo, USER, REQUEST, { ...OPTIONS, gateway: createFakeGateway() })
    expect(r.usages).toHaveLength(1)
    expect(r.usages[0]).toMatchObject({ operation: CLOSER_DECIDE_OPERATION, costUsd: null })
  })

  it('resolves nothing on the fake default, which is deliberately low', async () => {
    expect(FAKE_DEFAULT_PROBABILITY).toBeLessThan(CLOSER_RESOLVE_PROBABILITY)
    const r = repo(true)
    const result = await closeSessionRun(r.repo, USER, REQUEST, {
      ...OPTIONS,
      gateway: createFakeGateway(),
    })
    expect(r.resolved).toEqual([])
    expect(result.resolved).toBe(0)
  })

  it('keeps complete() for an opted-out tenant', async () => {
    const gateway = createFakeGateway({
      completions: { [CLOSER_OPERATION]: JSON.stringify({ completed: [MEM_B] }) },
    })
    const r = repo(false)
    await closeSessionRun(r.repo, USER, REQUEST, { ...OPTIONS, gateway })
    expect(gateway.calls.decide).toHaveLength(0)
    expect(gateway.calls.complete).toHaveLength(1)
    expect(r.resolved).toEqual([MEM_B])
  })

  it('falls back to complete() when no judgment gateway is configured', async () => {
    const base = createFakeGateway({
      completions: { [CLOSER_OPERATION]: JSON.stringify({ completed: [MEM_B] }) },
    })
    const gateway = { ...base, decide: () => Promise.reject(new NotImplementedError('decide')) }
    mockReserve.mockResolvedValue({ allowed: true, reservationId: 'res' } as never)
    const budget: BudgetEnforcement = {
      resolveLimits: async () => ({}),
      config: { defaultCapUsd: 10, defaultWindowDays: 30 },
    }
    const r = repo(true)
    await closeSessionRun(r.repo, USER, REQUEST, { ...OPTIONS, gateway, budget })
    expect(base.calls.complete).toHaveLength(1)
    expect(r.resolved).toEqual([MEM_B])
    expect(r.usages.map((u) => u.operation)).toEqual([CLOSER_OPERATION])
    // Each path reserved and released its own slot; the judgment slot billed nothing.
    expect(mockReserve).toHaveBeenCalledTimes(2)
    expect(mockRelease).toHaveBeenCalledTimes(2)
  })

  it('propagates any other decide() failure (the backoff path), without a fallback', async () => {
    const base = createFakeGateway()
    const gateway = { ...base, decide: () => Promise.reject(new Error('jev is down')) }
    const r = repo(true)
    await expect(closeSessionRun(r.repo, USER, REQUEST, { ...OPTIONS, gateway })).rejects.toThrow(
      'jev is down',
    )
    expect(base.calls.complete).toHaveLength(0)
    expect(r.resolved).toEqual([])
  })

  it('fences before dispatch when the epoch moved', async () => {
    const gateway = createFakeGateway()
    const r = repo(true, { currentEpoch: async () => 4 })
    const result = await closeSessionRun(r.repo, USER, REQUEST, { ...OPTIONS, gateway })
    expect(result.skipped).toBe('fenced')
    expect(gateway.calls.decide).toHaveLength(0)
  })

  it('does not read the opt-in for a run with nothing briefed', async () => {
    const isJudgmentEnabled = vi.fn(async () => true)
    const r = repo(true, {
      readSession: async () => session({ briefedMemories: [] }),
      isJudgmentEnabled,
    })
    await closeSessionRun(r.repo, USER, REQUEST, { ...OPTIONS, gateway: createFakeGateway() })
    expect(isJudgmentEnabled).not.toHaveBeenCalled()
  })
})
