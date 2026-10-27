// SPDX-License-Identifier: Apache-2.0
// Forgetting-pass job HARNESS: no database, no network. The policy lives in
// @3ngram/core (forgetting-sweep.test.ts); pinned here is only the wiring: no
// gateway is a logged no-op, the sweep gets the boot deps, and a tenant failure
// fails the job so BullMQ retries and the one-shot exits 1.
import { createFakeGateway } from '@3ngram/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const warn = vi.fn()
vi.mock('@3ngram/config', () => ({
  log: () => ({ info: vi.fn(), warn, error: vi.fn() }),
}))
vi.mock('@3ngram/core', () => ({ forgetAllTenants: vi.fn() }))

const { forgetAllTenants } = await import('@3ngram/core')
const { ForgettingPassFailedError, runForgettingPassJob } = await import(
  '../src/jobs/forgetting-pass.js'
)

const budget = {
  resolveLimits: async () => ({}),
  config: { defaultCapUsd: 5, defaultWindowDays: 30 },
}
const sweep = (failed: number) => ({
  tenants: 2,
  judged: 1,
  stopped: { 'not-opted-in': 1, 'opted-out': 0, 'no-gateway': 0, budget: 0 },
  proposed: 1,
  dismissed: 2,
  skipped: 0,
  staged: 3,
  failed,
  failedBy: failed > 0 ? { TypeError: failed } : {},
})

afterEach(() => {
  vi.mocked(forgetAllTenants).mockReset()
  warn.mockClear()
})

describe('runForgettingPassJob', () => {
  it('is a no-op without a gateway', async () => {
    await expect(runForgettingPassJob(undefined, budget as never)).resolves.toEqual({
      skipped: 'no-gateway',
    })
    expect(forgetAllTenants).not.toHaveBeenCalled()
  })

  it('runs the sweep with the boot gateway and budget', async () => {
    vi.mocked(forgetAllTenants).mockResolvedValue(sweep(0))
    const gateway = createFakeGateway()
    await expect(runForgettingPassJob(gateway, budget as never)).resolves.toEqual(sweep(0))
    expect(forgetAllTenants).toHaveBeenCalledWith({ gateway, budget })
  })

  it('fails the job when a tenant pass threw', async () => {
    vi.mocked(forgetAllTenants).mockResolvedValue(sweep(1))
    await expect(runForgettingPassJob(createFakeGateway(), budget as never)).rejects.toBeInstanceOf(
      ForgettingPassFailedError,
    )
  })
})

describe('runForgettingPassJob warnings', () => {
  it('warns when the pass found no judgment gateway', async () => {
    const noGateway = sweep(0)
    noGateway.stopped['no-gateway'] = 1
    vi.mocked(forgetAllTenants).mockResolvedValue(noGateway)
    await runForgettingPassJob(createFakeGateway(), budget as never)
    expect(warn).toHaveBeenCalledOnce()
  })
})
