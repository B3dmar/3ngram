// SPDX-License-Identifier: Apache-2.0
// Runtime fail-closed guard: prove tenant isolation is actually in force in the
// LIVE database, not just asserted as a string in a migration/unit test.
//
// The migration-drift unit test only proves that provision-roles.sql *contains*
// NOBYPASSRLS and that 0028 *contains* the FORCE statements — it says nothing
// about the database the process is connected to. A misconfigured connection
// string (owner/superuser role), a role that was later granted BYPASSRLS, or a
// table that never got its FORCE applied would all pass the unit test while
// serving cross-tenant reads. This guard asks Postgres directly and throws if
// isolation is not provably in force, so readiness (and boot) can fail closed.
//
// Behavioral model: scripts/ci-smoke-app.sql (invoked from .github/workflows/
// ci.yml) — same intent, but that runs only in CI against an ephemeral DB. This
// is the always-available runtime equivalent.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { getAdminDb } from './client.js'

/**
 * Default runtime role production traffic connects as (provision-roles.sql).
 * Override with the `RUNTIME_DB_ROLE` env var when the deployment connects as a
 * differently-named NOBYPASSRLS role (e.g. a re-provisioned runtime role).
 */
export const DEFAULT_RUNTIME_ROLE = 'app_user'

export interface RlsGuardOptions {
  /**
   * DB handle to probe. Defaults to the package's runtime handle (getAdminDb()),
   * which connects as the runtime role (DATABASE_URL). Inject an owner/superuser
   * handle in tests to prove the guard rejects a bypass-capable connection.
   */
  db?: NodePgDatabase
  /** Expected value of `current_user`. Defaults to {@link DEFAULT_RUNTIME_ROLE}. */
  expectedRole?: string
  /**
   * Tables that MUST have `relforcerowsecurity = true`. Defaults to the set
   * parsed from the migrations themselves ({@link readForcedTenantTables}) so
   * there is a single source of truth (no second hardcoded copy to drift).
   */
  forcedTables?: readonly string[]
}

/** Thrown when tenant isolation is not provably in force. Fails closed. */
export class RlsGuardError extends Error {
  readonly violations: readonly string[]
  constructor(violations: readonly string[]) {
    super(
      `RLS guard failed — tenant isolation is not provably in force:\n- ${violations.join('\n- ')}`,
    )
    this.name = 'RlsGuardError'
    this.violations = violations
  }
}

function migrationsDir(): string {
  // dist/rls-guard.js → package root → migrations (packaged; see package.json
  // "files"). Mirrors migrate.ts packageRoot() resolution.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
}

/**
 * Parse the set of tables forced with `FORCE ROW LEVEL SECURITY` from ALL
 * migrations. Enumerating the migrations (rather than hardcoding a second copy
 * of the 0028 list) means a future migration that forces a new tenant table is
 * automatically covered by the runtime guard.
 */
export function readForcedTenantTables(): readonly string[] {
  const dir = migrationsDir()
  const tables = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue
    const text = readFileSync(join(dir, file), 'utf8')
    for (const m of text.matchAll(/ALTER TABLE "([^"]+)" FORCE ROW LEVEL SECURITY/g)) {
      if (m[1] !== undefined) tables.add(m[1])
    }
  }
  if (tables.size === 0) {
    throw new Error('rls-guard: no FORCE ROW LEVEL SECURITY tables found in migrations')
  }
  return [...tables].sort()
}

// Type aliases (not interfaces) so they satisfy drizzle's execute<T> constraint
// (T extends Record<string, unknown> — interfaces lack the implicit index signature).
type RoleRow = {
  role: string
  bypassrls: boolean | null
  super: boolean | null
}
type ForcedRow = {
  relname: string
  forced: boolean
}

/**
 * Assert, against the LIVE database, that tenant isolation is provably in force:
 *  1. `current_user` equals the expected runtime role (`app_user`);
 *  2. that role is NOBYPASSRLS and not a superuser (either would silently defeat
 *     every RLS policy);
 *  3. every forced tenant-data table has `relforcerowsecurity = true`.
 *
 * Fails closed: any deviation aggregates into a single {@link RlsGuardError}. No
 * silent catch — a probe error propagates as a plain Error to the caller.
 */
export async function assertRlsInForce(options: RlsGuardOptions = {}): Promise<void> {
  const db = options.db ?? getAdminDb()
  const expectedRole = options.expectedRole ?? process.env.RUNTIME_DB_ROLE ?? DEFAULT_RUNTIME_ROLE
  const forcedTables = options.forcedTables ?? readForcedTenantTables()

  const roleResult = await db.execute<RoleRow>(
    sql`SELECT current_user::text AS role,
               r.rolbypassrls AS bypassrls,
               r.rolsuper AS super
        FROM pg_roles r
        WHERE r.rolname = current_user`,
  )
  const role = roleResult.rows[0]
  if (role === undefined) {
    // No pg_roles row for current_user ⇒ cannot prove NOBYPASSRLS. Fail closed.
    throw new RlsGuardError([
      'current_user has no pg_roles row; cannot verify bypass/superuser state',
    ])
  }

  const violations: string[] = []
  if (role.role !== expectedRole) {
    violations.push(`connected as '${role.role}', expected runtime role '${expectedRole}'`)
  }
  if (role.bypassrls !== false) {
    violations.push(
      `role '${role.role}' can BYPASS row-level security (rolbypassrls=${role.bypassrls})`,
    )
  }
  if (role.super !== false) {
    violations.push(
      `role '${role.role}' is a superuser (rolsuper=${role.super}); superusers bypass RLS`,
    )
  }

  // Fetch every public base table's FORCE state and filter in JS — no array
  // parameter (avoids depending on driver array-encoding semantics) and one
  // round-trip regardless of the forced-table count.
  const forcedResult = await db.execute<ForcedRow>(
    sql`SELECT c.relname AS relname, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  )
  const forcedState = new Map(forcedResult.rows.map((r) => [r.relname, r.forced]))
  for (const table of forcedTables) {
    const forced = forcedState.get(table)
    if (forced === undefined) {
      violations.push(`forced tenant-data table '${table}' is missing from the database`)
    } else if (forced !== true) {
      violations.push(`table '${table}' does NOT have FORCE ROW LEVEL SECURITY set`)
    }
  }

  if (violations.length > 0) throw new RlsGuardError(violations)
}
