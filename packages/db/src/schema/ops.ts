// SPDX-License-Identifier: Apache-2.0
// Operational tables (docs/concepts/data-model.mdx). llm_usage is user-owned (RLS); eval_runs
// and audit_log are system tables (audit_log gets INSERT-only grants).

import { actorKindSchema } from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { enumCheckSql, tenantPolicy } from './helpers.js'
import { users } from './identity.js'

const uuidv7 = () => sql`uuidv7()`

/**
 * audit_log tenant-isolation policy (defense in depth). audit_log is written
 * by the runtime role WITHOUT tenant context (getAdminDb() in audit-log.ts),
 * and system rows (pre-auth OAuth events) carry a NULL user_id — a standard
 * tenantPolicy() would reject that entire insert path. This variant keeps the
 * tenant-less system path open (no app.user_id bound => same trust boundary
 * getAdminDb() already represents) while pinning any tenant-bound transaction
 * (withTenant()) to its own rows, closing cross-tenant reads from
 * tenant-scoped code paths. NULLIF guard per S3 finding 1 (helpers.ts).
 */
const auditTenantExpr = sql`NULLIF(current_setting('app.user_id', true), '') IS NULL OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    // scale 12 (picodollar) so sub-microdollar embedding costs don't round to
    // zero: text-embedding-3-small bills $0.02/1M = 2e-8/token, so a short embed
    // (or one aggregated over many small calls) is invisible at scale 6. precision
    // 20 keeps room for large lifetime totals (1e8 USD) alongside the 12 decimals.
    costUsd: numeric('cost_usd', { precision: 20, scale: 12 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_usage_user_time_idx').on(t.userId, t.createdAt), tenantPolicy()],
)

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    suite: text('suite').notNull(),
    slice: text('slice').notNull(),
    score: real('score').notNull(),
    gitSha: text('git_sha').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('eval_runs_suite_idx').on(t.suite, t.slice, t.createdAt)],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    actorKind: text('actor_kind').notNull(),
    action: text('action').notNull(),
    resource: text('resource'),
    ip: text('ip'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_user_time_idx').on(t.userId, t.createdAt),
    check('audit_log_actor_check', enumCheckSql(t.actorKind, actorKindSchema.options)),
    pgPolicy('tenant_isolation', {
      for: 'all',
      using: auditTenantExpr,
      withCheck: auditTenantExpr,
    }),
  ],
)
