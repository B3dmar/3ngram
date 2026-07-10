// SPDX-License-Identifier: Apache-2.0
import { type SQL, sql } from 'drizzle-orm'
import { type PgColumn, pgPolicy } from 'drizzle-orm/pg-core'

/**
 * CHECK constraint generated from a @3ngram/schema enum — the Zod→CHECK
 * strategy (docs/concepts/data-model.mdx schema-PR DoD §6). The Zod enum is the single
 * source; the DB constraint cannot drift from it because it is built here.
 */
export function enumCheckSql(column: PgColumn, values: readonly string[]): SQL {
  const list = sql.join(
    values.map((v) => sql`${sql.raw(`'${v}'`)}`),
    sql`, `,
  )
  return sql`${column} IN (${list})`
}

/**
 * Canonical tenant-isolation policy (S3 finding 1: the NULLIF guard is
 * mandatory — current_setting(..., true) returns '' on pooled connections
 * after a set-and-reset, and ''::uuid makes the policy THROW).
 */
export function tenantPolicy() {
  const expr = sql`user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`
  return pgPolicy('tenant_isolation', { for: 'all', using: expr, withCheck: expr })
}
