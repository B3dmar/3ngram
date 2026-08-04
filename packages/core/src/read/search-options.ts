// SPDX-License-Identifier: Apache-2.0
// Shared option contracts and resolution for core search surfaces. Keeping
// policy application here makes search() and dashboard pagination enforce the
// same scope semantics before either path performs metered or database work.
import { DEFAULT_SUPERSESSION_PENALTY, type FusionWeights, type SearchFilters } from '@3ngram/db'
import type { AccessGate, BudgetEnforcement } from '../budget/index.js'
import { applyPolicyToScopeFilter, type RetrievalPolicy } from './retrieval-policy.js'

/**
 * Product default fusion weights. The db default keeps vector search inert for
 * backwards compatibility; this core policy deliberately enables it.
 *
 * The blocking golden-set floors are recall@5 >= 0.9773, mrr@5 >= 0.9697,
 * supersession_correct >= 0.9474, and abstention == 1.0. A vector-led mix with
 * no recency contribution reproduces the exact-cosine baseline while a small
 * FTS contribution retains exact-term pool recall. Recency above zero demotes a
 * gold row enough to miss the MRR floor, while FTS above 0.3 crosses the same
 * cliff; 0.2 is the calibrated safe margin.
 */
export const DEFAULT_SEARCH_WEIGHTS: FusionWeights = { fts: 0.2, recency: 0, vector: 1 }

/**
 * Product supersession policy. The db tier penalty exceeds any positive base
 * score, so a predecessor remains retrievable but ranks below every live row.
 */
export const DEFAULT_SEARCH_SUPERSESSION_PENALTY = DEFAULT_SUPERSESSION_PENALTY

/** Default result window. Matches the eval harness K. */
const DEFAULT_LIMIT = 5

/** Tunable search options. All have product-default policy values. */
export interface SearchOptions {
  /** Max hits to return. Defaults to 5. */
  limit?: number
  /** Stable keyset cursor for the previous page's final `(score, id)` row. */
  cursor?: { score: number; id: string }
  /** Fusion weights. Defaults to {@link DEFAULT_SEARCH_WEIGHTS}. */
  weights?: FusionWeights
  /** Defaults to {@link DEFAULT_SEARCH_SUPERSESSION_PENALTY}. */
  supersessionPenalty?: number
  /**
   * Candidate-narrowing filters applied before fusion. Values are validated at
   * the transport schema boundary; core trusts this typed shape.
   */
  filters?: SearchFilters
  /** Optional metered-read budget gate for gateway-backed embeddings. */
  budget?: BudgetEnforcement | undefined
  /** Optional read-access gate, independent of budget enforcement. */
  access?: AccessGate | undefined
  /**
   * Per-user retrieval-scope policy resolved once by the transport. Presence
   * changes search() to return its scoped result envelope; mode `require`
   * rejects an unscoped request before embedding.
   */
  retrievalPolicy?: RetrievalPolicy | undefined
}

/** Options for dashboard search. `frozen` identifies a continuation page. */
export interface DashboardPageOptions {
  limit?: number
  filters?: SearchFilters
  /**
   * Frozen ordering and current offset decoded from a continuation cursor.
   * `policyScope` is absent only on legacy state; new walks bind the nullable
   * scope applied by the retrieval policy so a later policy change restarts.
   */
  frozen?: {
    ids: string[]
    scores: number[]
    off: number
    policyScope?: string | null
  }
  /** Optional metered-read budget gate for the first-page query embedding. */
  budget?: BudgetEnforcement | undefined
  /** Optional read-access gate, asserted for both first and later pages. */
  access?: AccessGate | undefined
  /** Scope policy re-applied on every page so continuations cannot widen. */
  retrievalPolicy?: RetrievalPolicy | undefined
}

interface PolicyBoundOptions {
  filters?: SearchFilters
  retrievalPolicy?: RetrievalPolicy | undefined
}

function resolvePolicyFilters(opts: PolicyBoundOptions): {
  appliedScope: string | null
  filters: SearchFilters
} {
  const policyScope = applyPolicyToScopeFilter(opts.retrievalPolicy, opts.filters?.scope)
  const filters =
    policyScope.scope !== undefined
      ? { ...(opts.filters ?? {}), scope: policyScope.scope }
      : (opts.filters ?? {})
  return { appliedScope: policyScope.appliedScope, filters }
}

/** Count whitespace-delimited tokens for the short-query topic-match policy. */
function queryTokenCount(query: string): number {
  return query.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Add the topic-match entity bonus for short queries without disturbing the
 * calibrated FTS weight. An explicit topicMatch value always wins.
 */
function resolveWeights(query: string, weights: FusionWeights): FusionWeights {
  if (queryTokenCount(query) <= 2 && weights.topicMatch === undefined) {
    return { ...weights, topicMatch: 0.5 }
  }
  return weights
}

/** Resolve the effective query, ranking, and policy options for search(). */
export function resolveSearchOptions(query: string, opts: SearchOptions) {
  const policy = resolvePolicyFilters(opts)
  return {
    ...policy,
    limit: opts.limit ?? DEFAULT_LIMIT,
    cursor: opts.cursor,
    weights: resolveWeights(query, opts.weights ?? DEFAULT_SEARCH_WEIGHTS),
    supersessionPenalty: opts.supersessionPenalty ?? DEFAULT_SEARCH_SUPERSESSION_PENALTY,
  }
}

/** Resolve the shared page size and scope policy for dashboard search. */
export function resolveDashboardPageOptions(query: string, opts: DashboardPageOptions) {
  return {
    ...resolvePolicyFilters(opts),
    limit: opts.limit ?? DEFAULT_LIMIT,
    weights: resolveWeights(query, DEFAULT_SEARCH_WEIGHTS),
    supersessionPenalty: DEFAULT_SEARCH_SUPERSESSION_PENALTY,
  }
}
