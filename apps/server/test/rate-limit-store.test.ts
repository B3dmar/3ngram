// SPDX-License-Identifier: Apache-2.0
// resolveRateLimitStore (#315): the boot-time store choice, including the
// defence-in-depth refusal of an implicit in-memory store in production.
import type { Redis } from 'ioredis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = {
  nodeEnv: 'test',
  store: { kind: 'memory', explicit: false } as { kind: string; explicit: boolean },
}
const warn = vi.fn()
vi.mock('@3ngram/config', () => ({
  loadEnv: () => ({ NODE_ENV: state.nodeEnv }),
  loadRateLimitStoreConfig: () => state.store,
  log: () => ({ warn, info: vi.fn(), error: vi.fn() }),
}))
const resolveRedis = vi.fn()
vi.mock('../src/redis.js', () => ({ resolveRedis: () => resolveRedis() }))

const { MemoryRateLimitStoreInProductionError, resolveRateLimitStore } = await import(
  '../src/rate-limit-store.js'
)

function given(nodeEnv: string, kind: string, explicit: boolean): void {
  state.nodeEnv = nodeEnv
  state.store = { kind, explicit }
}

afterEach(() => vi.clearAllMocks())

describe('resolveRateLimitStore', () => {
  it('refuses an implicit memory store in production', () => {
    given('production', 'memory', false)
    expect(() => resolveRateLimitStore(undefined)).toThrow(MemoryRateLimitStoreInProductionError)
  })

  it('allows explicit memory in production with a boot warning', () => {
    given('production', 'memory', true)
    expect(resolveRateLimitStore(undefined)).toEqual({ kind: 'memory' })
    expect(warn).toHaveBeenCalledWith(
      { store: 'memory' },
      'rate-limit: in-memory store in production (per-replica buckets; single replica only)',
    )
  })

  it('selects postgres without dialling Redis', () => {
    given('production', 'postgres', true)
    expect(resolveRateLimitStore(undefined)).toEqual({ kind: 'postgres' })
    expect(resolveRedis).not.toHaveBeenCalled()
  })

  it('reuses the passed Redis client for the redis store', () => {
    given('production', 'redis', false)
    const client = {} as Redis
    expect(resolveRateLimitStore(client)).toEqual({ kind: 'redis', client })
    expect(resolveRedis).not.toHaveBeenCalled()
  })

  it('returns memory for an implicit store outside production', () => {
    given('test', 'memory', false)
    expect(resolveRateLimitStore(undefined)).toEqual({ kind: 'memory' })
    expect(warn).not.toHaveBeenCalled()
  })
})
