// SPDX-License-Identifier: Apache-2.0
// search(): the unified retrieval policy surface.
//
// apps -> core -> db layering (hard rule 5): this is the policy half of unified
// search. packages/db owns the SQL for the fusion LEGS (search.ts: searchFused);
// THIS module owns the PRODUCT POLICY — the default fusion weights that enable
// the vector leg, the supersession-aware ranking default, query-embedding
// acquisition (via an injected Gateway), and the redaction of query
// text. Transports (REST/MCP) call this and hold zero business logic.
//
// Input validation is the transport's responsibility (packages/schema
// searchInputSchema parsed by REST/MCP before calling core — hard rule 2). The
// TypeScript EmbeddingSource discriminated union is the compile-time contract for
// the gateway-vs-precomputed-embedding dual path.
//
// EMBEDDING ACQUISITION: core NEVER constructs an LLM provider. It
// accepts EITHER an injected Gateway (FakeGateway in unit tests, the real
// gateway in apps) and embeds the query via gateway.embed([query], 'search'),
// OR a pre-computed queryEmbedding (the cached-embeddings path the golden-set
// integration test uses to score against real-model vectors without a network
// call). Exactly one of the two must be provided.
//
// Observability (hard rule 6): the query TEXT is a REDACTED field — it is NEVER
// logged, traced, or returned in an error message. This module logs only
// lengths/ids/counts. The returned hits carry memory content (that is the read
// payload, not a log), but no log line here echoes it.
import {
  type SearchFilters as DbSearchFilters,
  EMBEDDING_DIMENSIONS,
  fetchHitsByIds,
  InvalidEmbeddingError,
  insertLlmUsage,
  searchFused,
  withTenant,
} from '@3ngram/db'
import type { Gateway } from '@3ngram/llm'
import {
  type BudgetEnforcement,
  type BudgetReservationHandle,
  releaseBudgetReservation,
  reserveBudgetSlot,
} from '../budget/index.js'
import { DEFAULT_EMBEDDING_MODEL, embeddingCostUsd } from '../write/embed.js'
import type { RetrievalPolicy } from './retrieval-policy.js'
import {
  type DashboardPageOptions,
  resolveDashboardPageOptions,
  resolveSearchOptions,
  type SearchOptions,
} from './search-options.js'
import {
  type ScopedSearchResult,
  type SearchHit,
  shapeSearchHit,
  shapeSearchResult,
} from './search-results.js'

/** Gateway operation key for query embeddings — meters search cost distinctly
 * from write-path embeddings. */
const SEARCH_EMBED_OPERATION = 'search'

export type { FusionWeights, SearchAsOf, SearchFilters } from '@3ngram/db'
export {
  type DashboardPageOptions,
  DEFAULT_SEARCH_SUPERSESSION_PENALTY,
  DEFAULT_SEARCH_WEIGHTS,
  type SearchOptions,
} from './search-options.js'
export type { ScopedSearchResult, SearchHit } from './search-results.js'

/**
 * A core search hit: the db fused hit with its `content` bounded to the
 * read-result EXCERPT (packages/schema MAX_EXCERPT_LENGTH; stored
 * content can exceed any write-time cap via the import path). `contentLength`
 * carries the FULL stored length and `truncated` flags a cut excerpt (the text
 * then ends with EXCERPT_MARKER), so a caller can fetch the full memory by id.
 * Excerpting here is read-path POLICY (docs/concepts/architecture.mdx): REST and MCP both inherit the
 * bounded shape from this one surface.
 */
/** Either an injected Gateway (embed the query) or a pre-computed embedding. */
export type EmbeddingSource =
  | { gateway: Gateway; queryEmbedding?: undefined }
  | { gateway?: undefined; queryEmbedding: number[] }

/**
 * Unified search for `userId`.
 *
 * Embeds the query via the injected `source.gateway` (gateway.embed([query],
 * 'search')) OR uses the pre-computed `source.queryEmbedding`, then runs the
 * weighted FTS + recency + vector fusion (packages/db searchFused) inside a
 * withTenant transaction (hard rule 3: RLS scopes rows to the caller). Ranking
 * is supersession-AWARE, never supersession-FILTERED (docs/concepts/memory-model.mdx): superseded
 * predecessors rank below their successors but remain retrievable.
 *
 * Optional `opts.filters` (type/scope/project/status/asOf)
 * narrow the candidate set BEFORE fusion (threaded to searchFused unchanged).
 * They do NOT alter the fusion weights or the supersession ranking. With no
 * `asOf` the supersession-aware live view is the default; supplying `asOf`
 * surfaces superseded history (docs/concepts/memory-model.mdx: surface when asked, never silently
 * drop). See {@link SearchOptions.filters}.
 *
 * Input validation (empty query, enum constraints) is the transport's
 * responsibility (packages/schema searchInputSchema — hard rule 2).
 *
 * @param userId  Tenant whose RLS context the read runs under.
 * @param query   Raw query text. REDACTED — never logged (hard rule 6).
 * @param source  Gateway to embed with, or a pre-computed query embedding.
 * @param opts    Optional limit / weights / supersession penalty / filters.
 * RETRIEVAL-SCOPE POLICY (issue #47): with `opts.retrievalPolicy` injected the
 * scope FILTER axis is policy-enforced (retrieval-policy.ts: `default` fills a
 * missing scope filter, `require` rejects the unscoped call typed) and the
 * return type is the {@link ScopedSearchResult} ENVELOPE so the `appliedScope`
 * echo rides the result — the overloads keep the shipped plain-hits contract
 * for every policy-less caller (published-API stability, the briefing()
 * overload precedent).
 *
 * @throws {@link InvalidEmbeddingError} if a pre-computed embedding is not
 *   exactly {@link EMBEDDING_DIMENSIONS}-wide (validated at the boundary, never
 *   an opaque pgvector failure).
 * @throws {@link UnscopedRetrievalError} policy mode `require` and no scope
 *   filter (thrown before any metered work).
 */
export async function search(
  userId: string,
  query: string,
  source: EmbeddingSource,
  opts: SearchOptions & { retrievalPolicy: RetrievalPolicy },
): Promise<ScopedSearchResult>
export async function search(
  userId: string,
  query: string,
  source: EmbeddingSource,
  opts?: Omit<SearchOptions, 'retrievalPolicy'> & { retrievalPolicy?: undefined },
): Promise<SearchHit[]>
export async function search(
  userId: string,
  query: string,
  source: EmbeddingSource,
  opts: SearchOptions,
): Promise<SearchHit[] | ScopedSearchResult>
export async function search(
  userId: string,
  query: string,
  source: EmbeddingSource,
  opts: SearchOptions = {},
): Promise<SearchHit[] | ScopedSearchResult> {
  // ACCESS GUARD: the injected access gate denies reads when the platform policy
  // forbids them (self-host allowAllAccess allows all). Search is a READ — it is
  // NEVER write-guarded, so a read-only user keeps search, bounded only by the
  // budget cap.
  if (opts.access) await opts.access.assertRead(userId)

  // RETRIEVAL-SCOPE POLICY: enforced BEFORE the query embed so a `require`
  // rejection never burns budget/gateway work, and a `default` narrowing is
  // decided before any query runs. The caller's explicit scope always wins.
  const { appliedScope, cursor, filters, limit, supersessionPenalty, weights } =
    resolveSearchOptions(query, opts)

  const { gateway, queryEmbedding: precomputed } = source

  const queryEmbedding =
    precomputed ?? (await embedQuery(userId, gateway as Gateway, query, opts.budget))
  if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    // Boundary validation: reject a malformed pre-computed embedding here with a
    // typed error (the gateway path is bounded by the provider contract).
    throw new InvalidEmbeddingError(queryEmbedding.length)
  }

  const hits = await withTenant(userId, (tx) =>
    searchFused(
      tx,
      userId,
      query,
      limit,
      weights,
      supersessionPenalty,
      queryEmbedding,
      filters,
      cursor,
    ),
  )
  return shapeSearchResult(hits, appliedScope, opts.retrievalPolicy !== undefined)
}

/** The page-1 ranked ordering frozen into the dashboard cursor. */
export interface FrozenOrdering {
  ids: string[]
  scores: number[]
  /** Nullable policy-applied scope frozen at page 1. */
  policyScope: string | null
}

/** One dashboard search page plus the frozen ordering and the next offset. */
export interface DashboardSearchPage {
  hits: SearchHit[]
  frozen: FrozenOrdering
  /** Offset of the NEXT page within `frozen.ids` (the value the cursor carries). */
  nextOffset: number
  hasMore: boolean
  /**
   * The scope the injected retrieval policy applied to an unscoped call
   * (issue #47) — `null` when nothing was narrowed (no policy, mode `off`, or
   * an explicit caller scope). Recomputed identically on every page of a walk
   * (the policy applies to the filters BEFORE the frozen-ordering machinery),
   * so the echo never drifts mid-walk.
   */
  appliedScope: string | null
}

type FrozenPageState = NonNullable<DashboardPageOptions['frozen']>
type ResolvedDashboardPageOptions = ReturnType<typeof resolveDashboardPageOptions>

interface CollectedFrozenHit {
  hit: SearchHit
  posAfter: number
}

/** A legacy state can continue only while no policy scope is being applied. */
function shouldRestartFrozenWalk(frozen: FrozenPageState, appliedScope: string | null): boolean {
  if (frozen.policyScope === undefined) return appliedScope !== null
  return frozen.policyScope !== appliedScope
}

/** Collect one page plus one eligible probe row from a frozen ordering. */
async function collectFrozenHits(
  userId: string,
  frozen: FrozenPageState,
  filters: DbSearchFilters,
  limit: number,
): Promise<{ collected: CollectedFrozenHit[]; cursor: number }> {
  const collected: CollectedFrozenHit[] = []
  let cursor = frozen.off
  while (collected.length <= limit && cursor < frozen.ids.length) {
    const sliceIds = frozen.ids.slice(cursor, cursor + limit)
    const rows = await withTenant(userId, (tx) => fetchHitsByIds(tx, userId, sliceIds, filters))
    const byId = new Map(rows.map((row) => [row.id, row]))
    sliceIds.forEach((id, index) => {
      const row = byId.get(id)
      if (row === undefined) return
      const position = cursor + index
      collected.push({
        hit: shapeSearchHit({ ...row, score: frozen.scores[position] ?? row.score }),
        posAfter: position + 1,
      })
    })
    cursor += sliceIds.length
  }
  return { collected, cursor }
}

/** Shape a collected continuation while retaining its verified scope binding. */
function frozenDashboardPage(
  frozen: FrozenPageState,
  collected: CollectedFrozenHit[],
  cursor: number,
  limit: number,
  appliedScope: string | null,
): DashboardSearchPage {
  const hasMore = collected.length > limit
  const page = collected.slice(0, limit)
  const nextOffset = hasMore ? (page[page.length - 1]?.posAfter ?? cursor) : frozen.ids.length
  return {
    hits: page.map((entry) => entry.hit),
    frozen: { ids: frozen.ids, scores: frozen.scores, policyScope: appliedScope },
    nextOffset,
    hasMore,
    appliedScope,
  }
}

/** Read a verified continuation without embedding or reranking. */
async function continueDashboardPage(
  userId: string,
  frozen: FrozenPageState,
  resolved: ResolvedDashboardPageOptions,
): Promise<DashboardSearchPage> {
  const { collected, cursor } = await collectFrozenHits(
    userId,
    frozen,
    resolved.filters,
    resolved.limit,
  )
  return frozenDashboardPage(frozen, collected, cursor, resolved.limit, resolved.appliedScope)
}

/** Rank page 1 and bind its complete frozen ordering to the applied policy scope. */
async function rankDashboardPage(
  userId: string,
  query: string,
  source: EmbeddingSource,
  budget: BudgetEnforcement | undefined,
  resolved: ResolvedDashboardPageOptions,
): Promise<DashboardSearchPage> {
  const { gateway, queryEmbedding: precomputed } = source
  const queryEmbedding =
    precomputed ?? (await embedQuery(userId, gateway as Gateway, query, budget))
  if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new InvalidEmbeddingError(queryEmbedding.length)
  }
  const ranked = await withTenant(userId, (tx) =>
    searchFused(
      tx,
      userId,
      query,
      resolved.limit,
      resolved.weights,
      resolved.supersessionPenalty,
      queryEmbedding,
      resolved.filters,
      undefined,
      { returnFullPool: true },
    ),
  )
  return {
    hits: ranked.slice(0, resolved.limit).map(shapeSearchHit),
    frozen: {
      ids: ranked.map((hit) => hit.id),
      scores: ranked.map((hit) => hit.score),
      policyScope: resolved.appliedScope,
    },
    nextOffset: resolved.limit,
    hasMore: ranked.length > resolved.limit,
    appliedScope: resolved.appliedScope,
  }
}

/**
 * Stable dashboard search pagination. The FIRST page (no `frozen`)
 * ranks the bounded candidate pool ONCE and returns the full ranked ordering;
 * the caller freezes `frozen` into the cursor and serves the first `limit` hits.
 * A CONTINUATION page (`frozen` set) pages BY POSITION within that frozen
 * ordering — fetching the slice's rows by id and applying the FROZEN scores and
 * order — so mid-session corpus drift cannot move a row across a page boundary
 * (no duplicates, no skips). Embedding is acquired only on the first page; a
 * continuation does no ranking. Page 1 also binds the frozen ordering to the
 * nullable scope applied by the retrieval policy. A changed policy scope, or a
 * legacy unbound state under an active default, safely restarts at page 1.
 */
export async function searchDashboardPage(
  userId: string,
  query: string,
  source: EmbeddingSource,
  opts: DashboardPageOptions = {},
): Promise<DashboardSearchPage> {
  if (opts.access) await opts.access.assertRead(userId)
  const resolved = resolveDashboardPageOptions(query, opts)
  if (opts.frozen !== undefined && !shouldRestartFrozenWalk(opts.frozen, resolved.appliedScope)) {
    return continueDashboardPage(userId, opts.frozen, resolved)
  }
  return rankDashboardPage(userId, query, source, opts.budget, resolved)
}

/**
 * Embed the query via the injected gateway. Core never constructs a
 * provider — the gateway is injected. The 'search' operation tag lets the
 * gateway route/meter query embeddings distinctly from write embeddings.
 *
 * Hard rule 6: a failure here must not leak the query text — the gateway
 * contract owns its own (redacted) error surface; we add no context that echoes
 * the query.
 */
async function embedQuery(
  userId: string,
  gateway: Gateway,
  query: string,
  budget: BudgetEnforcement | undefined,
): Promise<number[]> {
  // Read-path budget gate: ATOMICALLY reserve
  // the cap BEFORE the query embed so there is no ungated embed path AND concurrent
  // near-cap searches cannot all pass and overshoot. Over cap → BudgetExceededError
  // propagates out of search() to the transport (402). Budget gate ONLY here — the
  // suspended-user read guard is separate, so suspended users can still
  // search within budget. The reservation is released in `finally`.
  let reservation: BudgetReservationHandle | undefined
  try {
    if (budget) reservation = await reserveBudgetSlot(budget, userId, SEARCH_EMBED_OPERATION)
    const result = await gateway.embed([query], SEARCH_EMBED_OPERATION)
    // Cost tracking: record ONE usage row for the query-embed call,
    // best-effort — a cost-row failure must never break search (counts/cost only,
    // never the query text — hard rule 6).
    const model = result.model || DEFAULT_EMBEDDING_MODEL
    const inputTokens = result.usage.inputTokens
    await insertLlmUsage(userId, {
      operation: SEARCH_EMBED_OPERATION,
      model,
      inputTokens,
      outputTokens: 0,
      costUsd: embeddingCostUsd(model, inputTokens),
    }).catch(() => {})
    const vector = result.embeddings[0]
    if (vector === undefined) {
      throw new InvalidEmbeddingError(0)
    }
    return vector
  } finally {
    if (reservation) await releaseBudgetReservation(userId, reservation)
  }
}

// Re-export the boundary embedding error so transports catch ONE error family
// from the core search surface.
export { InvalidEmbeddingError }
