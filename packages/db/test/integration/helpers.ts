// SPDX-License-Identifier: Apache-2.0
// Integration-test infrastructure (docs/concepts/testing.mdx layer 2, Phase 0 item 6).
//
// Two isolation strategies, used deliberately:
// - withTestTransaction(): savepoint pattern for
//   tests that own their SQL — rolled back, fast, parallel-safe.
// - resetDomainTables(): truncate-based cleanup for suites that exercise the
//   REAL withTenant() path — withTenant commits on its own pool/connection,
//   so cross-connection visibility makes savepoints inapplicable there.
//
// Connections: OWNER (migrations/seed/asserts) from DATABASE_URL_UNPOOLED;
// RUNTIME (app_user, NOBYPASSRLS) from DATABASE_URL. RLS tests MUST run as
// the runtime role — owner bypasses RLS and proves nothing (docs/concepts/testing.mdx).
import pg from 'pg'
import { assertEphemeralTarget } from './ephemeral-guard.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v)
    throw new Error(
      `${name} must be set for integration tests (see docs/concepts/testing.mdx local loop)`,
    )
  return v
}

// P0 (2026-06-12 prod-truncate incident): assert the target DB is provably
// ephemeral at MODULE LOAD, BEFORE the pools are constructed. Every integration
// suite imports its DB access (ownerPool/runtimePool/seedUser/resetDomainTables)
// from this module, so any query — setup INSERTs (seedUser), per-test writes,
// the TRUNCATE, anything — is now gated behind this single check. Importing this
// module against a non-ephemeral host (without I_AM_AN_EPHEMERAL_DB=1) aborts
// loudly before a single connection is opened, including in suites that never
// call resetDomainTables(). See ./ephemeral-guard.ts.
assertEphemeralTarget()

export const ownerPool = new pg.Pool({
  connectionString: requireEnv('DATABASE_URL_UNPOOLED'),
  max: 4,
})
export const runtimePool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 8 })

/** Savepoint-isolated test body on a dedicated runtime-role connection. */
export async function withTestTransaction<T>(
  fn: (conn: pg.PoolClient) => Promise<T>,
  pool: pg.Pool = runtimePool,
): Promise<T> {
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    return await fn(conn)
  } finally {
    await conn.query('ROLLBACK').catch(() => {})
    conn.release()
  }
}

const DOMAIN_TABLES = [
  'consolidation_proposals',
  'memory_events',
  'commitments',
  'facts',
  'memory_edges',
  'memories',
  'scopes',
  'llm_usage',
]

/**
 * Owner-side cleanup between withTenant-exercising tests.
 *
 * This is a GLOBAL TRUNCATE, not a per-tenant delete: every integration suite
 * shares one Postgres (the CI Neon branch). Within a package, vitest runs files
 * serially (`--fileParallelism=false`), so this is safe. ACROSS packages it is
 * NOT — turbo would otherwise run `@3ngram/db` and `@3ngram/core` integration
 * suites in parallel, and a TRUNCATE from one suite's `beforeEach` would wipe
 * another suite's fixture rows mid-build (observed as a memory_edges FK
 * violation when search's edge insert referenced a predecessor truncated away
 * by remember.int.test.ts). The root `test:integration` script therefore pins
 * `turbo --concurrency=1` for single-database runs. CI parallelizes by
 * giving each active integration shard, including DB file-group shards, its own
 * ephemeral Neon branch.
 */
export async function resetDomainTables(): Promise<void> {
  // P0: a TRUNCATE against a non-ephemeral (prod) DB is impossible. The primary
  // guard now fires at module load (above), before any pool is constructed, so
  // every DB access is covered. This second call is cheap belt-and-suspenders:
  // it re-asserts immediately before the destructive SQL in case process.env was
  // mutated after import (2026-06-12 prod-truncate incident; see
  // ./ephemeral-guard.ts).
  assertEphemeralTarget()
  await ownerPool.query(`TRUNCATE ${DOMAIN_TABLES.join(', ')} CASCADE`)
}

/** Seed (or fetch) a test user; returns its id. Owner connection. */
export async function seedUser(email: string): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x')
     ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id`,
    [email],
  )
  return r.rows[0].id
}

export async function closePools(): Promise<void> {
  await Promise.all([ownerPool.end(), runtimePool.end()])
}
