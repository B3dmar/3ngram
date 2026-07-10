// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/**
 * Budget & plan-tier validation boundary.
 *
 * This file is the SINGLE source of truth for the plan-tier enum. The Drizzle
 * schema (`packages/db/src/schema/budget.ts`) derives its `CHECK` constraints from
 * it via `enumCheckSql(col, *.options)`, and the generated migration inherits them
 * — the DB constraints cannot drift from the Zod source. Services and transports
 * MUST NOT re-declare these values.
 *
 * Per-tier budget caps and capabilities are DATA (`plan_tiers` rows), not code;
 * only the SET of legal tier names lives here.
 */

/**
 * Plan tiers seeded into `plan_tiers` (tier → cap_usd + capabilities). Caps live
 * in the DB rows, not here, so a price/cap change needs no deploy.
 */
export const planTierSchema = z.enum(['free', 'pro', 'team'])
export type PlanTier = z.infer<typeof planTierSchema>
export const PLAN_TIERS = planTierSchema.options

/**
 * Response of `GET /api/v1/budget` (read-only). The caller's
 * current budget status — effective cap + spend this cycle. Money fields are USD;
 * period bounds are ISO-8601 strings or null. Only the caller's own numbers (the
 * single validation boundary for this REST response).
 */
export const budgetStatusResponseSchema = z.object({
  effectiveCapUsd: z.number(),
  consumedUsd: z.number(),
  capUsdOverride: z.number().nullable(),
  // ISO-8601 strings (server-produced via Date.toISOString) or null.
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
})
export type BudgetStatusResponse = z.infer<typeof budgetStatusResponseSchema>
