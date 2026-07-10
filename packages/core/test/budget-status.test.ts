// SPDX-License-Identifier: Apache-2.0
// Unit — getBudgetStatus read policy. The db layer is
// MOCKED: we assert the READ shape — effective-cap resolution and the resolved
// tier/window that drive the accounting read:
//   - self-host (empty limits): the tier is undefined, so the plan lookup is
//     skipped and the effective cap falls through to the config default.
//   - hosted (resolved tier): the resolved tier drives the accounting read.
//   - the read does NOT fail open: a lookup error propagates to the transport.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@3ngram/db', () => ({
  getBudgetAccounting: vi.fn(),
  reserveBudget: vi.fn(),
  releaseReservation: vi.fn(),
}))

import { getBudgetAccounting } from '@3ngram/db'
import {
  type BudgetEnforcement,
  getBudgetStatus,
  type LimitsResolver,
} from '../src/budget/index.js'

const mockGet = vi.mocked(getBudgetAccounting)

const enforcement = (resolveLimits: LimitsResolver): BudgetEnforcement => ({
  resolveLimits,
  config: { defaultCapUsd: 10, defaultWindowDays: 30 },
})

const accounting = {
  capUsdOverride: null,
  tierCapUsd: 25,
  consumedUsd: 3,
  unpricedCount: 0,
  reservationsUsd: 0,
  periodStart: null,
  periodEnd: null,
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('getBudgetStatus', () => {
  it('self-host (empty limits): resolves an undefined tier for the accounting read', async () => {
    mockGet.mockResolvedValueOnce(accounting)
    await getBudgetStatus(
      enforcement(async () => ({})),
      'user-1',
    )
    expect(mockGet).toHaveBeenCalledWith('user-1', undefined, 30)
  })

  it('hosted (resolved tier): the resolved tier + window reach the db read', async () => {
    mockGet.mockResolvedValueOnce(accounting)
    await getBudgetStatus(
      enforcement(async () => ({ tier: 'pro', windowDays: 7 })),
      'user-1',
    )
    expect(mockGet).toHaveBeenCalledWith('user-1', 'pro', 7)
  })

  it('keeps the budget fields intact (tier cap in force)', async () => {
    mockGet.mockResolvedValueOnce(accounting)
    const status = await getBudgetStatus(
      enforcement(async () => ({ tier: 'pro' })),
      'user-1',
    )
    expect(status).toMatchObject({
      effectiveCapUsd: 25,
      consumedUsd: 3,
      capUsdOverride: null,
    })
  })

  it('does NOT fail open: a lookup error propagates to the transport', async () => {
    mockGet.mockRejectedValueOnce(new Error('usage store unreachable'))
    await expect(
      getBudgetStatus(
        enforcement(async () => ({})),
        'user-1',
      ),
    ).rejects.toThrow('usage store unreachable')
  })
})
