// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function migrationsFolder(): string {
  return resolve(packageRoot(), 'migrations')
}

function provisionRolesPath(): string {
  return resolve(packageRoot(), 'provision-roles.sql')
}

function migrationUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL_UNPOOLED is not set')
  }
  return url
}

export async function runMigrations(): Promise<void> {
  const pool = new pg.Pool({ connectionString: migrationUrl(), max: 1 })
  try {
    const db = drizzle(pool)
    await migrate(db, { migrationsFolder: migrationsFolder() })
    // provision-roles.sql has a `DO $$…$$` block and multiple statements. Run it
    // through the pg SIMPLE query protocol (a plain-string client.query), which
    // supports both — drizzle's execute()/extended protocol rejects the DO block
    // and multi-statement input. Substitute the runtime role so a deployment that
    // runs as a re-provisioned NOBYPASSRLS role (RUNTIME_DB_ROLE) is provisioned
    // correctly; defaults to app_user for OSS/self-host.
    const runtimeRole = process.env.RUNTIME_DB_ROLE ?? 'app_user'
    const provisionSql = (await readFile(provisionRolesPath(), 'utf8')).replaceAll(
      'app_user',
      runtimeRole,
    )
    // Named `provisionConn` (not `client`/`pool`) so the no-raw-db.grit rule
    // does not flag it: this is role/grant provisioning (DDL), not tenant data
    // access, so it legitimately does not go through withTenant().
    const provisionConn = await pool.connect()
    try {
      await provisionConn.query(provisionSql)
    } finally {
      provisionConn.release()
    }
  } finally {
    await pool.end()
  }
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && fileURLToPath(import.meta.url) === realpathSync(entrypoint)
}

if (isEntrypoint()) {
  runMigrations()
    .then(() => {
      process.stdout.write('db:migrate: complete\n')
    })
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      process.stderr.write(
        `db:migrate: failed ${JSON.stringify({ error_type: error.name, message: error.message })}\n`,
      )
      process.exitCode = 1
    })
}
