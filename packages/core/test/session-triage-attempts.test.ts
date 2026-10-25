// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. getSessionTriageAttempts() owns ONE domain invariant: the
// `truncated` flag ("the list is not the whole denominator") is derived from
// the row's true attempt count against the bounded log it kept (issue #307 —
// the REST router test mocks this function, so nothing else pins it). The
// #166 ignore-rate metric reads this flag to decide whether a run's nudge
// history is complete. Real-Postgres coverage of the legacy backfill that
// produces a count-over-empty-log row lives in
// packages/db/test/integration/session-triage-backfill.int.test.ts.
import type { AgentSessionRunRead } from '@3ngram/db'
import type { TriageAttemptLogEntry } from '@3ngram/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

const readAgentSessionRun = vi.fn()

vi.mock('@3ngram/db', () => ({
  readAgentSessionRun: (...a: unknown[]) => readAgentSessionRun(...a),
  withTenant: (_userId: string, fn: (tx: unknown) => unknown) => fn({}),
  UnknownSessionRunError: class UnknownSessionRunError extends Error {
    readonly sessionRunId: string
    constructor(sessionRunId: string) {
      super('unknown session run')
      this.name = 'UnknownSessionRunError'
      this.sessionRunId = sessionRunId
    }
  },
}))

const { UnknownSessionRunError } = await import('@3ngram/db')
const { getSessionTriageAttempts } = await import('../src/session/lifecycle.js')

const USER = '00000000-0000-7000-8000-000000000001'
const RUN = '00000000-0000-7000-8000-0000000000a1'

function entry(n: number): TriageAttemptLogEntry {
  return {
    attemptId: `00000000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
    armedAt: `2026-10-0${n}T10:00:00.000Z`,
    finalizedAt: `2026-10-0${n}T10:00:05.000Z`,
    outcome: 'completed',
  }
}

/** Only the three fields the derivation reads are meaningful; the rest is filler. */
function row(log: TriageAttemptLogEntry[], count: number): AgentSessionRunRead {
  return {
    id: RUN,
    triageStatus: 'pending',
    triageAttemptLog: log,
    triageAttemptCount: count,
  } as unknown as AgentSessionRunRead
}

afterEach(() => {
  readAgentSessionRun.mockReset()
})

describe('getSessionTriageAttempts', () => {
  it('reports an exact history when the count equals the kept log', async () => {
    const log = [entry(1), entry(2)]
    readAgentSessionRun.mockResolvedValue(row(log, 2))

    await expect(getSessionTriageAttempts(USER, RUN)).resolves.toEqual({
      sessionRunId: RUN,
      items: log,
      count: 2,
      truncated: false,
    })
    expect(readAgentSessionRun.mock.calls[0]?.slice(1)).toEqual([USER, RUN])
  })

  it('reports truncated when the cap trimmed older entries (count > log length)', async () => {
    const log = [entry(2), entry(3)]
    readAgentSessionRun.mockResolvedValue(row(log, 3))

    const result = await getSessionTriageAttempts(USER, RUN)

    expect(result.count).toBe(3)
    expect(result.items).toEqual(log)
    expect(result.truncated).toBe(true)
  })

  it('reports truncated for a legacy seed: count 1 over an empty log (migration 0037)', async () => {
    readAgentSessionRun.mockResolvedValue(row([], 1))

    await expect(getSessionTriageAttempts(USER, RUN)).resolves.toEqual({
      sessionRunId: RUN,
      items: [],
      count: 1,
      truncated: true,
    })
  })

  it('reports an exact empty history for a run that never armed (count 0)', async () => {
    readAgentSessionRun.mockResolvedValue(row([], 0))

    const result = await getSessionTriageAttempts(USER, RUN)

    expect(result).toMatchObject({ items: [], count: 0, truncated: false })
  })

  it('fails with UnknownSessionRunError for an unknown or foreign run', async () => {
    readAgentSessionRun.mockResolvedValue(undefined)

    await expect(getSessionTriageAttempts(USER, RUN)).rejects.toBeInstanceOf(UnknownSessionRunError)
  })
})
