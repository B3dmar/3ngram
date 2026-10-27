// SPDX-License-Identifier: Apache-2.0
// Forgetting pass across tenants: no database, no network. Pinned here:
// every tenant gets a pass, counts add up, one tenant's failure is counted
// without stopping the others, and a missing gateway ends the loop.
import { createFakeGateway } from '@3ngram/llm'
import { describe, expect, it, vi } from 'vitest'
import type { ForgettingPassResult } from '../src/admin/forgetting-pass.js'
import { forgetAllTenants } from '../src/admin/forgetting-sweep.js'

const pass = (over: Partial<ForgettingPassResult> = {}): ForgettingPassResult => ({
  items: 0,
  batches: 0,
  proposed: 0,
  dismissed: 0,
  skipped: 0,
  staged: 0,
  ...over,
})

describe('forgetAllTenants', () => {
  it('runs every tenant, sums the counts, and counts a failure without stopping', async () => {
    const outcomes: Record<string, () => Promise<ForgettingPassResult>> = {
      a: async () => pass({ batches: 1, proposed: 2, dismissed: 3, skipped: 1, staged: 5 }),
      b: async () => pass({ stopped: 'not-opted-in' }),
      c: async () => pass({ batches: 2, proposed: 1, staged: 1, stopped: 'budget' }),
      d: async () => {
        throw new TypeError('gateway 503')
      },
    }
    const runPass = vi.fn((userId: string) =>
      (outcomes[userId] as () => Promise<ForgettingPassResult>)(),
    )
    const result = await forgetAllTenants({
      gateway: createFakeGateway(),
      listTenantIds: async () => ['a', 'b', 'c', 'd'],
      runPass,
    })
    expect(runPass.mock.calls.map(([userId]) => userId)).toEqual(['a', 'b', 'c', 'd'])
    expect(result).toEqual({
      tenants: 4,
      judged: 2,
      stopped: { 'not-opted-in': 1, 'opted-out': 0, 'no-gateway': 0, budget: 1 },
      proposed: 3,
      dismissed: 3,
      skipped: 1,
      staged: 6,
      failed: 1,
      failedBy: { TypeError: 1 },
    })
  })

  it('ends the loop at the first missing gateway: it is deployment-wide', async () => {
    const runPass = vi.fn(async () => pass({ stopped: 'no-gateway' }))
    const result = await forgetAllTenants({
      gateway: createFakeGateway(),
      listTenantIds: async () => ['a', 'b', 'c'],
      runPass,
    })
    expect(runPass).toHaveBeenCalledTimes(1)
    expect(result.stopped['no-gateway']).toBe(1)
  })
})

describe('forgetAllTenants with no tenants', () => {
  it('returns zero counts without running a pass', async () => {
    const runPass = vi.fn()
    const result = await forgetAllTenants({
      gateway: createFakeGateway(),
      listTenantIds: async () => [],
      runPass,
    })
    expect(runPass).not.toHaveBeenCalled()
    expect(result).toMatchObject({ tenants: 0, judged: 0, failed: 0, failedBy: {} })
  })
})
