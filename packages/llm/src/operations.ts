// SPDX-License-Identifier: Apache-2.0
// Operation cost registry.
//
// Every METERED LLM operation has a registered, forward-looking `maxCostUsd` —
// the worst-case cost of ONE call. The Apache budget gate (packages/core) uses it
// as the estimate it adds to a user's consumption BEFORE the call, so an over-cap
// operation is rejected before any spend is incurred (no ungated embed path).
//
// A missing entry is a CONFIG ERROR, not a runtime fail-open: it is caught at
// startup by assertMeteredOperationsRegistered() so a new metered op can never
// ship without a cap estimate. (The gate only fails OPEN for a transient
// consumption-lookup error — never for an unregistered operation.)

/**
 * Canonical metered embed-operation keys. These MUST equal the operation strings
 * the core call sites pass to `gateway.embed(...)`:
 *   - `memory.embed`  → write path (remember/revise/repair, packages/core/src/write/embed.ts)
 *   - `import.embed`  → import facade (packages/core/src/import/index.ts)
 *   - `search`        → read-path query embed (packages/core/src/read/search.ts)
 * A unit test asserts the registry covers each (drift guard).
 */
export const METERED_EMBED_OPERATIONS = ['memory.embed', 'import.embed', 'search'] as const
export type MeteredEmbedOperation = (typeof METERED_EMBED_OPERATIONS)[number]

/**
 * The cost/tier surface an operation belongs to.
 *   - `embed`      — embedding-powered (memory/search). The FREE surface.
 *   - `generation` — `gateway.complete()`-powered (entity extraction, digests,
 *                    reasoning bots, RAG answers). The PAID surface.
 * Maps 1:1 to the `plan_tiers.capabilities.llm_generation`
 * (`embed → false`, `generation → true`). The cost model and
 * 004's future capability gate read this single source — no divergence.
 */
export type CapabilityClass = 'embed' | 'generation'

const CAPABILITY_CLASSES: readonly CapabilityClass[] = ['embed', 'generation']

/** Registry entry: the budget-relevant cost ceiling + capability class of an operation. */
export interface LlmOperation {
  /**
   * Worst-case forward-looking cost of a SINGLE call, in USD. The budget gate
   * compares `consumed + maxCostUsd` against the effective cap and rejects when
   * the next call would exceed 100% of it. Deliberately a ceiling (not an
   * average) so the gate never lets spend cross the cap.
   */
  maxCostUsd: number
  /** Which tier surface this operation belongs to. */
  capabilityClass: CapabilityClass
}

// Basis for the embed ceiling: the most expensive embedding list price times the
// model's maximum input. text-embedding-3-large bills $0.13/1M tokens and bounds
// input at 8,192 tokens, so one call can cost at most ~$0.00106. Using the
// priciest model keeps the estimate conservative even if a cheaper model is used.
const MAX_EMBED_INPUT_TOKENS = 8192
const MOST_EXPENSIVE_EMBED_RATE_USD_PER_TOKEN = 0.13 / 1_000_000
const MAX_EMBED_CALL_COST_USD = MAX_EMBED_INPUT_TOKENS * MOST_EXPENSIVE_EMBED_RATE_USD_PER_TOKEN

/**
 * Operation → cost ceiling. All embed operations are a single `gateway.embed()`
 * round-trip, so they share the same worst-case bound; they are listed
 * separately so a future per-operation tuning (e.g. larger import batches) is a
 * one-line edit here, the single source.
 */
export const llmOperations: Readonly<Record<string, LlmOperation>> = {
  'memory.embed': { maxCostUsd: MAX_EMBED_CALL_COST_USD, capabilityClass: 'embed' },
  'import.embed': { maxCostUsd: MAX_EMBED_CALL_COST_USD, capabilityClass: 'embed' },
  search: { maxCostUsd: MAX_EMBED_CALL_COST_USD, capabilityClass: 'embed' },
}

/** Thrown when an operation has no registered `maxCost` — a config error. */
export class LlmOperationNotRegisteredError extends Error {
  constructor(public readonly operation: string) {
    super(`LLM operation '${operation}' has no registered maxCost`)
    this.name = 'LlmOperationNotRegisteredError'
  }
}

/**
 * The registered worst-case cost for `operation`. Throws
 * {@link LlmOperationNotRegisteredError} for an unregistered operation — the
 * budget gate must fail CLOSED on a missing estimate (a config bug), distinct
 * from the fail-OPEN behaviour on a transient consumption-lookup error.
 */
export function maxCostUsdForOperation(operation: string): number {
  const entry = llmOperations[operation]
  if (entry === undefined) throw new LlmOperationNotRegisteredError(operation)
  return entry.maxCostUsd
}

/**
 * The capability class for `operation`. Throws
 * {@link LlmOperationNotRegisteredError} for an unregistered operation — the cost
 * model and the future capability gate must fail CLOSED on an unknown operation,
 * never silently treat it as free.
 */
export function capabilityClassForOperation(operation: string): CapabilityClass {
  const entry = llmOperations[operation]
  if (entry === undefined) throw new LlmOperationNotRegisteredError(operation)
  return entry.capabilityClass
}

/**
 * The MAX registered `maxCost` across all operations. Used as the conservative
 * per-row charge for UNPRICED usage (a row whose model is not in the price map,
 * so its `cost_usd` is NULL): counting it at the highest known op cost keeps an
 * unpriced-model configuration from silently bypassing the budget cap.
 */
export function maxRegisteredCostUsd(): number {
  return Object.values(llmOperations).reduce((max, op) => Math.max(max, op.maxCostUsd), 0)
}

/**
 * Startup gate: every known metered operation MUST have a registry entry with a
 * valid `maxCost` AND a valid `capabilityClass`. Call this once at process boot
 * so a missing entry or an invalid class is a loud boot failure, not a silent
 * runtime surprise on the first metered op.
 */
export function assertMeteredOperationsRegistered(): void {
  for (const operation of METERED_EMBED_OPERATIONS) {
    const entry = llmOperations[operation]
    if (entry === undefined) {
      throw new LlmOperationNotRegisteredError(operation)
    }
    if (!CAPABILITY_CLASSES.includes(entry.capabilityClass)) {
      throw new LlmOperationNotRegisteredError(operation)
    }
  }
}
