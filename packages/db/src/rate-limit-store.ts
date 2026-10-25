// SPDX-License-Identifier: Apache-2.0
// Postgres store for rate-limiter-flexible (#315): counters in the
// migration-owned `rate_limits` system table (schema/ops.ts), so limits hold
// across replicas without Redis. The pool never leaves this package.
import { type RateLimiterAbstract, RateLimiterPostgres } from 'rate-limiter-flexible'
import { getPool } from './client.js'

export const RATE_LIMIT_TABLE = 'rate_limits'

export interface PostgresRateLimiterOptions {
  points: number
  /** Window length in seconds. */
  duration: number
  keyPrefix: string
}

interface QueryHandle {
  query: (q: { text: string; values?: unknown[] }) => Promise<unknown>
}

/**
 * Wrap a query handle so every statement reaches pg UNNAMED. rlflx names each
 * statement (`rate_limits:rlflx-upsert`), and named prepared statements break
 * behind a transaction-mode pooler without protocol-level prepared-statement
 * support. Unnamed extended-protocol queries are still one round trip.
 * `getHandle` runs per query because closeDb() replaces the pool.
 *
 * @internal exported for tests
 */
export function unnamedQueryClient(getHandle: () => QueryHandle) {
  return {
    query: (q: { text: string; values?: unknown[]; name?: string }) =>
      getHandle().query({ text: q.text, values: q.values }),
  }
}

let sweeperClaimed = false

/**
 * A fixed-window limiter over `rate_limits`. The table is created by migration
 * 0039 (tableCreated: true, no runtime DDL). The table is shared, so only the
 * first limiter per process runs the library's expired-row sweep (one DELETE
 * every 5 min per replica, errors swallowed by the library). No
 * insuranceLimiter: a silent in-memory fallback would split limits per replica.
 */
export function createPostgresRateLimiter(opts: PostgresRateLimiterOptions): RateLimiterAbstract {
  const claim = !sweeperClaimed
  sweeperClaimed = true
  return new RateLimiterPostgres({
    points: opts.points,
    duration: opts.duration,
    keyPrefix: opts.keyPrefix,
    storeClient: unnamedQueryClient(getPool),
    storeType: 'pool',
    tableName: RATE_LIMIT_TABLE,
    tableCreated: true,
    clearExpiredByTimeout: claim,
  })
}

/** @internal test seam: let the next limiter claim the sweeper again. */
export function resetRateLimitSweeperClaim(): void {
  sweeperClaimed = false
}
