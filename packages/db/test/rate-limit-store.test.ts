// SPDX-License-Identifier: Apache-2.0
// Unit lane: the Postgres rate-limit store's wiring, with no database. The
// integration lane (test/integration/rate-limit-store.int.test.ts) proves the
// queries against the real table as the runtime role.
import type { RateLimiterAbstract } from 'rate-limiter-flexible'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPostgresRateLimiter,
  RATE_LIMIT_TABLE,
  resetRateLimitSweeperClaim,
  unnamedQueryClient,
} from '../src/rate-limit-store.js'

// The library's own fields, not part of its public typings.
interface PgLimiterInternals {
  clearExpiredByTimeout: boolean
  tableCreated: boolean
  tableName: string
  clientType: string
  _clearExpiredTimeoutId?: ReturnType<typeof setTimeout>
}
const internals = (l: RateLimiterAbstract) => l as unknown as PgLimiterInternals

const created: RateLimiterAbstract[] = []
function make(keyPrefix: string): RateLimiterAbstract {
  const l = createPostgresRateLimiter({ points: 5, duration: 60, keyPrefix })
  created.push(l)
  return l
}

afterEach(() => {
  for (const l of created.splice(0)) clearTimeout(internals(l)._clearExpiredTimeoutId)
  resetRateLimitSweeperClaim()
})

describe('unnamedQueryClient', () => {
  it('forwards text and values and drops the statement name', async () => {
    const seen: unknown[] = []
    const handle = { query: async (q: unknown) => (seen.push(q), { rows: [] }) }
    const wrapped = unnamedQueryClient(() => handle)
    await wrapped.query({ name: 'rate_limits:rlflx-upsert', text: 'SELECT $1', values: [1] })
    expect(seen).toEqual([{ text: 'SELECT $1', values: [1] }])
  })

  it('resolves the handle per query, so a replaced pool is picked up', async () => {
    const getHandle = vi.fn(() => ({ query: async () => ({ rows: [] }) }))
    const wrapped = unnamedQueryClient(getHandle)
    expect(getHandle).not.toHaveBeenCalled()
    await wrapped.query({ text: 'SELECT 1' })
    await wrapped.query({ text: 'SELECT 1' })
    expect(getHandle).toHaveBeenCalledTimes(2)
  })
})

describe('createPostgresRateLimiter', () => {
  it('targets the migration-owned table with no runtime DDL', () => {
    const l = internals(make('a'))
    expect(l.tableName).toBe(RATE_LIMIT_TABLE)
    expect(l.tableCreated).toBe(true)
    expect(l.clientType).toBe('pool')
  })

  it('only the first limiter per process runs the expired-row sweeper', () => {
    const first = internals(make('a'))
    const second = internals(make('b'))
    expect(first.clearExpiredByTimeout).toBe(true)
    expect(first._clearExpiredTimeoutId).toBeDefined()
    expect(second.clearExpiredByTimeout).toBe(false)
    expect(second._clearExpiredTimeoutId).toBeUndefined()
  })

  it('has no in-memory insurance fallback', () => {
    expect(make('a').insuranceLimiter).toBeUndefined()
  })
})
