// SPDX-License-Identifier: Apache-2.0
// Postgres store for rate-limiter-flexible (#315): counters in the
// migration-owned `rate_limits` system table (schema/ops.ts), so limits hold
// across replicas without Redis. The pool never leaves this package.
import { sql } from 'drizzle-orm'
import { type RateLimiterAbstract, RateLimiterPostgres } from 'rate-limiter-flexible'
import { getAdminDb, getPool } from './client.js'

export const RATE_LIMIT_TABLE = 'rate_limits'

export interface PostgresRateLimiterOptions {
  points: number
  /** Window length in seconds. */
  duration: number
  keyPrefix: string
}

interface QueryHandle {
  query: (q: { text: string; values?: unknown[] | undefined }) => Promise<unknown>
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
 * 0042 (tableCreated: true, no runtime DDL). The table is shared, so only the
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

// --- Sliding-window counter (#315) ---
// These share rate_limits with rate-limiter-flexible. Callers must use a key
// prefix no rlflx limiter uses (oauth-token uses 'oauth:exchange-failure:').
// The rlflx clear-expired sweeper removes expired counter rows too. Unlike the
// rlflx upsert (a fixed window), every increment slides `expire` forward,
// matching Redis INCR + EXPIRE. `expire` is epoch ms, as rlflx stores it.

const MAX_KEY_LENGTH = 255

function assertKey(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new RangeError(`rate_limits key exceeds ${MAX_KEY_LENGTH} chars`)
  }
}

/**
 * Atomically add one to `key` and slide its expiry to nowMs + ttlMs. A missing
 * or expired row restarts at 1. Returns the new count.
 */
export async function incrementWindowCounter(
  key: string,
  ttlMs: number,
  nowMs: number = Date.now(),
): Promise<number> {
  assertKey(key)
  const expire = nowMs + ttlMs
  const result = await getAdminDb().execute<{ points: number | string }>(
    sql`INSERT INTO rate_limits (key, points, expire) VALUES (${key}, 1, ${expire})
        ON CONFLICT (key) DO UPDATE SET
          points = CASE WHEN rate_limits.expire IS NULL OR rate_limits.expire <= ${nowMs}
                        THEN 1 ELSE rate_limits.points + 1 END,
          expire = ${expire}
        RETURNING points`,
  )
  return Number(result.rows[0]?.points)
}

/** The live count for `key`; 0 when the row is missing or expired. */
export async function readWindowCounter(key: string, nowMs: number = Date.now()): Promise<number> {
  assertKey(key)
  const result = await getAdminDb().execute<{ points: number | string }>(
    sql`SELECT points FROM rate_limits WHERE key = ${key} AND expire > ${nowMs}`,
  )
  const row = result.rows[0]
  return row ? Number(row.points) : 0
}

/** Remove the counter row for `key` (a no-op when absent). */
export async function deleteWindowCounter(key: string): Promise<void> {
  assertKey(key)
  await getAdminDb().execute(sql`DELETE FROM rate_limits WHERE key = ${key}`)
}
