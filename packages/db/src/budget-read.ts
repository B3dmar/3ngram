// SPDX-License-Identifier: Apache-2.0
// Budget accounting read (support). The Apache budget gate
// (packages/core/src/budget/budget.ts) is the policy; this is the single DB read
// it needs: the per-user override + window, the consumed spend over that window,
// and the tier cap — all in ONE withTenant transaction (RLS-scoped).
//
// consumed_usd is summed from llm_usage at read time, never stored, so it cannot
// drift from the source of truth (docs/concepts/data-model.mdx). The window is the user_budgets
// period when set (written by a platform state machine from the plan cycle), else
// a rolling now()-N-days fallback so self-host (no explicit period) still has a
// usable cycle. plan_tiers is global config (no RLS); an undefined tier (self-host)
// SKIPS the lookup and a missing tier row yields a null cap, so the caller falls
// back to config.defaultCapUsd.
//
// Observability (hard rule 6): reads counts/caps only — never memory content.
import { eq, sql } from 'drizzle-orm'
import { type TenantTx, withTenant } from './client.js'
import { budgetReservations, planTiers, userBudgets } from './schema/budget.js'

/**
 * How long an in-flight budget reservation is honoured. A reservation is deleted
 * as soon as its metered call finishes (success or failure); this TTL only bounds
 * a CRASH-leaked reservation so a dead process cannot wedge a user's budget
 * forever — it is ignored in the consumed total once older than this. Set well
 * above the slowest gateway round-trip (embeds can take ~30s).
 */
const RESERVATION_TTL_SECONDS = 120

/** Raw inputs the budget policy needs to compute an over-cap decision. */
export interface BudgetAccounting {
  /** Per-user operator override (USD); null means "use the tier cap". */
  capUsdOverride: number | null
  /** plan_tiers.cap_usd for the resolved tier (USD); null when no tier row. */
  tierCapUsd: number | null
  /** Priced spend summed from llm_usage over the effective window (USD). */
  consumedUsd: number
  /** Count of llm_usage rows in the window with NULL cost_usd (unpriced model) —
   * the caller charges these a conservative fallback so unpriced usage still
   * accrues against the cap (otherwise a sub-cap user never trips). */
  unpricedCount: number
  /** Sum of active (non-expired) in-flight reservations (USD) — spend that is
   * mid-flight and not yet in llm_usage, counted so the gate sees it. */
  reservationsUsd: number
  /** The effective cycle window used for the sum. */
  periodStart: Date | null
  periodEnd: Date | null
}

/**
 * Read the budget accounting for `userId` against the resolved `tier` (undefined
 * on self-host).
 *
 * `defaultWindowDays` is the fallback rolling-window length used only when the
 * user has no `user_budgets` period set (self-host / no explicit period). Returns
 * numbers the caller compares; it does NOT decide the cap (that policy lives in
 * core).
 */
export async function getBudgetAccounting(
  userId: string,
  tier: string | undefined,
  defaultWindowDays: number,
): Promise<BudgetAccounting> {
  return withTenant(userId, async (tx) => {
    const [budget] = await tx
      .select({
        capUsdOverride: userBudgets.capUsdOverride,
        periodStart: userBudgets.periodStart,
        periodEnd: userBudgets.periodEnd,
      })
      .from(userBudgets)
      .where(eq(userBudgets.userId, userId))
      .limit(1)

    const hasWindow = budget?.periodStart != null && budget?.periodEnd != null
    const windowStart = hasWindow
      ? sql`${budget.periodStart}`
      : sql`now() - make_interval(days => ${defaultWindowDays})`
    const windowEnd = hasWindow ? sql`${budget.periodEnd}` : sql`now()`

    // Raw windowed aggregate: priced spend (SUM) PLUS a count of UNPRICED rows
    // (NULL cost_usd) so the caller can charge those a fallback. The window bound
    // is either an explicit period (bound as a parameter) or a now()-relative
    // interval, so time stays in the DB (no injected clock). RLS already scopes
    // llm_usage to the tenant; the explicit user_id keeps the index in play.
    const usageResult = await tx.execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS consumed,
             COUNT(*) FILTER (WHERE cost_usd IS NULL)::text AS unpriced
      FROM llm_usage
      WHERE user_id = ${userId}
        AND created_at >= ${windowStart}
        AND created_at < ${windowEnd}
    `)
    const usageRow = usageResult.rows[0] as { consumed: string; unpriced: string }

    const reservationsUsd = await sumActiveReservations(tx, userId)

    // Self-host resolves no tier (undefined) — skip the plan_tiers lookup entirely
    // so the effective cap falls through to the config default.
    const tierCapUsd = tier === undefined ? null : await selectTierCap(tx, tier)

    return {
      capUsdOverride: budget?.capUsdOverride != null ? Number(budget.capUsdOverride) : null,
      tierCapUsd,
      consumedUsd: Number(usageRow.consumed),
      unpricedCount: Number(usageRow.unpriced),
      reservationsUsd,
      periodStart: budget?.periodStart ?? null,
      periodEnd: budget?.periodEnd ?? null,
    }
  })
}

/** Read a tier's plan_tiers cap (USD) within the tx, or null when no row exists. */
async function selectTierCap(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tier: string,
): Promise<number | null> {
  const [tierRow] = await tx
    .select({ cap: planTiers.capUsd })
    .from(planTiers)
    .where(eq(planTiers.tier, tier))
    .limit(1)
  return tierRow?.cap != null ? Number(tierRow.cap) : null
}

/** Sum active (non-expired) in-flight reservations for a user, within the tx. */
async function sumActiveReservations(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  userId: string,
): Promise<number> {
  const result = await tx.execute(sql`
    SELECT COALESCE(SUM(estimated_cost_usd), 0)::text AS reserved
    FROM budget_reservations
    WHERE user_id = ${userId}
      AND created_at > now() - make_interval(secs => ${RESERVATION_TTL_SECONDS})
  `)
  return Number((result.rows[0] as { reserved: string }).reserved)
}

/** Outcome of an atomic reserve attempt. */
export interface BudgetReservation {
  allowed: boolean
  /** The reservation row id to release after the call — present iff allowed. */
  reservationId?: string
}

/**
 * Atomically reserve `estimatedCostUsd` for `userId` against the effective cap.
 *
 * Serialized per user by a transaction-scoped advisory lock, so two concurrent
 * near-cap requests cannot both read the same total and both pass (the P1 race):
 * each sees the other's in-flight reservation. The effective cap is resolved here
 * (override ?? plan_tiers cap ?? `defaultCapUsd`) and consumed = priced llm_usage
 * + unpriced rows charged at `unpricedFallbackUsd` + active reservations. When the
 * next op would cross 100% of the cap, returns `{ allowed: false }` and reserves
 * nothing; otherwise inserts a reservation and returns its id. The caller MUST
 * `releaseReservation` it after the metered call (success or failure).
 *
 * The advisory lock is held only for this short tx (sum + insert) — NEVER across
 * the gateway round-trip, so it serializes the check, not the network call.
 */
export async function reserveBudget(
  userId: string,
  tier: string | undefined,
  defaultWindowDays: number,
  defaultCapUsd: number,
  estimatedCostUsd: number,
  unpricedFallbackUsd: number,
): Promise<BudgetReservation> {
  return withTenant(userId, async (tx) => {
    // Per-user serialization: every reserve for this user queues behind the lock,
    // released automatically at tx end. hashtextextended maps the uuid to the
    // bigint key pg_advisory_xact_lock requires.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`)

    const [budget] = await tx
      .select({
        capUsdOverride: userBudgets.capUsdOverride,
        periodStart: userBudgets.periodStart,
        periodEnd: userBudgets.periodEnd,
      })
      .from(userBudgets)
      .where(eq(userBudgets.userId, userId))
      .limit(1)

    const hasWindow = budget?.periodStart != null && budget?.periodEnd != null
    const windowStart = hasWindow
      ? sql`${budget.periodStart}`
      : sql`now() - make_interval(days => ${defaultWindowDays})`
    const windowEnd = hasWindow ? sql`${budget.periodEnd}` : sql`now()`

    const usageResult = await tx.execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS consumed,
             COUNT(*) FILTER (WHERE cost_usd IS NULL)::text AS unpriced
      FROM llm_usage
      WHERE user_id = ${userId}
        AND created_at >= ${windowStart}
        AND created_at < ${windowEnd}
    `)
    const usageRow = usageResult.rows[0] as { consumed: string; unpriced: string }
    const reservationsUsd = await sumActiveReservations(tx, userId)

    // Self-host resolves no tier (undefined) — skip the plan_tiers lookup so the
    // effective cap falls through to the config default.
    const capUsdOverride = budget?.capUsdOverride != null ? Number(budget.capUsdOverride) : null
    const tierCapUsd = tier === undefined ? null : await selectTierCap(tx, tier)
    const effectiveCap = capUsdOverride ?? tierCapUsd ?? defaultCapUsd
    const consumed =
      Number(usageRow.consumed) + Number(usageRow.unpriced) * unpricedFallbackUsd + reservationsUsd

    if (consumed + estimatedCostUsd > effectiveCap) return { allowed: false }

    const [inserted] = await tx
      .insert(budgetReservations)
      .values({ userId, estimatedCostUsd: estimatedCostUsd.toFixed(12) })
      .returning({ id: budgetReservations.id })
    if (!inserted) throw new Error('budget reservation insert returned no row')
    return { allowed: true, reservationId: inserted.id }
  })
}

/** Release an in-flight reservation after its metered call settles (best-effort). */
export async function releaseReservation(userId: string, reservationId: string): Promise<void> {
  await withTenant(userId, (tx) =>
    tx.delete(budgetReservations).where(eq(budgetReservations.id, reservationId)),
  )
}

/** One row to upsert into user_budgets (operator override + optional window). */
export interface UserBudgetWrite {
  /** USD override; null clears it (fall back to the tier cap). */
  capUsdOverride: number | null
  periodStart?: Date | null
  periodEnd?: Date | null
}

/** The current user_budgets row for `userId`, or undefined if none exists yet. */
export interface UserBudgetRow {
  capUsdOverride: number | null
  periodStart: Date | null
  periodEnd: Date | null
}

/**
 * Set ONLY the cycle window for `userId`, preserving any operator cap override. A
 * platform state machine calls this to project an external plan's
 * period-start/period-end onto the budget window — initialized at signup and
 * rolled on each renewal so consumption resets at the plan boundary. Unlike
 * {@link setUserBudget} it never touches `cap_usd_override`, so a window roll
 * cannot clobber an operator cap.
 */
export async function setBudgetWindow(
  userId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<void> {
  await withTenant(userId, (tx) => setBudgetWindowInTx(tx, userId, periodStart, periodEnd))
}

/** Set the cycle window within an existing transaction (atomic apply). */
export async function setBudgetWindowInTx(
  tx: TenantTx,
  userId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<void> {
  await tx
    .insert(userBudgets)
    .values({ userId, periodStart, periodEnd, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: userBudgets.userId,
      set: { periodStart, periodEnd, updatedAt: sql`now()` },
    })
}

/** Read the raw user_budgets row (operator endpoint GET). */
export async function getUserBudget(userId: string): Promise<UserBudgetRow | undefined> {
  return withTenant(userId, async (tx) => {
    const [row] = await tx
      .select({
        capUsdOverride: userBudgets.capUsdOverride,
        periodStart: userBudgets.periodStart,
        periodEnd: userBudgets.periodEnd,
      })
      .from(userBudgets)
      .where(eq(userBudgets.userId, userId))
      .limit(1)
    if (!row) return undefined
    return {
      capUsdOverride: row.capUsdOverride != null ? Number(row.capUsdOverride) : null,
      periodStart: row.periodStart ?? null,
      periodEnd: row.periodEnd ?? null,
    }
  })
}

/**
 * Upsert the operator-managed user_budgets row for `userId` (operator endpoint
 * PUT). One row per user (unique user_id); numeric columns take a string.
 */
export async function setUserBudget(userId: string, write: UserBudgetWrite): Promise<void> {
  await withTenant(userId, async (tx) => {
    await tx
      .insert(userBudgets)
      .values({
        userId,
        capUsdOverride: write.capUsdOverride == null ? null : write.capUsdOverride.toFixed(12),
        periodStart: write.periodStart ?? null,
        periodEnd: write.periodEnd ?? null,
        updatedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: userBudgets.userId,
        set: {
          capUsdOverride: write.capUsdOverride == null ? null : write.capUsdOverride.toFixed(12),
          ...(write.periodStart !== undefined ? { periodStart: write.periodStart } : {}),
          ...(write.periodEnd !== undefined ? { periodEnd: write.periodEnd } : {}),
          updatedAt: sql`now()`,
        },
      })
  })
}
