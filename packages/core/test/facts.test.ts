// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. getFacts()'s DEFAULT_FACTS_LIMIT default application and
// delegation through withTenant() to packages/db's getFacts, with packages/db
// mocked. Input validation (empty subject, invalid Date, etc.) is now the
// transport's responsibility (packages/schema factsQueryInputSchema — hard rule 2).
// Integration coverage (bi-temporal behavior, RLS) lives in packages/db
// test/integration/facts-read.int.test.ts against real Postgres.
import { afterEach, describe, expect, it, vi } from 'vitest'

const getFactsDb = vi.fn()
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
  fn({} as unknown),
)

vi.mock('@3ngram/db', () => ({
  getFacts: (...args: unknown[]) => getFactsDb(...args),
  withTenant: (userId: string, fn: (tx: unknown) => Promise<unknown>) => withTenant(userId, fn),
}))

const { getFacts } = await import('../src/read/facts.js')

afterEach(() => {
  getFactsDb.mockReset()
  withTenant.mockClear()
})

describe('getFacts — delegation', () => {
  it('runs inside withTenant(userId) and forwards the query to db.getFacts', async () => {
    getFactsDb.mockResolvedValue([{ value: 'engineer' }])
    const query = { subject: 'employee:42', predicate: 'role' }
    const rows = await getFacts('u1', query)
    expect(withTenant).toHaveBeenCalledWith('u1', expect.any(Function))
    // The query is forwarded with the no-firehose default limit injected.
    expect(getFactsDb).toHaveBeenCalledWith(expect.anything(), 'u1', { ...query, limit: 50 })
    expect(rows).toEqual([{ value: 'engineer' }])
  })

  it('defaults to a bounded list query when none is given (no-firehose)', async () => {
    getFactsDb.mockResolvedValue([])
    await getFacts('u1')
    // List mode (no filters) is bounded by the default limit, never unbounded.
    expect(getFactsDb).toHaveBeenCalledWith(expect.anything(), 'u1', { limit: 50 })
  })

  it('honours an explicit limit', async () => {
    getFactsDb.mockResolvedValue([])
    await getFacts('u1', { limit: 10 })
    expect(getFactsDb).toHaveBeenCalledWith(expect.anything(), 'u1', { limit: 10 })
  })
})
