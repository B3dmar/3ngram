// SPDX-License-Identifier: Apache-2.0
// Two-connection barrier harness for REAL concurrency tests (issue #178).
//
// The rule (docs/concepts/testing.mdx, hard rule 4): an interleaving is never
// picked by a sleep or by retrying until green. It is CONSTRUCTED:
//
//   1. a test transaction takes a conflicting lock and parks before commit
//      ({@link holdOpen});
//   2. the production call under test starts on its own pooled connection and
//      provably blocks on that lock — observed in `pg_locks`, scoped to this
//      database and, where the holder is known, to the exact blocking pid
//      ({@link waitForLockWait});
//   3. the test asserts the production call is still pending
//      ({@link assertPending}) and reads committed state from the owner pool;
//   4. it releases the holder and asserts the committed outcome.
//
// Every wait is bounded and throws a message naming what it expected and what it
// saw. Every held transaction is rolled back by {@link releaseHeld} (wire it into
// `afterEach`) so a failing assertion never leaves a connection parked inside an
// open transaction for the next test to queue behind.
//
// Each `withTenant` call checks out its own pooled runtime-role connection
// (client.ts), so the held transaction and the production call are genuinely
// two Postgres backends, under app_user and real RLS.
import { sql } from 'drizzle-orm'
import { type TenantTx, withTenant } from '../../src/client.js'
import { ownerPool } from './helpers.js'

/** A one-shot barrier: `opened` resolves once `open()` is called. */
export interface Gate {
  readonly opened: Promise<void>
  open(): void
}

export function gate(): Gate {
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/** A transaction that ran `fn` and is parked, still OPEN, until told to finish. */
export interface HeldTransaction<T> {
  /** fn's result, once fn has returned. The transaction has NOT committed yet. */
  readonly ready: Promise<T>
  /** Backend pid of the held connection. Valid once `ready` has resolved. */
  readonly pid: number
  /** Let the transaction commit; resolves with fn's result once it has. */
  commit(): Promise<T>
  /** Roll the transaction back instead; resolves once it has. */
  rollback(): Promise<void>
}

class HeldRollback extends Error {
  constructor() {
    super('held transaction rolled back by the test harness')
    this.name = 'HeldRollback'
  }
}

/** A held transaction is never parked longer than this, whatever the test does. */
const MAX_HOLD_MS = 20_000

const parked = new Set<() => Promise<void>>()

/**
 * Run `fn` inside `withTenant(userId)` and park BEFORE COMMIT until the test
 * calls `commit()` or `rollback()`. Whatever locks `fn` took are held for the
 * whole park, which is how a production call is placed "behind" a transaction.
 *
 * If `fn` throws, `ready` rejects and the transaction rolls back. A transaction
 * nobody finishes is rolled back after {@link MAX_HOLD_MS} as a teardown
 * fail-safe (it does not decide any interleaving), and by {@link releaseHeld}.
 */
export function holdOpen<T>(userId: string, fn: (tx: TenantTx) => Promise<T>): HeldTransaction<T> {
  let pid = -1
  let resolveReady: (value: T) => void = () => undefined
  let rejectReady: (error: unknown) => void = () => undefined
  const ready = new Promise<T>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let decide: (verdict: 'commit' | 'rollback') => void = () => undefined
  const verdict = new Promise<'commit' | 'rollback'>((resolve) => {
    decide = resolve
  })
  const failSafe = setTimeout(() => decide('rollback'), MAX_HOLD_MS)

  const settled = withTenant(userId, async (tx) => {
    const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`)
    pid = Number((result.rows[0] as { pid: number }).pid)
    let value: T
    try {
      value = await fn(tx)
    } catch (error) {
      rejectReady(error)
      throw error
    }
    resolveReady(value)
    if ((await verdict) === 'rollback') throw new HeldRollback()
    return value
  }).finally(() => clearTimeout(failSafe))
  // Observed through ready/commit/rollback; never an unhandled rejection. A
  // failure before `fn` even ran (checkout, set_config) must still settle
  // `ready`, or the test would hang on it instead of failing.
  settled.catch((error: unknown) => rejectReady(error))
  // `ready` rejects whenever `fn` throws — and that error also surfaces from
  // `settled` — so a test that never awaits `ready` must not crash the run.
  ready.catch(() => undefined)

  const finish = async () => {
    decide('rollback')
    await settled.catch(() => undefined)
  }
  parked.add(finish)
  void settled.then(
    () => parked.delete(finish),
    () => parked.delete(finish),
  )

  return {
    ready,
    get pid() {
      return pid
    },
    commit() {
      decide('commit')
      return settled
    },
    async rollback() {
      await finish()
    },
  }
}

/** Roll back every transaction a test left parked. Call from `afterEach`. */
export async function releaseHeld(): Promise<void> {
  await Promise.all([...parked].map((finish) => finish()))
}

/** A row-level lock wait shows up as one of these (`tuple` once a queue forms). */
export const ROW_LOCK = ['transactionid', 'tuple'] as const

export interface LockWaitQuery {
  /** `pg_locks.locktype` of the ungranted request, e.g. 'advisory' or {@link ROW_LOCK}. */
  locktype: string | readonly string[]
  /** Only count waiters this backend blocks (`pg_blocking_pids`). */
  blockedBy?: number
  /** How many distinct waiting backends to wait for (default 1). */
  count?: number
}

interface Waiter {
  pid: number
  locktype: string
  blockers: number[]
}

async function lockWaiters(locktypes: readonly string[]): Promise<Waiter[]> {
  // Scoped to THIS database: the server may host other suites' databases, and
  // `pg_locks` is server-wide. Joined through pg_stat_activity because
  // transactionid/tuple rows carry no usable `database` of their own.
  const result = await ownerPool.query(
    `SELECT l.pid, l.locktype, pg_blocking_pids(l.pid) AS blockers
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted
        AND a.datname = current_database()
        AND l.locktype = ANY($1::text[])`,
    [locktypes],
  )
  return result.rows as Waiter[]
}

/**
 * Poll `pg_locks` until `count` distinct backends are waiting on an ungranted
 * lock of `locktype` (optionally: blocked by `blockedBy`), and return their
 * pids. Polling is bounded by `timeoutMs`; on timeout it throws with the waits
 * it did see. This OBSERVES an interleaving the test constructed — it never
 * chooses one.
 */
export async function waitForLockWait(query: LockWaitQuery, timeoutMs = 5000): Promise<number[]> {
  const locktypes = typeof query.locktype === 'string' ? [query.locktype] : query.locktype
  const want = query.count ?? 1
  const deadline = Date.now() + timeoutMs
  let seen: Waiter[] = []
  for (;;) {
    seen = await lockWaiters(locktypes)
    const pids = [
      ...new Set(
        seen
          .filter((w) => query.blockedBy === undefined || w.blockers.includes(query.blockedBy))
          .map((w) => w.pid),
      ),
    ]
    if (pids.length >= want) return pids
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const holder = query.blockedBy === undefined ? '' : ` blocked by pid ${query.blockedBy}`
  throw new Error(
    `waitForLockWait: expected ${want} backend(s) waiting on a ${locktypes.join('/')} lock` +
      `${holder} within ${timeoutMs}ms; ungranted waits seen: ${JSON.stringify(seen)}`,
  )
}

/**
 * Throw unless `promise` is still pending. Settled promises run their handlers
 * as microtasks, which all drain before a `setImmediate` macrotask fires, so
 * "not settled by then" is exact for anything already settled.
 */
export async function assertPending(promise: Promise<unknown>, label: string): Promise<void> {
  const pending = Symbol('pending')
  const state = await Promise.race([
    promise.then(
      () => 'fulfilled',
      (error: unknown) => `rejected (${error instanceof Error ? error.message : String(error)})`,
    ),
    new Promise<symbol>((resolve) => setImmediate(() => resolve(pending))),
  ])
  if (state !== pending)
    throw new Error(`${label}: expected still pending, but it ${String(state)}`)
}
