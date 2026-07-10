// SPDX-License-Identifier: Apache-2.0
// Unit — budget gate policy. The db layer is MOCKED so this stays a fast offline
// unit test: we assert the POLICY, not the DB (that is the integration tests' job).
//
// Covered:
//   - read-only assertWithinBudget: fail-open on lookup error, over/under
//     cap, override-wins, config-default fallback, unregistered op fail-closed,
//     and UNPRICED usage charged a fallback so it still accrues.
//   - atomic reserveBudgetSlot: allowed → handle, over → BudgetExceededError,
//     lookup error → fail-open empty handle + alert (P1 path).
import { LlmOperationNotRegisteredError } from '@3ngram/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@3ngram/db', () => ({
  getBudgetAccounting: vi.fn(),
  reserveBudget: vi.fn(),
  releaseReservation: vi.fn(),
}))

import { getBudgetAccounting, reserveBudget } from '@3ngram/db'
import {
  assertWithinBudget,
  type BudgetEnforcement,
  BudgetExceededError,
  reserveBudgetSlot,
} from '../src/budget/index.js'

const mockGet = vi.mocked(getBudgetAccounting)
const mockReserve = vi.mocked(reserveBudget)

function enforcement(overrides: Partial<BudgetEnforcement> = {}): BudgetEnforcement {
  return {
    resolveLimits: async () => ({}),
    config: { defaultCapUsd: 10, defaultWindowDays: 30 },
    ...overrides,
  }
}

const accounting = (
  consumedUsd: number,
  tierCapUsd: number | null,
  capUsdOverride: number | null,
  extra: { unpricedCount?: number; reservationsUsd?: number } = {},
) => ({
  capUsdOverride,
  tierCapUsd,
  consumedUsd,
  unpricedCount: extra.unpricedCount ?? 0,
  reservationsUsd: extra.reservationsUsd ?? 0,
  periodStart: null,
  periodEnd: null,
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('assertWithinBudget (read-only pre-check)', () => {
  it('fails OPEN and fires the alert hook when the consumption lookup errors (SC-008)', async () => {
    mockGet.mockRejectedValueOnce(new Error('usage store unreachable'))
    const onLookupFailure = vi.fn()

    await expect(
      assertWithinBudget(enforcement({ onLookupFailure }), 'user-1', 'memory.embed'),
    ).resolves.toBeUndefined()

    expect(onLookupFailure).toHaveBeenCalledTimes(1)
    expect(onLookupFailure).toHaveBeenCalledWith('memory.embed')
  })

  it('rejects with BudgetExceededError when the next op would cross the cap', async () => {
    mockGet.mockResolvedValueOnce(accounting(1, 1, null))
    const onLookupFailure = vi.fn()

    await expect(
      assertWithinBudget(enforcement({ onLookupFailure }), 'user-1', 'memory.embed'),
    ).rejects.toBeInstanceOf(BudgetExceededError)
    expect(onLookupFailure).not.toHaveBeenCalled()
  })

  it('allows the op when comfortably under the cap', async () => {
    mockGet.mockResolvedValueOnce(accounting(0, 1000, null))
    await expect(
      assertWithinBudget(enforcement(), 'user-1', 'memory.embed'),
    ).resolves.toBeUndefined()
  })

  it('honours a per-user override above the tier cap', async () => {
    mockGet.mockResolvedValueOnce(accounting(5, 1, 1000))
    await expect(
      assertWithinBudget(enforcement(), 'user-1', 'memory.embed'),
    ).resolves.toBeUndefined()
  })

  it('falls back to config.defaultCapUsd when neither override nor tier cap apply', async () => {
    mockGet.mockResolvedValueOnce(accounting(10, null, null))
    await expect(
      assertWithinBudget(enforcement(), 'user-1', 'memory.embed'),
    ).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('charges UNPRICED usage a fallback so it still trips the cap (P2)', async () => {
    // Zero priced spend, but many unpriced rows under a tiny cap → the fallback
    // charge pushes consumed over the cap, so the op is rejected.
    mockGet.mockResolvedValueOnce(accounting(0, 0.001, null, { unpricedCount: 1000 }))
    await expect(
      assertWithinBudget(enforcement(), 'user-1', 'memory.embed'),
    ).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('fails CLOSED on an unregistered operation (a config error, never fail-open)', async () => {
    const onLookupFailure = vi.fn()
    await expect(
      assertWithinBudget(enforcement({ onLookupFailure }), 'user-1', 'not.a.real.op'),
    ).rejects.toBeInstanceOf(LlmOperationNotRegisteredError)
    expect(mockGet).not.toHaveBeenCalled()
    expect(onLookupFailure).not.toHaveBeenCalled()
  })
})

describe('reserveBudgetSlot (atomic seam gate, P1)', () => {
  it('returns a reservation handle when the atomic reserve is allowed', async () => {
    mockReserve.mockResolvedValueOnce({ allowed: true, reservationId: 'res-1' })
    const handle = await reserveBudgetSlot(enforcement(), 'user-1', 'search')
    expect(handle.reservationId).toBe('res-1')
  })

  it('rejects with BudgetExceededError when the atomic reserve is denied', async () => {
    mockReserve.mockResolvedValueOnce({ allowed: false })
    await expect(reserveBudgetSlot(enforcement(), 'user-1', 'search')).rejects.toBeInstanceOf(
      BudgetExceededError,
    )
  })

  it('fails OPEN (empty handle + alert) when the reserve lookup errors', async () => {
    mockReserve.mockRejectedValueOnce(new Error('lock timeout'))
    const onLookupFailure = vi.fn()
    const handle = await reserveBudgetSlot(enforcement({ onLookupFailure }), 'user-1', 'search')
    expect(handle.reservationId).toBeUndefined()
    expect(onLookupFailure).toHaveBeenCalledWith('search')
  })
})
