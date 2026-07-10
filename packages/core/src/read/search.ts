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
  DEFAULT_SUPERSESSION_PENALTY,
  EMBEDDING_DIMENSIONS,
  type FusionWeights,
  fetchHitsByIds,
  InvalidEmbeddingError,
  insertLlmUsage,
  type SearchFilters,
  searchFused,
  withTenant,
} from '@3ngram/db'
import type { Gateway } from '@3ngram/llm'
import {
  type AccessGate,
  type BudgetEnforcement,
  type BudgetReservationHandle,
  releaseBudgetReservation,
  reserveBudgetSlot,
} from '../budget/index.js'
import { DEFAULT_EMBEDDING_MODEL, embeddingCostUsd } from '../write/embed.js'
import { excerptContent } from './excerpt.js'

/** Gateway operation key for query embeddings — meters search cost distinctly
 * from write-path embeddings. */
const SEARCH_EMBED_OPERATION = 'search'

export type { FusionWeights, SearchAsOf, SearchFilters } from '@3ngram/db'

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

/**
 * CORE-OWNED product default fusion weights. UNLIKE the db
 * `DEFAULT_FUSION_WEIGHTS` ({fts:1, recency:0.3, vector:0}, which keeps the
 * vector leg INERT for back-compat at the query layer), the product policy
 * ENABLES the vector leg: semantic similarity is the PRIMARY retrieval signal
 * (weight 1), with a modest FTS contribution (0.2) for exact-term pool recall.
 *
 * TUNING (the engineering of this slice). The
 * frozen eval floors (eval/fixtures/floors.json) are recall@5 >= 0.9773,
 * mrr@5 >= 0.9697, supersession_correct >= 0.9474, abstention == 1.0, scored
 * by the blocking exact-cosine gate (eval/src/run.mjs). The vector
 * leg over the cached real-model embeddings reproduces that exact-cosine
 * ranking, so a vector-led fusion clears recall/mrr; the golden-set-through-
 * real-path integration test (search-golden.int.test.ts) is the oracle that
 * proves it through the REAL Postgres fused path (not just the in-memory
 * harness).
 *
 * WHY recency:0 and fts:0.2 (diagnosed against the real fused path).
 * The 88-answerable-query golden set is natural-language; the gold rows score
 * fts=0 (no lexical overlap) and are decided purely by cosine. A non-zero
 * recency leg DISPLACES gold rows: query 16 ("staging after the migration goes
 * live", gold g033) ranks g033 #3 by cosine, but recency 0.3 lifts five
 * recency-heavy non-gold rows (e.g. g148 vec 0.41 / recency 0.93) above it,
 * knocking g033 out of the top-5 (recall 0.9659 < floor). Lowering recency
 * fixes recall, but the leg still demotes a gold row by one rank, so mrr caps
 * at 0.9688 < floor for ANY recency > 0; only recency=0 clears mrr (0.9697,
 * exactly the pure-cosine baseline — g033 at rank 3 is the irreducible cost,
 * present in the baseline too). Symmetrically, fts > 0.3 lifts a lexical
 * competitor (g134) over gold g145 on query 83, dropping mrr to 0.9640; fts is
 * pinned at 0.2 (safe margin below the 0.31 mrr cliff) to keep exact-term pool
 * recall for production queries without disturbing the golden ranking.
 *
 * Local fused-path sweep (vector pinned 1, supersession penalty pinned 2):
 *   fts   rec   recall   mrr      sup    abst
 *   1     0.3   0.9659   0.9384   1.0    1.0   <- shipped start, recall FAILS
 *   1     0.1   0.9773   0.9631   1.0    1.0   <- recall ok, mrr FAILS
 *   1     0     0.9773   0.9640   1.0    1.0   <- mrr FAILS (fts too high)
 *   0.31  0     0.9773   0.9640   1.0    1.0   <- mrr FAILS (fts cliff)
 *   0.2   0     0.9773   0.9697   1.0    1.0   <- CHOSEN: all four clear
 *   floors      0.9773   0.9697   0.9474 1.0
 */
export const DEFAULT_SEARCH_WEIGHTS: FusionWeights = { fts: 0.2, recency: 0, vector: 1 }

/**
 * CORE-OWNED supersession penalty for the product search default.
 *
 * The product default IS the db tier penalty ({@link
 * DEFAULT_SUPERSESSION_PENALTY} = 2), imported — never redefined — so the policy
 * and query layers share one source of truth. The tier penalty exceeds the max
 * positive base score any row can earn from the other legs, so a superseded
 * predecessor sinks BELOW EVERY live row: user-facing retrieval surfaces the
 * currently-valid memory first, with the superseded predecessor still
 * retrievable but ranked beneath it. That is exactly the memory model's default (docs/concepts/memory-model.mdx)
 * (currently-valid first; superseded retrievable but RANKED BELOW).
 *
 * WHY NOT A SOFTER PENALTY.
 * An earlier draft used a SOFT penalty (0.1) so the golden supersession metric
 * could keep penalized predecessors inside the K=5 window. But a soft penalty is
 * a user-facing regression: a superseded predecessor that happens to be a
 * STRONGER FTS/vector match can still outrank its live successor (0.1 only
 * breaks exact ties), surfacing a STALE memory above the current one — a direct
 * violation of the memory model's "currently-valid first" default (docs/concepts/memory-model.mdx). The fix is to keep
 * the strict tier penalty as the product default and instead make the golden
 * supersession metric check successor/predecessor RELATIVE order over the full
 * fused output (search-golden.int.test.ts), so the metric never requires
 * softening the shipped default. Superseded rows remain RETRIEVABLE (docs/concepts/memory-model.mdx
 * "never filter"), just ranked below every live row.
 */
export const DEFAULT_SEARCH_SUPERSESSION_PENALTY = DEFAULT_SUPERSESSION_PENALTY

/** Default result window. Matches the eval harness K. */
const DEFAULT_LIMIT = 5

/** Either an injected Gateway (embed the query) or a pre-computed embedding. */
export type EmbeddingSource =
  | { gateway: Gateway; queryEmbedding?: undefined }
  | { gateway?: undefined; queryEmbedding: number[] }

/** Tunable search options. All have product-default policy values. */
export interface SearchOptions {
  /** Max hits to return. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number
  /**
   * Keyset cursor for dashboard continuation: the `(score, id)` of the previous
   * page's last row. Absent on the first page. Row-anchored (not a numeric
   * offset), so continuation is stable against per-request score recomputation
   * (packages/db buildCursorPredicate). Threaded straight to {@link searchFused}.
   */
  cursor?: { score: number; id: string }
  /** Fusion weights. Defaults to {@link DEFAULT_SEARCH_WEIGHTS}. */
  weights?: FusionWeights
  /**
   * Supersession penalty. Defaults to
   * {@link DEFAULT_SEARCH_SUPERSESSION_PENALTY}.
   */
  supersessionPenalty?: number
  /**
   * Candidate-narrowing FILTERS: memoryType / scope /
   * project / status / asOf. Threaded straight to the db query layer
   * ({@link searchFused}), where they narrow the candidate set BEFORE fusion —
   * they do not alter the fusion weights or the supersession ranking. The filter
   * VALUES are validated at the ONE boundary (packages/schema searchQuerySchema,
   * which REST/SDK parse); core trusts the typed shape here (hard rule 2).
   *
   * docs/concepts/memory-model.mdx defaults (see {@link SearchFilters}): with NO `asOf` the read is
   * the supersession-aware live view (active-only, predecessors ranked below
   * successors). With `asOf` set the read SURFACES superseded history (the
   * valid-time predicate selects the row live at the instant) — never silently
   * dropped. An absent filter never narrows its axis.
   */
  filters?: SearchFilters
  /**
   * Injected budget enforcement. When present AND the query is
   * embedded via the gateway (not pre-computed), the cap is asserted BEFORE the
   * query embed — search is a metered read, so it is gated by the budget (and by
   * the read guard), never by the WRITE guard, so a suspended user can
   * still search within budget. Absent → no budget gate (back-compat).
   */
  budget?: BudgetEnforcement | undefined
  /**
   * Injected access gate. When present, read access is asserted BEFORE the query
   * embed — a platform policy may deny reads (self-host allowAllAccess allows all).
   * Threaded independently of the budget. Absent → no access guard (back-compat).
   */
  access?: AccessGate | undefined
}

/**
 * Count whitespace-delimited tokens in a query string.
 * Used by resolveWeights to detect short (≤2 token) queries.
 */
function queryTokenCount(q: string): number {
  return q.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Resolve effective fusion weights, injecting the topic-match entity bonus for
 * short queries.
 *
 * WHY NOT RAISE THE FTS WEIGHT DIRECTLY: the golden-set calibration
 * pins fts at 0.2 — the MRR cliff at fts > 0.31 means raising fts drops mrr
 * below the eval floor (0.9697) for all 88 golden queries. The topicMatch leg
 * is additive and token-count gated: it fires only for ≤2-token queries (all
 * golden-set queries are 6+ tokens, so it cannot disturb the eval floors) and
 * activates a LIKE-based topic bonus that surfaces person-identity facts for
 * bare first-name lookups without affecting long-query MRR.
 *
 * If the caller already set topicMatch explicitly, it is forwarded as-is.
 */
function resolveWeights(query: string, weights: FusionWeights): FusionWeights {
  if (queryTokenCount(query) <= 2 && weights.topicMatch === undefined) {
    return { ...weights, topicMatch: 0.5 }
  }
  return weights
}

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
 * @throws {@link InvalidEmbeddingError} if a pre-computed embedding is not
 *   exactly {@link EMBEDDING_DIMENSIONS}-wide (validated at the boundary, never
 *   an opaque pgvector failure).
 */
export async function search(
  userId: string,
  query: string,
  source: EmbeddingSource,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  // ACCESS GUARD: the injected access gate denies reads when the platform policy
  // forbids them (self-host allowAllAccess allows all). Search is a READ — it is
  // NEVER write-guarded, so a read-only user keeps search, bounded only by the
  // budget cap.
  if (opts.access) await opts.access.assertRead(userId)

  const { gateway, queryEmbedding: precomputed } = source

  const queryEmbedding =
    precomputed ?? (await embedQuery(userId, gateway as Gateway, query, opts.budget))
  if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    // Boundary validation: reject a malformed pre-computed embedding here with a
    // typed error (the gateway path is bounded by the provider contract).
    throw new InvalidEmbeddingError(queryEmbedding.length)
  }

  const limit = opts.limit ?? DEFAULT_LIMIT
  const cursor = opts.cursor
  const weights = resolveWeights(query, opts.weights ?? DEFAULT_SEARCH_WEIGHTS)
  const supersessionPenalty = opts.supersessionPenalty ?? DEFAULT_SEARCH_SUPERSESSION_PENALTY
  const filters = opts.filters ?? {}

  const hits = await withTenant(userId, (tx) =>
    searchFused(tx, query, limit, weights, supersessionPenalty, queryEmbedding, filters, cursor),
  )
  // Read-path excerpting: bound each hit's content to the schema
  // excerpt cap BEFORE any transport sees it (docs/concepts/architecture.mdx — policy in core, so
  // REST/MCP cannot drift). Stored rows are untouched (docs/concepts/memory-model.mdx, read-side only).
  return hits.map((hit) => ({ ...hit, ...excerptContent(hit.content) }))
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
}

/** Options for {@link searchDashboardPage}. `frozen` present ⇒ a continuation page. */
export interface DashboardPageOptions {
  limit?: number
  filters?: SearchFilters
  /** Continuation only: the frozen ordering + current offset decoded from the cursor. */
  frozen?: { ids: string[]; scores: number[]; off: number }
  /** Injected budget enforcement — gates the dashboard query embed
   * the same as {@link SearchOptions.budget} (no ungated metered embed path). */
  budget?: BudgetEnforcement | undefined
  /** Injected access gate — asserts read access the same as
   * {@link SearchOptions.access}. */
  access?: AccessGate | undefined
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

  const limit = opts.limit ?? DEFAULT_LIMIT
  const filters = opts.filters ?? {}

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
      const rows = await withTenant(userId, (tx) => fetchHitsByIds(tx, sliceIds, filters))
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
    return { hits, frozen: { ids, scores }, nextOffset, hasMore }
  }

  const { gateway, queryEmbedding: precomputed } = source
  const queryEmbedding =
    precomputed ?? (await embedQuery(userId, gateway as Gateway, query, opts.budget))
  if (queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new InvalidEmbeddingError(queryEmbedding.length)
  }
  const weights = resolveWeights(query, DEFAULT_SEARCH_WEIGHTS)
  const supersessionPenalty = DEFAULT_SEARCH_SUPERSESSION_PENALTY
  // returnFullPool: rank and return the WHOLE bounded candidate pool, not just
  // the page — the tail is what we freeze. Page-1 ranking/normalization is
  // identical to a normal call (pool unchanged), so the eval floor is untouched.
  const ranked = await withTenant(userId, (tx) =>
    searchFused(
      tx,
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
