// SPDX-License-Identifier: Apache-2.0
// The closer's gateway + budget builder, shared by the resident worker and the
// one-shot session-sweep. The regression this pins: the one-shot build once
// dropped the Jev judgment gateway, so decide() never reached Jev on a cron
// schedule. Pure: no Redis, no database, no network.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const warn = vi.fn()
const config = {
  llm: undefined as undefined | { url: string },
  jev: undefined as undefined | { model: string },
}

vi.mock('@3ngram/config', () => ({
  log: () => ({ info: vi.fn(), warn, error: vi.fn() }),
  loadLlmGatewayConfig: () => config.llm,
  loadJevGatewayConfig: () => config.jev,
  loadBudgetConfig: () => ({ defaultCapUsd: 5, defaultWindowDays: 30 }),
}))
vi.mock('@3ngram/core', () => ({ SELFHOST_LIMITS: { tier: 'selfhost' } }))
vi.mock('@3ngram/llm', async (importActual) => {
  const actual = await importActual<typeof import('@3ngram/llm')>()
  return {
    composeGateway: actual.composeGateway,
    createOpenAIGateway: vi.fn(() => ({
      embed: vi.fn(),
      complete: vi.fn(async () => 'base'),
      decide: vi.fn(async () => {
        throw new Error('base has no decide')
      }),
    })),
    createJevGateway: vi.fn(() => ({ decide: vi.fn(async () => 'jev') })),
  }
})

const { buildCloserDeps } = await import('../src/closer-deps.js')

describe('buildCloserDeps', () => {
  beforeEach(() => {
    config.llm = undefined
    config.jev = undefined
    warn.mockClear()
  })

  it('returns no gateway without LLM config, so every pass reports no-gateway', () => {
    expect(buildCloserDeps().gateway).toBeUndefined()
  })

  it('uses the base gateway alone when Jev is not configured', async () => {
    config.llm = { url: 'https://llm.example' }
    const { gateway } = buildCloserDeps()
    expect(await gateway?.complete('p', 'op' as never)).toBe('base')
    await expect(gateway?.decide({} as never, 'op' as never)).rejects.toThrow('base has no decide')
  })

  it('routes decide() to Jev when both gateways are configured', async () => {
    config.llm = { url: 'https://llm.example' }
    config.jev = { model: 'jev-1.14.0' }
    const { gateway } = buildCloserDeps()
    expect(await gateway?.decide({} as never, 'op' as never)).toBe('jev')
    expect(await gateway?.complete('p', 'op' as never)).toBe('base')
  })

  it('warns and returns no gateway when Jev is set without the LLM gateway', () => {
    config.jev = { model: 'jev-1.14.0' }
    expect(buildCloserDeps().gateway).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('caps the closer with the self-host limits and the configured budget', async () => {
    const { budget } = buildCloserDeps()
    expect(await budget.resolveLimits('u1' as never)).toEqual({ tier: 'selfhost' })
    expect(budget.config).toEqual({ defaultCapUsd: 5, defaultWindowDays: 30 })
  })
})
