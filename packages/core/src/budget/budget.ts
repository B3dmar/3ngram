// SPDX-License-Identifier: Apache-2.0
// Apache per-user budget gate.
//
// THE pre-operation cost check. It is FORWARD-LOOKING: before a metered LLM op
// runs, it compares (consumed-this-cycle + the op's worst-case maxCost) against
// the user's EFFECTIVE cap and rejects when the next op would cross 100% of it —
// so an over-cap op is rejected BEFORE any spend is incurred. There is no soft
// band; the configured cap is the absolute ceiling.
//
// Effective cap, resolved at RUNTIME (never denormalized), so a plan_tiers cap
// edit applies immediately with no propagation job:
//     cap_usd_override ?? plan_tiers[tier].cap_usd ?? config.defaultCapUsd
// where `tier` comes from the INJECTED {@link LimitsResolver} (NOT a plan join).
// Self-host resolves NO tier (undefined), so the plan_tiers lookup is skipped and
// the resolver falls through to config.defaultCapUsd: self-host still gets a
// working cap, never "no row → no cap".
//
// FAIL-OPEN: if the consumption lookup itself errors, the op is
// ALLOWED and the injected alert hook fires — a transient usage-store hiccup must
// not become a write outage for everyone. A MISSING maxCost is different: that is
// a config error and fails CLOSED (the estimate is computed before the fail-open
// boundary, so its throw propagates).
//
// This module is env-free. The limits resolver, budget config, logger, and
// alert hook are all INJECTED — core never reads process.env or imports config.
import {
  type BudgetAccounting,
  getBudgetAccounting,
  releaseReservation,
  reserveBudget,
} from '@3ngram/db'
import { maxCostUsdForOperation, maxRegisteredCostUsd } from '@3ngram/llm'
import type { ResourceLimits } from '@3ngram/schema'

/**
 * Limits an injected policy may supply for a user. Resource fields come from
 * the public billing-neutral ResourceLimits contract; `tier` selects a
 * `plan_tiers` budget cap and `windowDays` overrides its rolling window. Every
 * field is optional, so the Apache default is simply `{}`.
 */
export interface Limits extends ResourceLimits {
  tier?: string
  windowDays?: number
}

/** Resolves the per-user {@link Limits} the budget gate applies. Injected. */
export type LimitsResolver = (userId: string) => Promise<Limits>

/** Apache self-host: no resource caps, tier, or window override. */
export const SELFHOST_LIMITS: Limits = {}

/**
 * Effective consumption for the gate: priced llm_usage + UNPRICED rows charged a
 * conservative fallback (the max registered op cost) + in-flight reservations.
 * Charging unpriced usage stops an unpriced-model config from silently bypassing
 * the cap (a row with NULL cost_usd would otherwise never accrue).
 */
function effectiveConsumed(accounting: BudgetAccounting): number {
  return (
    accounting.consumedUsd +
    accounting.unpricedCount * maxRegisteredCostUsd() +
    accounting.reservationsUsd
  )
}

/** Minimal pino-shaped logger surface (obj-then-msg), injected like embed.ts. */
export interface BudgetLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

const noopLogger: BudgetLogger = { warn: () => {} }

/**
 * The budget fallbacks the gate needs. A structural subset of @3ngram/config's
 * BudgetConfig (apps pass that directly) — declared here so core stays
 * config-free.
 */
export interface BudgetConfig {
  /** Fallback cap (USD) when no override and no plan_tiers row apply. */
  defaultCapUsd: number
  /** Fallback rolling-window length (days) when no explicit window is set. */
  defaultWindowDays: number
}

/**
 * Injected dependencies for the budget gate. `resolveLimits` resolves the per-user
 * {@link Limits} (tier + optional window; the budget NEVER joins a plan table
 * directly); `config` carries the Apache budget fallbacks. `onLookupFailure` lets
 * the app layer emit the OTel alert counter on fail-open without core importing
 * @3ngram/config. When this object is wired at the composition root, every metered
 * embed seam is capped (no ungated path).
 */
export interface BudgetEnforcement {
  resolveLimits: LimitsResolver
  config: BudgetConfig
  logger?: BudgetLogger | undefined
  /** Fired on fail-open (consumption lookup error) with the bounded op key. */
  onLookupFailure?: ((operation: string) => void) | undefined
}

/**
 * Raised when a metered op would exceed the user's effective budget cap. Carries
 * the bounded operation key ONLY — never the cap, consumption, or any content/
 * cost internals (never leaking cost internals). Transports map
 * it to a clear over-budget denial.
 */
export class BudgetExceededError extends Error {
  constructor(public readonly operation: string) {
    super(`operation '${operation}' would exceed the usage budget`)
    this.name = 'BudgetExceededError'
  }
}

/**
 * Assert that `operation` for `userId` stays within the effective budget cap.
 *
 * Throws {@link BudgetExceededError} when over cap (the only intentional
 * rejection). Resolves (allows) when under cap, or when the consumption lookup
 * fails (fail-open + alert). Throws a config error if `operation` has no
 * registered maxCost (fail-closed, computed before the fail-open boundary).
 */
export async function assertWithinBudget(
  enforcement: BudgetEnforcement,
  userId: string,
  operation: string,
): Promise<void> {
  // Fail CLOSED on an unregistered operation: a missing estimate is a config bug,
  // not a transient error, so this throw must NOT be swallowed by the fail-open
  // catch below — compute it first.
  const estimatedCost = maxCostUsdForOperation(operation)
  const logger = enforcement.logger ?? noopLogger

  let overCap = false
  try {
    const { tier, windowDays } = await enforcement.resolveLimits(userId)
    const accounting = await getBudgetAccounting(
      userId,
      tier,
      windowDays ?? enforcement.config.defaultWindowDays,
    )
    const effectiveCap =
      accounting.capUsdOverride ?? accounting.tierCapUsd ?? enforcement.config.defaultCapUsd
    // Absolute ceiling, no soft band: reject when the NEXT op would cross 100%.
    overCap = effectiveConsumed(accounting) + estimatedCost > effectiveCap
  } catch (error) {
    // FAIL OPEN: a usage-store/limits lookup error allows the op and fires
    // the injected alert hook rather than blocking writes for everyone. Bounded
    // label only — never content, never the raw error message (hard rule 6).
    enforcement.onLookupFailure?.(operation)
    logger.warn(
      { operation, reason: error instanceof Error ? error.name : 'unknown' },
      'budget gate lookup failed; failing open (operation allowed)',
    )
    return
  }

  if (overCap) throw new BudgetExceededError(operation)
}

/** Handle for an in-flight reservation; release it after the metered call. */
export interface BudgetReservationHandle {
  /** Reservation row id to release; undefined when the gate failed open. */
  reservationId?: string | undefined
}

/**
 * ATOMICALLY reserve budget for `operation` before a metered call.
 *
 * Unlike {@link assertWithinBudget} (a read-only pre-check that can race), this
 * holds a per-user advisory lock while it checks committed spend + in-flight
 * reservations and inserts its own reservation — so concurrent near-cap requests
 * cannot all pass and overshoot the cap. Use it at the SPEND seam (immediately
 * before the gateway round-trip) and {@link releaseBudgetReservation} it in a
 * `finally`. Throws {@link BudgetExceededError} when over cap; fails OPEN (returns
 * an empty handle + alert) on a lookup error; fails CLOSED on an unregistered op.
 */
export async function reserveBudgetSlot(
  enforcement: BudgetEnforcement,
  userId: string,
  operation: string,
): Promise<BudgetReservationHandle> {
  const estimatedCost = maxCostUsdForOperation(operation)
  const logger = enforcement.logger ?? noopLogger
  let reservation: Awaited<ReturnType<typeof reserveBudget>>
  try {
    const { tier, windowDays } = await enforcement.resolveLimits(userId)
    reservation = await reserveBudget(
      userId,
      tier,
      windowDays ?? enforcement.config.defaultWindowDays,
      enforcement.config.defaultCapUsd,
      estimatedCost,
      maxRegisteredCostUsd(),
    )
  } catch (error) {
    enforcement.onLookupFailure?.(operation)
    logger.warn(
      { operation, reason: error instanceof Error ? error.name : 'unknown' },
      'budget reservation failed; failing open (operation allowed)',
    )
    return {}
  }
  if (!reservation.allowed) throw new BudgetExceededError(operation)
  return { reservationId: reservation.reservationId }
}

/** Release a reservation after its metered call settles. Best-effort (never throws). */
export async function releaseBudgetReservation(
  userId: string,
  handle: BudgetReservationHandle,
): Promise<void> {
  if (handle.reservationId === undefined) return
  await releaseReservation(userId, handle.reservationId).catch(() => {})
}

/** A user's current budget status (read-only view for an operator/self read). */
export interface BudgetStatus {
  /** The cap actually in force (override ?? tier cap ?? config default), USD. */
  effectiveCapUsd: number
  /** Spend so far this cycle (USD). */
  consumedUsd: number
  /** The per-user operator override (USD), or null when none is set. */
  capUsdOverride: number | null
  /** The cycle window the consumption is summed over. */
  periodStart: Date | null
  periodEnd: Date | null
}

/**
 * Read `userId`'s current budget status (effective cap + consumed this cycle).
 * Thin-transport helper so the REST/MCP layers never touch the db directly. Does
 * NOT fail open — a read endpoint should surface the error, not mask it.
 */
export async function getBudgetStatus(
  enforcement: BudgetEnforcement,
  userId: string,
): Promise<BudgetStatus> {
  const { tier, windowDays } = await enforcement.resolveLimits(userId)
  const accounting: BudgetAccounting = await getBudgetAccounting(
    userId,
    tier,
    windowDays ?? enforcement.config.defaultWindowDays,
  )
  const effectiveCapUsd =
    accounting.capUsdOverride ?? accounting.tierCapUsd ?? enforcement.config.defaultCapUsd
  return {
    effectiveCapUsd,
    // Committed spend incl. the unpriced-usage fallback; transient in-flight
    // reservations are excluded from the displayed total (they are not yet spend).
    consumedUsd: accounting.consumedUsd + accounting.unpricedCount * maxRegisteredCostUsd(),
    capUsdOverride: accounting.capUsdOverride,
    periodStart: accounting.periodStart,
    periodEnd: accounting.periodEnd,
  }
}
