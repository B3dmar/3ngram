// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. completeAgentSessionTriage() is the one place the REST
// body becomes db options, so it owns forwarding `defensive` (issue #189): a
// dropped flag would silently restore the hole it closes (a defensive finalize
// absorbing a concurrent write as if a debrief had covered it). The rule itself
// is pinned against real Postgres in
// packages/db/test/integration/session-triage.int.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'

const completeSessionTriage = vi.fn()

vi.mock('@3ngram/db', () => ({
  completeSessionTriage: (...a: unknown[]) => completeSessionTriage(...a),
  withTenant: (_userId: string, fn: (tx: unknown) => unknown) => fn({}),
}))

const { completeAgentSessionTriage } = await import('../src/session/triage.js')

const USER = '00000000-0000-7000-8000-000000000001'
const ATTEMPT = '00000000-0000-7000-8000-0000000000a1'
const KEY = { agent: 'claude-code', sessionId: 'conv-abc' }
const NOW = new Date('2026-10-25T12:00:00.000Z')

afterEach(() => {
  completeSessionTriage.mockReset()
})

describe('completeAgentSessionTriage', () => {
  it('forwards defensive: true to the db rule', async () => {
    await completeAgentSessionTriage(
      USER,
      { ...KEY, attemptId: ATTEMPT, defensive: true },
      { now: NOW },
    )
    expect(completeSessionTriage).toHaveBeenCalledWith({}, USER, KEY, {
      attemptId: ATTEMPT,
      now: NOW,
      defensive: true,
    })
  })

  it('omits the option when the body omits it — the ordinary complete', async () => {
    await completeAgentSessionTriage(USER, { ...KEY, attemptId: ATTEMPT }, { now: NOW })
    expect(completeSessionTriage).toHaveBeenCalledWith({}, USER, KEY, {
      attemptId: ATTEMPT,
      now: NOW,
    })
  })
})
