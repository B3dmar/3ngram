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
  type SearchHit as DbSearchHit,
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
import { excerptContent } from './excerpt.js'
import type { RetrievalPolicy } from './retrieval-policy.js'
import {
  type DashboardPageOptions,
  resolveDashboardPageOptions,
  resolveSearchOptions,
  type SearchOptions,
} from './search-options.js'

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

/**
 * A core search hit: the db fused hit with its `content` bounded to the
 * read-result EXCERPT (packages/schema MAX_EXCERPT_LENGTH; stored
 * content can exceed any write-time cap via the import path). `contentLength`
 * carries the FULL stored length and `truncated` flags a cut excerpt (the text
 * then ends with EXCERPT_MARKER), so a caller can fetch the full memory by id.
 * Excerpting here is read-path POLICY (docs/concepts/architecture.mdx): REST and MCP both inherit the
 * bounded shape from this one surface.
 */
export interface SearchHit extends DbSearchHit {
  /** FULL stored content length (chars) — `content` itself is the excerpt. */
  contentLength: number
  /** True when `content` was cut to the excerpt cap. */
  truncated: boolean
}

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
  // Read-path excerpting: bound each hit's content to the schema
  // excerpt cap BEFORE any transport sees it (docs/concepts/architecture.mdx — policy in core, so
  // REST/MCP cannot drift). Stored rows are untouched (docs/concepts/memory-model.mdx, read-side only).
  const shaped = hits.map((hit) => ({ ...hit, ...excerptContent(hit.content) }))
  // The envelope rides EXACTLY when a policy was injected (the overload
  // contract): the policy-aware transport always gets the appliedScope echo;
  // every policy-less caller keeps the shipped plain array, byte-identical.
  if (opts.retrievalPolicy !== undefined) {
    return { hits: shaped, appliedScope }
  }
  return shaped
}

/**
 * The policy-aware search result (issue #47): the hits plus the
 * `appliedScope` echo — the scope the injected retrieval policy applied to an
 * unscoped call (`null` when nothing was narrowed: mode `off`, or the caller
 * scoped the call explicitly). Returned by {@link search} EXACTLY when
 * `opts.retrievalPolicy` is present, so a `default`-mode narrowing can never
 * be silent (the transport surfaces the echo verbatim).
 */
export interface ScopedSearchResult {
  hits: SearchHit[]
  appliedScope: string | null
}

/** The page-1 ranked ordering frozen into the dashboard cursor. */
export interface FrozenOrdering {
  ids: string[]
  scores: number[]
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

/**
 * Stable dashboard search pagination. The FIRST page (no `frozen`)
 * ranks the bounded candidate pool ONCE and returns the full ranked ordering;
 * the caller freezes `frozen` into the cursor and serves the first `limit` hits.
 * A CONTINUATION page (`frozen` set) pages BY POSITION within that frozen
 * ordering — fetching the slice's rows by id and applying the FROZEN scores and
 * order — so mid-session corpus drift cannot move a row across a page boundary
 * (no duplicates, no skips). Embedding is acquired only on the first page; a
 * continuation does no ranking.
 */
export async function searchDashboardPage(
  userId: string,
  query: string,
  source: EmbeddingSource,
  opts: DashboardPageOptions = {},
): Promise<DashboardSearchPage> {
  // ACCESS GUARD: deny reads when the platform policy forbids them, on both the
  // first page AND continuation pages (self-host allowAllAccess allows all).
  if (opts.access) await opts.access.assertRead(userId)

  // RETRIEVAL-SCOPE POLICY (issue #47): enforced on EVERY page — the effective
  // filters (and so the frozen ordering AND each continuation's eligibility
  // re-check) always carry the policy scope, and a `require` rejection fires
  // before any embed or fetch.
  const { appliedScope, filters, limit, supersessionPenalty, weights } =
    resolveDashboardPageOptions(query, opts)

  if (opts.frozen !== undefined) {
    const { ids, scores, off } = opts.frozen
    // Advance through the frozen ordering collecting ELIGIBLE rows; rows archived
    // or removed between clicks drop out. OVERFETCH one extra eligible row beyond
    // `limit` so `hasMore` reflects whether an eligible row actually REMAINS — not
    // the raw offset. Without the probe, a page that fills `limit` while every
    // later frozen id has since become ineligible would still advertise a next
    // page that can only return an empty no-op before clearing `hasMore`
    // Skipping ineligible ids also keeps every page full.
    //
    // Fetch a full `limit`-sized batch each round (not just the 1 row still
    // needed): probing an archived tail then costs O(tail / limit) round trips,
    // not one withTenant() query per remaining id — a bulk corpus shrink could
    // otherwise degrade a single "Load more" into dozens of serial queries
    // The loop stops as soon as the probe row is found.
    const collected: Array<{ hit: SearchHit; posAfter: number }> = []
    let cursor = off
    while (collected.length <= limit && cursor < ids.length) {
      const sliceIds = ids.slice(cursor, cursor + limit)
      const rows = await withTenant(userId, (tx) => fetchHitsByIds(tx, userId, sliceIds, filters))
      const byId = new Map(rows.map((row) => [row.id, row]))
      sliceIds.forEach((id, i) => {
        const row = byId.get(id)
        if (row === undefined) return // ineligible between requests — skip its frozen position
        const pos = cursor + i
        const score = scores[pos] ?? row.score
        collected.push({
          hit: { ...row, score, ...excerptContent(row.content) },
          posAfter: pos + 1,
        })
      })
      cursor += sliceIds.length
    }
    // The (limit+1)th eligible row is the probe: its presence ⇒ a real next page.
    const hasMore = collected.length > limit
    const page = collected.slice(0, limit)
    const hits = page.map((entry) => entry.hit)
    // Resume strictly after the last SHOWN eligible row when more remain; the
    // skipped-ineligible tail before the probe is re-scanned harmlessly. When no
    // eligible row remains, the ordering is exhausted.
    const nextOffset = hasMore ? (page[page.length - 1]?.posAfter ?? cursor) : ids.length
    return {
      hits,
      frozen: { ids, scores },
      nextOffset,
      hasMore,
      appliedScope,
    }
  }

  const { gateway, queryEmbedding: precomputed } = source
  const queryEmbedding =
    precomputed ?? (await embedQuery(userId, gateway as Gateway, query, opts.budget))
  if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new InvalidEmbeddingError(queryEmbedding.length)
  }
  // returnFullPool: rank and return the WHOLE bounded candidate pool, not just
  // the page — the tail is what we freeze. Page-1 ranking/normalization is
  // identical to a normal call (pool unchanged), so the eval floor is untouched.
  const ranked = await withTenant(userId, (tx) =>
    searchFused(
      tx,
      userId,
      query,
      limit,
      weights,
      supersessionPenalty,
      queryEmbedding,
      filters,
      undefined,
      {
        returnFullPool: true,
      },
    ),
  )
  const pageHits = ranked.slice(0, limit).map((hit) => ({ ...hit, ...excerptContent(hit.content) }))
  return {
    hits: pageHits,
    frozen: { ids: ranked.map((h) => h.id), scores: ranked.map((h) => h.score) },
    nextOffset: limit,
    hasMore: ranked.length > limit,
    appliedScope,
  }
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
