// SPDX-License-Identifier: Apache-2.0
// Budget domain (docs/concepts/data-model.mdx).
//
// user_budgets is USER-OWNED: explicit user_id, RLS via the tenantPolicy NULLIF
// guard, one row per tenant. plan_tiers is GLOBAL config data (tier→cap),
// admin-managed, no RLS — editable as data so a cap change needs no code deploy.
//
// All enum CHECK constraints are generated from the @3ngram/schema Zod enums,
// so the DB cannot drift from the single validation boundary.

import { planTierSchema } from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { enumCheckSql, tenantPolicy } from './helpers.js'
import { users } from './identity.js'

const uuidv7 = () => sql`uuidv7()`

// USD money columns reuse llm_usage's precision (numeric(20,12), picodollar) so
// cap-vs-consumption comparisons in the budget gate are exact, not lossy.
const USD_PRECISION = { precision: 20, scale: 12 } as const

/**
 * Per-user budget window + optional operator cap override. One row per user.
 * `cap_usd_override` NULL means "use the tier cap"; the EFFECTIVE cap is resolved
 * at runtime (override ?? plan_tiers[tier].cap_usd ?? config.defaultCapUsd) and
 * never denormalized here. `consumed_usd` is intentionally NOT a column: it is
 * summed from `llm_usage` over [period_start, period_end) at gate time, so
 * it can never drift from the source of truth. `period_*` are written by a platform
 * state machine from the plan cycle; self-host falls back to a config default
 * window.
 */
export const userBudgets = pgTable(
  'user_budgets',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capUsdOverride: numeric('cap_usd_override', USD_PRECISION),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('user_budgets_user_idx').on(t.userId), tenantPolicy()],
)

/**
 * Short-lived budget RESERVATIONS (concurrency fix). A metered op
 * inserts a reservation for its estimated cost BEFORE the gateway round-trip and
 * deletes it after, under a per-user advisory lock — so concurrent near-cap
 * requests see each other's in-flight spend and cannot all pass the gate and
 * overshoot the 100% ceiling. Unlike append-only `llm_usage`, this table is
 * MUTABLE (insert + delete). Rows are transient; a crash-leaked reservation is
 * ignored once older than the TTL the budget reader applies (so no sweeper is
 * required for correctness). NOT the cost ledger — the real cost still lands in
 * `llm_usage` after the call; the reservation is only an in-flight hold.
 */
export const budgetReservations = pgTable(
  'budget_reservations',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    estimatedCostUsd: numeric('estimated_cost_usd', USD_PRECISION).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('budget_reservations_user_time_idx').on(t.userId, t.createdAt), tenantPolicy()],
)

/**
 * Tier → cap_usd + capabilities. GLOBAL config data: no user_id,
 * no RLS, admin-managed. Editing a row's `cap_usd` takes effect immediately for
 * every user on that tier without an override — no propagation job. External plan
 * price identifiers live in private env/config, NOT in this table and NOT in TS
 * source.
 */
export const planTiers = pgTable(
  'plan_tiers',
  {
    tier: text('tier').primaryKey(),
    capUsd: numeric('cap_usd', USD_PRECISION).notNull(),
    capabilities: jsonb('capabilities').notNull().default({}).$type<Record<string, unknown>>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('plan_tiers_tier_idx').on(t.tier),
    check('plan_tiers_tier_check', enumCheckSql(t.tier, planTierSchema.options)),
  ],
)
