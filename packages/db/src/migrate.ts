// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
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
    await db.execute(sql.raw(await readFile(provisionRolesPath(), 'utf8')))
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
