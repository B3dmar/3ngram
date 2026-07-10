// SPDX-License-Identifier: Apache-2.0
// The ONE TRUE ACCESS PATH (docs/concepts/data-model.mdx, proven by spike S3).
// Nothing else in this package — and nothing outside it — exports a pool,
// client, or db handle. All tenant-scoped data access goes through
// withTenant(); the no-raw-db lint plugin enforces this repo-wide.
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgTransactionConfig } from 'drizzle-orm/pg-core'
import pg from 'pg'

export type TenantTx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

let db: NodePgDatabase | undefined
let pool: pg.Pool | undefined

function getDb(): NodePgDatabase {
  if (!db) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    pool = new pg.Pool({ connectionString: url })
    db = drizzle(pool)
  }
  return db
}

/**
 * Run `fn` inside a transaction with tenant context bound for its duration.
 *
 * SET LOCAL via parameterized set_config(..., true) — never bare SET: under
 * transaction-mode pooling one bare SET contaminated 32/32 subsequent foreign
 * transactions. RLS policies carry the
 * NULLIF('') guard for the same pooling reason.
 *
 * `config` is the optional drizzle transaction config (e.g.
 * `{ isolationLevel: 'repeatable read' }`). drizzle emits it on the `BEGIN`,
 * BEFORE the set_config query runs, so a stronger isolation level is legal here
 * even though set_config is the first statement inside the callback. Used by the
 * multi-table data export to read every table under ONE consistent snapshot.
 */
export async function withTenant<T>(
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`)
    return fn(tx)
  }, config)
}

/**
 * Take the per-user ACCOUNT-LIFECYCLE advisory lock for the current transaction.
 *
 * A transaction-scoped lock (released at commit/rollback) that serializes
 * account deletion against credential issuance (OAuth code exchange + refresh
 * rotation) so neither can interleave with the other: whichever transaction wins
 * the lock runs to commit before the other touches a row. Deletion revokes +
 * tombstones under it; issuance, once it wins, refuses to mint on a tombstoned
 * user. This closes the credential-resurrection race.
 *
 * Distinct namespace from the budget lock (single-bigint key) and the
 * `auth_reset_password` lock (different classid), so it never collides with them.
 * The classid is hashtext('account_lifecycle'); the objid is hashtext of the
 * canonical uuid text, matching the `auth_reset_password` convention.
 */
export async function lockAccountLifecycle(tx: TenantTx, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('account_lifecycle'), hashtext(${userId}::uuid::text))`,
  )
}

/**
 * Take the per-user PASSWORD-RESET advisory lock for the current transaction.
 *
 * The SAME key the `auth_reset_password` resolver (migration 0016/0020) and
 * `rotatePasswordAndRevokeOthers` take — `hashtext('auth_reset_password')` +
 * `hashtext(uuid::text)`. Account deletion takes it too so a forgotten-password
 * reset or change-password (both UPDATE `users.password_hash` by id) cannot set a
 * real hash on a tombstoned account: whoever wins the lock runs to commit first,
 * so a password write either commits-then-gets-erased-by-deletion, or runs after
 * deletion (its reset token already burned + the row tombstoned) and sets nothing.
 */
export async function lockPasswordReset(tx: TenantTx, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('auth_reset_password'), hashtext(${userId}::uuid::text))`,
  )
}

/**
 * Pool-scoped db handle WITHOUT tenant context, for the pre-tenant system
 * tables only (`users`, `oauth_clients`). These tables carry no `user_id` and
 * no RLS, so withTenant() does not apply — the identity must be created or
 * looked up before any tenant context can exist. Reuse via src/auth-admin.ts;
 * do NOT touch user-owned tables through this handle (their RLS would fail
 * closed with no app.user_id set, which is the point).
 */
export function getAdminDb(): NodePgDatabase {
  return getDb()
}

/** Test-only teardown hook. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = undefined
    db = undefined
  }
}
