// SPDX-License-Identifier: Apache-2.0
// Unified-search query layer (Phase 1B, slice 1b: FTS + recency + vector +
// fusion).
//
// This module owns the SQL for retrieval LEGS only. Business policy (default
// weights, query parsing, embedding acquisition, response shaping) belongs to
// packages/core (1B slice 2) per the layering rule — keep this at the query
// layer. TENANT ISOLATION IS TWO-LAYER (defense in depth): every query runs
// inside withTenant(), where RLS scopes rows to the caller, AND every query
// carries an explicit caller-bound `user_id = $userId` predicate bound to the
// SAME userId the caller passed into withTenant(). When RLS is functioning the
// predicate is a no-op (it matches exactly the rows RLS admits); it exists so
// tenant isolation never rests on a single mechanism. Query TEXT is never
// logged here (it is a REDACTED field); callers log lengths/hashes.
//
// Fusion strategy: WEIGHTED SUM, not RRF. Each leg already yields a bounded,
// comparable score in [0, 1] (ts_rank is normalized below; recency decay is a
// half-life exponential in [0, 1]; the vector leg contributes
// GREATEST(0, 1 - cosine distance), clamped into [0, 1] since pgvector's <=>
// distance is in [0, 2] and 1 - distance can go negative for dissimilar pairs).
// Weighted sum keeps score MAGNITUDE, which the supersession penalty and
// tunable per-leg weights both depend on; RRF collapses every leg to a rank
// ordinal and would discard exactly that signal. Weights are parameters, not
// constants, so packages/core owns policy.
import type { CommitmentStatus } from '@3ngram/schema'
import { type SQL, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'

/** Fixed embedding width: the memories.embedding column is `vector(1536)`. */
export const EMBEDDING_DIMENSIONS = 1536

/**
 * Thrown when an ACTIVE vector leg is fed an embedding that pgvector would
 * reject at BIND time (empty, or not exactly {@link EMBEDDING_DIMENSIONS}-wide).
 * Raised in the app BEFORE the query runs so callers get a typed, actionable
 * error instead of an opaque Postgres `vector_in` failure ("vector must have at
 * least 1 dimension" / "different vector dimensions").
 */
export class InvalidEmbeddingError extends Error {
  constructor(actual: number) {
    super(`embedding must have exactly ${EMBEDDING_DIMENSIONS} dimensions, got ${actual}`)
    this.name = 'InvalidEmbeddingError'
  }
}

/**
 * Serialize an embedding to the pgvector text literal (`[a,b,c]`). Drizzle has
 * no first-class vector bind type, so the value is parameterized as text and
 * cast to ::vector in SQL. The array is gateway-emitted floats only (never user
 * text), so this is not an injection surface.
 *
 * IMPORTANT (two failure modes that forced conditional SQL composition — see
 * searchFused). A `${literal}::vector` placeholder is converted by Postgres via
 * `vector_in` at BIND time, BEFORE any CASE/WHERE gate runs:
 *   1. Binding the empty literal `'[]'` raises "vector must have at least 1
 *      dimension" — a constant-false guard does NOT help, the cast already ran.
 *   2. Binding SQL NULL and casting `${null}::vector` (or leaving the param
 *      uncast in a `IS NOT NULL` test) raises 42P18 "could not determine data
 *      type of parameter $n" at PARSE time, because the rewriter cannot infer a
 *      type for a bare NULL parameter through the cast.
 * The ONLY robust fix is to never emit a vector parameter at all on the inert
 * path: searchFused composes the SQL conditionally so the embedding param and
 * its `::vector` cast appear only when the leg is active. This serializer is
 * therefore called solely on the active path, where the embedding is a real,
 * validated 1536-dim array.
 */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/** Throw {@link InvalidEmbeddingError} unless `embedding` is exactly 1536-dim. */
function assertEmbeddingDimensions(embedding: number[]): void {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new InvalidEmbeddingError(embedding.length)
  }
}

/** One scored row from any search leg. Score is normalized to [0, 1]. */
export interface SearchHit {
  id: string
  memoryType: string
  topic: string
  content: string
  score: number
  /**
   * The row's VECTOR-SIMILARITY leg component on a COSINE scale
   * (`GREATEST(0, 1 - cosine_distance)` in [0, 1]), exposed ADDITIVELY and
   * weight-gated: it is a real number only on the active vector path
   * (`weights.vector > 0` AND a queryEmbedding supplied) and `undefined`
   * otherwise. It is the UNWEIGHTED per-leg cosine, NOT the fused `score`
   * (which mixes legs and is not on a cosine scale).
   *
   * WHY this exists: the golden-set abstention threshold (eval floors `tau`)
   * is calibrated on the COSINE scale. The fused `score` is a weighted sum of
   * heterogeneous legs and is not cosine-comparable, so abstention cannot be
   * decided on it. Callers that need a cosine-scale abstention signal read
   * `topHit.vectorScore` and compare against the frozen `tau` (core search
   * policy). Additive + weight-gated keeps the inert FTS+recency path
   * byte-for-byte unchanged — see the conditional SQL
   * composition note on {@link searchFused}.
   */
  vectorScore?: number
  /** Commitment FSM status when this memory carries a commitment row. */
  commitmentStatus?: CommitmentStatus
  /**
   * True when this row is a superseded predecessor — its validity is CLOSED
   * (`valid_to IS NOT NULL`) AND it has an INCOMING `supersedes` or `updates`
   * edge (a CLOSES_PREDECESSOR edge type, matching `proposals-apply.ts`'s
   * `CLOSES_PREDECESSOR` set). BOTH are required: an imported `updates` edge
   * cannot close its target (the import contract forbids it), and such a
   * still-live row is NOT superseded — see {@link supersededExists}. Ranking is
   * supersession-AWARE, never supersession-FILTERED (docs/concepts/memory-model.mdx):
   * this flag lets a caller distinguish/label a demoted row rather than
   * silently receiving it unmarked. Always present and always COMPUTED (never
   * a stubbed default): every leg (searchFts, searchRecency, searchVector,
   * searchFused, fetchHitsByIds) selects it via the shared
   * {@link supersededExists} predicate, so a superseded row is correctly
   * labeled on every retrieval path, not only the fused one.
   */
  superseded: boolean
}

/** Tunable fusion weights. Vector defaults to 0 until the vector leg lands. */
export interface FusionWeights {
  fts: number
  recency: number
  vector: number
  topicMatch?: number // inert at 0; +score when topic contains query string
}

/**
 * Bi-temporal point-in-time coordinates for a search time-travel read (issue #134). MIRRORS the facts read axes (facts-read.ts AsOf) re-expressed
 * against the `memories` bi-temporal columns:
 *   - `validAt`    VALID-TIME instant — the memory that was TRUE at this moment
 *     (valid_from <= validAt AND (valid_to IS NULL OR valid_to > validAt)).
 *   - `asKnownAt`  TRANSACTION-TIME instant — only memories RECORDED by this
 *     moment (recorded_at <= asKnownAt). LIMITATION (single transaction-time
 *     clock, same as facts-read.ts): recorded_at captures the INSERT instant
 *     only — a valid_to set later at supersession is invisible to asKnownAt
 *     alone, so pair asKnownAt WITH validAt for faithful as-known-at reads.
 */
export interface SearchAsOf {
  validAt?: Date
  asKnownAt?: Date
}

/**
 * Candidate-narrowing filters for {@link searchFused}.
 * Applied as additional WHERE conditions BEFORE fusion, so they narrow the pool
 * the weight-gated legs draw from without disturbing the fusion math or the
 * supersession ranking. Every field is optional — an absent filter does not
 * narrow that axis:
 *   - `memoryType`  → memories.memory_type
 *   - `memoryTypes` → memories.memory_type OR-set (V2, `= ANY`)
 *   - `scope`       → memories.scope
 *   - `project`     → memories.project
 *   - `status`      → memories.status (OVERRIDES the active-only default)
 *   - `asOf`        → bi-temporal time-travel (see {@link SearchAsOf})
 *   - `recordedAfter` / `recordedBefore` → inclusive recorded_at range (V2;
 *     narrows the live view, never lifts the active default — not time travel)
 *
 * docs/concepts/memory-model.mdx STATUS/TIME-TRAVEL semantics. WITHOUT a time-travel coordinate the
 * read is the supersession-AWARE live view: rows are restricted to
 * status='active' (or the explicit `status` filter) and superseded predecessors
 * are RANKED below their successors by the penalty (never dropped). WITH an
 * `asOf` coordinate (validAt and/or asKnownAt) the read SURFACES HISTORY: the
 * active-only default is lifted so the valid-time predicate can select the row
 * that was live at the target instant — which may be a now-superseded
 * predecessor. This is "surface superseded history when asked, never silently
 * drop" (docs/concepts/memory-model.mdx). An explicit `status` filter still
 * applies under `asOf` (e.g. as-of archived rows).
 *
 * An EMPTY `asOf:{}` (both coordinates absent) is NOT time-travel: it does NOT
 * lift the active default and adds no temporal predicate, so it stays the live
 * view rather than silently returning archived/superseded rows (Codex P2,
 * comment 3372942604). The schema (asOfSchema) also rejects `{}` outright.
 */
export interface SearchFilters {
  memoryType?: string
  /**
   * V2 (issue #48): OR-set over memory_type (`memory_type = ANY($types)`).
   * Mutually exclusive with `memoryType` at the schema boundary
   * (searchQueryV2Schema); the db layer ANDs whatever it is handed, so passing
   * both would intersect — the boundary rejects that shape before it gets here.
   */
  memoryTypes?: string[]
  scope?: string
  project?: string
  status?: string
  asOf?: SearchAsOf
  /**
   * V2 (issue #48): INCLUSIVE transaction-time range on recorded_at
   * (`recorded_at >= recordedAfter` / `<= recordedBefore`). UNLIKE `asOf`, the
   * range does NOT lift the active-only default — it narrows the LIVE view
   * ("recorded last week"), it is not time travel. Only an `asOf` coordinate
   * lifts the default (see rowEligibility).
   */
  recordedAfter?: Date
  recordedBefore?: Date
}

export const DEFAULT_FUSION_WEIGHTS: FusionWeights = { fts: 1, recency: 0.3, vector: 0 }

/**
 * Penalty subtracted from a row's fused score when it has an INCOMING
 * supersedes/updates edge (it is the `to_id` of a CLOSES_PREDECESSOR edge —
 * i.e. a superseded predecessor, either revise kind). This RANKS predecessors
 * below their successors; it does NOT filter them (docs/concepts/memory-model.mdx:
 * superseded rows stay retrievable).
 *
 * The default exceeds the maximum positive base score a row can earn from the
 * other legs (fts + recency are each <= 1, default weights sum to 1.3), so a
 * superseded row is guaranteed to sink below any live row — a TIER demotion,
 * not a soft nudge that a stronger lexical match on the predecessor could
 * overcome. It is still tunable: callers wanting a softer blend lower it.
 */
export const DEFAULT_SUPERSESSION_PENALTY = 2

/** Recency half-life in days for the exponential decay leg. */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 90

/**
 * Minimum per-leg candidate-pool depth in {@link searchFused}, independent of
 * `limit`. Each leg (FTS, recency, vector) over-fetches `max(limit * 4, FLOOR)`
 * rows so fusion ranks a candidate set deeper than any single leg's top-N. At
 * small limits `limit * 4` is too shallow: at the MCP default limit 5 it is only
 * 20, which starved four golden-set queries (qi 19/40/45/73) — a
 * gold row that ranks #1–#5 at limit 50 fell out of the candidate set entirely
 * at limit 5, a candidate-DEPTH miss, not a ranking error. This floor guarantees
 * a minimum recall window so low-limit ranking matches deep-limit ranking. At
 * limit 50 `limit * 4` (200) still dominates, so deep-limit behavior is
 * unchanged. The pool is shared across legs but consumed only where a leg is
 * active (the vector path is inert when `vectorActive` is false), so the floor
 * carries no behavioral cost on an inactive leg.
 */
export const CANDIDATE_POOL_FLOOR = 50

/**
 * FTS leg: ts_rank over the generated `search_tsv` (migration 0006), matched
 * with websearch_to_tsquery (handles quotes/OR/-, never throws on user input).
 * Score is min-max normalized to [0, 1] over the result window so it composes
 * with the other legs. Only rows matching the query are returned.
 */
export async function searchFts(
  tx: TenantTx,
  userId: string,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const rows = await tx.execute(sql`
    WITH q AS (SELECT websearch_to_tsquery('english', ${query}) AS tsq),
    ranked AS (
      SELECT m.id, m.memory_type, m.topic, m.content,
             ${supersededExists('m')} AS superseded,
             ts_rank(m.search_tsv, q.tsq) AS rank
      FROM memories m, q
      WHERE m.user_id = ${userId}::uuid AND m.status = 'active' AND m.search_tsv @@ q.tsq
      ORDER BY rank DESC
      LIMIT ${limit}
    )
    SELECT id, memory_type, topic, content, superseded,
           CASE WHEN max(rank) OVER () = min(rank) OVER () THEN 1.0
                ELSE (rank - min(rank) OVER ()) / (max(rank) OVER () - min(rank) OVER ())
           END AS score
    FROM ranked
    ORDER BY score DESC
  `)
  return mapHits(rows)
}

/**
 * Recency leg: exponential decay on `recorded_at` (transaction time), score =
 * 0.5 ^ (age_days / half_life). Returns the most recent `limit` active rows.
 * Standalone it is rarely useful; it exists as a fusion input.
 */
export async function searchRecency(
  tx: TenantTx,
  userId: string,
  limit: number,
): Promise<SearchHit[]> {
  const rows = await tx.execute(sql`
    SELECT id, memory_type, topic, content,
           ${supersededExists('m')} AS superseded,
           power(0.5, EXTRACT(EPOCH FROM (now() - recorded_at)) / 86400.0
                      / ${DEFAULT_RECENCY_HALF_LIFE_DAYS}) AS score
    FROM memories m
    WHERE user_id = ${userId}::uuid AND status = 'active'
    ORDER BY recorded_at DESC
    LIMIT ${limit}
  `)
  return mapHits(rows)
}

/**
 * Vector leg: pgvector cosine similarity over the HNSW index (migration
 * 0000_init: memories_embedding_idx USING hnsw vector_cosine_ops). Score is
 * GREATEST(0, 1 - (embedding <=> query)) — the cosine distance operator
 * inverted and clamped into a [0, 1] similarity that composes with the other
 * legs (<=> is in [0, 2], so 1 - distance can go negative). Rows with a NULL
 * embedding are skipped (no vector to compare). Returns the nearest `limit`
 * active rows. Standalone it is a fusion input; the leg is gated on a non-zero
 * vector weight in searchFused.
 *
 * Filtered HNSW scans (RLS + status='active' narrow the candidate set under
 * the index) can under-fill the result before reaching `limit`; SET LOCAL
 * hnsw.iterative_scan = relaxed_order lets pgvector keep scanning index pages
 * until it has enough post-filter matches. It is a session GUC scoped to this
 * transaction by SET LOCAL — never migration material (hnsw-parity.int.test.ts
 * regime B documents the same knob).
 */
export async function searchVector(
  tx: TenantTx,
  userId: string,
  queryEmbedding: number[],
  limit: number,
): Promise<SearchHit[]> {
  // searchVector always runs the leg, so the embedding must be bindable: reject
  // an empty/wrong-width vector up front rather than let vector_in fail at BIND.
  assertEmbeddingDimensions(queryEmbedding)
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
  const vec = toVectorLiteral(queryEmbedding)
  const rows = await tx.execute(sql`
    SELECT id, memory_type, topic, content,
           ${supersededExists('m')} AS superseded,
           GREATEST(0, 1 - (embedding <=> ${vec}::vector)) AS score
    FROM memories m
    WHERE user_id = ${userId}::uuid AND status = 'active' AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit}
  `)
  return mapHits(rows)
}

/**
 * One ordered, near-duplicate candidate pair for the background consolidator
 * (workstream F1). The pair is ORIENTED successor -> predecessor by
 * recency: `fromId` is the more recently CREATED memory (the successor), `toId`
 * the older (the predecessor) — the load-bearing direction a CLOSES_PREDECESSOR
 * edge (supersedes/updates) needs, since apply closes `to_id`. `similarity` is
 * the pgvector COSINE similarity in [0, 1]. Types ride along so core can apply the
 * per-type CONSOLIDATION_POLICIES gate without a second read.
 */
export interface SimilarPair {
  fromId: string
  toId: string
  fromType: string
  toType: string
  similarity: number
}

/**
 * kNN candidate overfetch for {@link findSimilarPairs}. The per-row LATERAL pulls
 * `limit * KNN_OVERFETCH` approximate nearest neighbors so the global re-rank has
 * a wide enough pool to recover pairs HNSW recall loss would otherwise drop before
 * the bounded `ORDER BY distance LIMIT`. Mirrors the {@link CANDIDATE_POOL_FLOOR}
 * `limit * 4` overfetch the hybrid vector leg already uses.
 */
export const KNN_OVERFETCH = 4

/**
 * `hnsw.ef_search` for the {@link findSimilarPairs} candidate scan. Widening the
 * HNSW dynamic candidate list raises recall of the per-row `ORDER BY <=> LIMIT k`
 * so the approximate scan rarely omits a genuinely-closer neighbor. SET LOCAL, so
 * it is scoped to the consolidation transaction and never leaks to other queries.
 */
export const KNN_EF_SEARCH = 200

/**
 * Find near-duplicate memory pairs for the tenant by pgvector cosine similarity
 * (workstream F1). REUSES the same `<=>` cosine operator + HNSW index as
 * {@link searchVector} — no cosine math is reimplemented in the app; the
 * pairwise comparison stays in SQL where the index lives, so no 1536-d vector
 * ever crosses into JS.
 *
 * PER-ROW kNN CANDIDATE GENERATION. Instead of an O(n^2) self-join
 * that forms EVERY unordered pair and only THEN applies the similarity predicate
 * (the HNSW index cannot prune a variable-to-variable `a.embedding <=> b.embedding`
 * comparison, so the planner falls back to a full pairwise scan), this drives the
 * scan from each row's INDEXED nearest neighbors: a LATERAL subquery runs
 * `ORDER BY embedding <=> a.embedding LIMIT k` per row, which the HNSW index DOES
 * serve, capping candidates per row BEFORE pairing. The `a.id < b.id` half-triangle
 * then emits each unordered pair ONCE, keeping only pairs whose cosine similarity
 * is >= `minSimilarity`. Most-similar first, BOUNDED by `limit` (no-firehose; the
 * consolidator always supplies a bound). Read-only: it NEVER touches memory rows
 * (advisory consolidation, docs/concepts/memory-model.mdx "Consolidation is advisory", hard rule 1).
 *
 * APPROXIMATE INDEX, OVERFETCH + RE-RANK (Codex P2, comment 3413743844). The HNSW
 * index is APPROXIMATE — at recall < 100% the per-row `ORDER BY <=> LIMIT k` scan
 * can omit a genuinely-closer neighbor even at DISTINCT cosine distances, and
 * because the per-row cap precedes the global `ORDER BY distance LIMIT`, any pair
 * it drops is unrecoverable. So a per-row cap of exactly `limit` would diverge from
 * the exact self-join this function replaces. To preserve output equivalence the
 * candidate step OVERFETCHES: `hnsw.ef_search = ${KNN_EF_SEARCH}` widens the HNSW
 * dynamic candidate list and the LATERAL pulls `limit * KNN_OVERFETCH` neighbors
 * per row, then the unchanged global `ORDER BY distance LIMIT ${limit}` re-ranks
 * that wider pool to the exact top-`limit`. Overfetching only the candidate stage
 * can never emit a pair the exact self-join would not — it only adds back pairs
 * HNSW approximation would otherwise have dropped.
 *
 * OUTPUT IS EQUIVALENT to the prior self-join for distinct cosine distances (the
 * real-world case over 1536-d float embeddings, where exact ties are vanishingly
 * rare), ASSUMING the overfetched candidate scan surfaces the true neighbors that
 * reach the global top-`limit`. The final result keeps only the `limit` most-
 * similar pairs, and any pair that survives to the global top-`limit` has each
 * endpoint among the other's `limit` nearest neighbors — were row `a` STRICTLY
 * closer to `limit` other rows than to `b`, `a` would already contribute `limit`
 * strictly-more-similar pairs and (a, b) could never reach the global top-`limit`.
 * The overfetched candidate pool (`limit * KNN_OVERFETCH`) is a strict superset of
 * those `limit` nearest neighbors, so no pair the old query would have emitted is
 * lost by the cap. The final `ORDER BY` is unchanged (ascending cosine distance,
 * no tie-break), preserving the same row order, the same `minSimilarity` gate, and
 * the same `limit` bound.
 *
 * TIE CAVEAT: when more than `limit` rows sit at EXACTLY equal cosine distance from
 * a row, the LATERAL's `LIMIT` (no tie-break) may evict the endpoint of a tied
 * pair from both neighbor lists, so a tied pair the old global `ORDER BY … LIMIT`
 * might have emitted can be dropped. This matches the OLD query's already-
 * nondeterministic tie behavior (its global `ORDER BY` had no tie-break either):
 * which tied pair surfaces was never stable. Real embeddings do not produce exact
 * distance ties, so this is a theoretical edge, not a consolidation regression.
 *
 * LIVE-ONLY CANDIDATES (Codex P2): both join sides require `valid_to IS NULL` on
 * TOP of `status = 'active'`. A superseded memory keeps `status = 'active'` and
 * only gets `valid_to` set (memory-revise.ts), so filtering on status alone would
 * let closed historical rows form candidate pairs — and the worker could then
 * propose an edge against an already-superseded predecessor. Pinning
 * `valid_to IS NULL` for BOTH aliases restricts candidates to currently-live rows.
 *
 * EDGE DIRECTION IS LOAD-BEARING (memory-edges.ts, search.ts supersession
 * penalty, memory-revise.ts): a CLOSES_PREDECESSOR edge (supersedes/updates)
 * runs successor(from_id) -> predecessor(to_id), and applying it closes the
 * predecessor = to_id. The successor is the NEWER memory, the predecessor the
 * OLDER. So the emitted pair is ORIENTED by recency — `from` = the more recently
 * CREATED memory, `to` = the older — NOT by arbitrary UUID order. The half-
 * triangle join (`a.id < b.id`) still emits each unordered pair once; the
 * orientation is applied to the OUTPUT columns via created_at (id as the
 * deterministic tie-break for equal timestamps). For additive edges
 * (extends/derives) direction is not load-bearing, but this single recency rule
 * gives every pair a deterministic, meaningful orientation.
 *
 * Runs inside withTenant() so RLS scopes both sides of the join to the caller,
 * AND both aliases carry an explicit caller-bound `user_id = $userId` predicate
 * (defense in depth, module header): a candidate pair — and therefore a
 * consolidation proposal — can only ever be formed from two rows the caller
 * owns, independent of the RLS layer.
 */
export async function findSimilarPairs(
  tx: TenantTx,
  userId: string,
  minSimilarity: number,
  limit: number,
): Promise<SimilarPair[]> {
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
  // OVERFETCH + RE-RANK (Codex P2, comment 3413743844). The HNSW index is
  // APPROXIMATE: with recall < 100% the per-row `ORDER BY <=> LIMIT k` scan can
  // omit a genuinely-closer neighbor even at distinct cosine distances, and that
  // per-row cap is applied BEFORE the global `ORDER BY distance LIMIT`, so any
  // pair it drops is unrecoverable. The docstring's exactness argument holds only
  // for a TRUE k-NN; against an approximate index it would silently diverge from
  // the exact self-join this function replaces. To restore recall we (1) widen the
  // HNSW candidate list with `hnsw.ef_search` and (2) overfetch the LATERAL to
  // `limit * KNN_OVERFETCH` neighbors per row, then let the unchanged global
  // `ORDER BY distance LIMIT ${limit}` re-rank that wider candidate pool down to
  // the exact top-`limit`. Overfetching only the candidate STEP cannot change the
  // final bounded output except to ADD back pairs HNSW approximation would have
  // dropped — it never emits a pair the exact self-join would not.
  // set_config(..., true) is the parameterized SET LOCAL the repo mandates (see
  // client.ts): a bare `SET` cannot bind a parameter and contaminates pooled
  // sessions under transaction-mode pooling. ef_search takes a text value.
  await tx.execute(sql`SELECT set_config('hnsw.ef_search', ${String(KNN_EF_SEARCH)}, true)`)
  const candidateK = limit * KNN_OVERFETCH
  // For each live, embedded row `a`, the LATERAL pulls its `candidateK` nearest
  // live, embedded neighbors via the HNSW-served `ORDER BY b.embedding <=>
  // a.embedding LIMIT candidateK` — the index prunes here, where the prior
  // self-join could not, and the overfetch absorbs HNSW recall loss. Each
  // unordered pair can surface from BOTH endpoints' neighbor lists; the outer
  // SELECT DISTINCT ON over the canonical (lo, hi) id ordering dedups it to one
  // row (same as the old `a.id < b.id` half-triangle, but applied AFTER the kNN
  // cap so no neighbor is cut by an id predicate). Orientation is then by recency:
  // `newer`/`older` pick the more vs less recently CREATED endpoint (created_at,
  // id tie-break) so from_id is the successor and to_id the predecessor — the
  // apply side closes to_id (the older row). DISTINCT ON requires the dedup keys
  // to lead ORDER BY; the inner CTE re-imposes the byte-compatible final order
  // (ascending cosine distance, no tie-break) and the `limit` bound.
  const rows = await tx.execute(sql`
    WITH pairs AS (
      SELECT DISTINCT ON (LEAST(a.id, b.id), GREATEST(a.id, b.id))
             CASE WHEN (a.created_at, a.id) >= (b.created_at, b.id) THEN a.id
                  ELSE b.id END AS from_id,
             CASE WHEN (a.created_at, a.id) >= (b.created_at, b.id) THEN b.id
                  ELSE a.id END AS to_id,
             CASE WHEN (a.created_at, a.id) >= (b.created_at, b.id) THEN a.memory_type
                  ELSE b.memory_type END AS from_type,
             CASE WHEN (a.created_at, a.id) >= (b.created_at, b.id) THEN b.memory_type
                  ELSE a.memory_type END AS to_type,
             GREATEST(0, 1 - (a.embedding <=> b.embedding)) AS similarity,
             (a.embedding <=> b.embedding) AS distance
      FROM memories a
      CROSS JOIN LATERAL (
        SELECT b.id, b.memory_type, b.created_at, b.embedding
        FROM memories b
        WHERE b.user_id = ${userId}::uuid
          AND b.status = 'active' AND b.valid_to IS NULL AND b.embedding IS NOT NULL
          AND b.id <> a.id
        ORDER BY b.embedding <=> a.embedding
        LIMIT ${candidateK}
      ) AS b
      WHERE a.user_id = ${userId}::uuid
        AND a.status = 'active' AND a.valid_to IS NULL AND a.embedding IS NOT NULL
        AND (1 - (a.embedding <=> b.embedding)) >= ${minSimilarity}
      ORDER BY LEAST(a.id, b.id), GREATEST(a.id, b.id), (a.embedding <=> b.embedding)
    )
    SELECT from_id, to_id, from_type, to_type, similarity
    FROM pairs
    ORDER BY distance
    LIMIT ${limit}
  `)
  return rows.rows.map((r) => ({
    fromId: r.from_id as string,
    toId: r.to_id as string,
    fromType: r.from_type as string,
    toType: r.to_type as string,
    similarity: Number(r.similarity),
  }))
}

/**
 * V2 OR-set predicate (issue #48): `memory_type = ANY(ARRAY[...])` over
 * individually-bound text params (the fetchHitsByIds idList pattern — drizzle's
 * sql template expands a raw JS-array param into a parenthesized list, which a
 * single `::text[]` cast cannot consume). The schema boundary guarantees a
 * non-empty list and its mutual exclusion with the scalar memoryType axis
 * (rowEligibility handles that one). Helper of {@link rowEligibility} ONLY —
 * every predicate still splices through that single point.
 */
function memoryTypesPredicate(col: (name: string) => SQL, memoryTypes: readonly string[]): SQL {
  const typeList = sql.join(
    memoryTypes.map((t) => sql`${t}`),
    sql`, `,
  )
  return sql`${col('memory_type')} = ANY(ARRAY[${typeList}]::text[])`
}

/**
 * V2 transaction-time RANGE predicates (issue #48): inclusive bounds on
 * recorded_at, bound as timestamptz like the asOf coordinates. DELIBERATELY a
 * dimensional filter, NOT time-travel: a recorded_at range narrows the live
 * view and must never lift the active-only default (only an asOf coordinate
 * does — see hasTimeTravel in {@link rowEligibility}, this helper's ONLY
 * caller).
 */
function recordedRangePredicates(
  col: (name: string) => SQL,
  filters: Pick<SearchFilters, 'recordedAfter' | 'recordedBefore'>,
): SQL[] {
  const conditions: SQL[] = []
  if (filters.recordedAfter !== undefined) {
    conditions.push(sql`${col('recorded_at')} >= ${filters.recordedAfter}::timestamptz`)
  }
  if (filters.recordedBefore !== undefined) {
    conditions.push(sql`${col('recorded_at')} <= ${filters.recordedBefore}::timestamptz`)
  }
  return conditions
}

/**
 * Build the per-row ELIGIBILITY predicate every leg/pool and the candidates CTE
 * share. It REPLACES the bare `status = 'active'` literal:
 * the SAME composed fragment is spliced into the FTS leg, the recency pool, the
 * vector pool, and the candidates clause, so a filtered read narrows EVERY leg
 * identically — preserving leg parity and the count-consistency the fusion
 * relies on (the candidate set is the union of legs over ONE eligibility rule).
 *
 * `prefix` is the call-site table-qualifier (`''` for the unaliased pool
 * subqueries `FROM memories`, `'m.'` for the candidates clause `FROM memories
 * m`). It is a fixed internal literal, NEVER user input — no injection surface.
 * Filter VALUES are bound parameters (asOf bounds bind as timestamptz).
 *
 * STATUS / asOf gating (docs/concepts/memory-model.mdx, see {@link SearchFilters}):
 *   - no time-travel: status = explicit filter ?? 'active' (the live,
 *     supersession-aware default); superseded rows stay retrievable and are
 *     RANKED down by penalty. An EMPTY/absent asOf keeps this default.
 *   - asOf with a coordinate (validAt and/or asKnownAt): the active-only default
 *     is LIFTED (surface history); an explicit status filter still applies. The
 *     valid-time predicate selects the live row. An empty `asOf:{}` is NOT
 *     time-travel and does NOT lift the default (Codex P2, comment 3372942604).
 *
 * The predicate ALWAYS leads with the caller-bound `user_id = $userId` tenant
 * condition (defense in depth, module header): splicing it into the shared
 * eligibility fragment binds EVERY leg, pool, and the candidates clause to the
 * caller's rows without touching each splice site individually.
 *
 * EXPORTED so search-list.ts's chronological list mode reuses the SAME
 * candidate-narrowing filter predicates ranked search applies — the two modes
 * can never drift on what a filter means, only on ranking-vs-ordering and the
 * live gate (search-list.ts applies its OWN valid_to IS NULL gate on top; this
 * function stays demote-not-filter, unaware of any caller's live-gate policy).
 */
export function rowEligibility(prefix: '' | 'm.', userId: string, filters: SearchFilters): SQL {
  const col = (name: string): SQL => sql.raw(`${prefix}${name}`)
  // Caller-bound tenant predicate first: matches exactly the rows RLS admits
  // when RLS is functioning, and stays correct independently of it.
  const conditions: SQL[] = [sql`${col('user_id')} = ${userId}::uuid`]

  // Status axis. With no time-travel, default to the live view (status='active');
  // an explicit status filter overrides it. The active-only default is lifted
  // ONLY when asOf carries at least one coordinate (validAt or asKnownAt) — an
  // EMPTY/absent asOf is NOT time-travel and keeps the live default. Lifting the
  // default for `asOf:{}` (no temporal predicate added below) would silently
  // return archived/superseded rows in an otherwise-unfiltered read (Codex P2,
  // comment 3372942604). Belt-and-suspenders: asOfSchema also rejects `{}`.
  const hasTimeTravel = filters.asOf?.validAt !== undefined || filters.asOf?.asKnownAt !== undefined
  if (filters.status !== undefined) {
    conditions.push(sql`${col('status')} = ${filters.status}`)
  } else if (!hasTimeTravel) {
    conditions.push(sql`${col('status')} = 'active'`)
  }

  // Bi-temporal time-travel (mirrors facts-read.ts predicate LOGIC against the
  // memories valid_from/valid_to/recorded_at columns). validAt: the row whose
  // half-open [valid_from, valid_to) window contains the instant. asKnownAt:
  // rows recorded by that instant. Bound as timestamptz (one typed context).
  if (filters.asOf?.validAt !== undefined) {
    const t = filters.asOf.validAt
    conditions.push(
      sql`${col('valid_from')} <= ${t}::timestamptz
          AND (${col('valid_to')} IS NULL OR ${col('valid_to')} > ${t}::timestamptz)`,
    )
  }
  if (filters.asOf?.asKnownAt !== undefined) {
    conditions.push(sql`${col('recorded_at')} <= ${filters.asOf.asKnownAt}::timestamptz`)
  }

  // Dimensional filters: exact-match narrowing on the denormalized text columns.
  if (filters.memoryType !== undefined) {
    conditions.push(sql`${col('memory_type')} = ${filters.memoryType}`)
  }
  if (filters.memoryTypes !== undefined) {
    conditions.push(memoryTypesPredicate(col, filters.memoryTypes))
  }
  if (filters.scope !== undefined) conditions.push(sql`${col('scope')} = ${filters.scope}`)
  if (filters.project !== undefined) conditions.push(sql`${col('project')} = ${filters.project}`)
  conditions.push(...recordedRangePredicates(col, filters))

  return sql.join(conditions, sql` AND `)
}

/**
 * Fusion: weighted sum of the FTS, recency, and vector legs, minus the
 * supersession penalty for rows with an incoming supersedes/updates edge
 * (CLOSES_PREDECESSOR, proposals-apply.ts). Ranking is supersession-AWARE,
 * never supersession-FILTERED.
 *
 * The vector leg is purely additive and weight-gated: it contributes
 * candidates and a score ONLY when weights.vector > 0 AND a queryEmbedding is
 * supplied. With the default weights vector is 0, so passing no embedding
 * leaves FTS+recency behavior byte-for-byte unchanged (gating pattern).
 *
 * WHY THE SQL IS COMPOSED CONDITIONALLY (do not collapse this back into a single
 * static template with runtime guards — two CI rounds proved both naive forms
 * fail; see toVectorLiteral). A bound vector parameter is type-resolved by
 * Postgres at BIND/PARSE time, BEFORE any WHERE/CASE gate can disable it:
 *   - An empty `'[]'::vector` placeholder fails at BIND ("vector must have at
 *     least 1 dimension"), even behind a constant-false guard.
 *   - A SQL-NULL placeholder fails at PARSE with 42P18 ("could not determine
 *     data type of parameter") wherever the rewriter cannot infer its type.
 * So the inert path emits NO vector param and NO `::vector` cast: vector_score is
 * the literal `0::float8` with no vector pool CTE or UNION arm — byte-for-byte
 * the pre-vector slice-1a shape the regression tests encode. The active
 * path builds the vector pool CTE, UNION arm, and cosine score expression, the
 * embedding cast `::vector` at EVERY occurrence and validated 1536-dim first
 * (throws {@link InvalidEmbeddingError}) so the DB never sees a malformed vector.
 */
/**
 * Supersession predicate: true when the row at `${prefix}id` is a superseded
 * predecessor — which requires BOTH halves, never either alone:
 *
 *  1. its validity is CLOSED (`${prefix}valid_to IS NOT NULL`), AND
 *  2. it has an incoming `supersedes` or `updates` edge (the
 *     CLOSES_PREDECESSOR set, proposals-apply.ts — either revise kind).
 *
 * WHY THE VALIDITY HALF IS LOAD-BEARING (do not reduce this back to the
 * edge-existence check alone). The IMPORT contract deliberately forbids
 * `closePredecessorAt` on an `updates` edge (packages/schema/src/import.ts:
 * "closing the predecessor requires a supersedes edge"), so an imported
 * `updates` edge leaves its target LIVE — `valid_to IS NULL`. Under the
 * edge-only predicate every such target was flagged `superseded: true` and hit
 * the fusion tier-penalty, so importing a graph silently demoted memories that
 * the import itself declares are still current. The revise path closes
 * `valid_to` for BOTH edge kinds, so a genuine revise still satisfies both
 * halves and demotes exactly as before — this narrows the predicate to the
 * rows that were always meant by it.
 *
 * This is now the SAME definition memory_history applies (memory-history-read.ts
 * `lifecycleState`: closed validity AND a revision edge), so a row can no longer
 * read `superseded` on one surface and `current` on the other.
 *
 * `${prefix}user_id = e.user_id` is defense in depth (module
 * header: TENANT ISOLATION IS TWO-LAYER) — RLS already scopes `memory_edges`
 * to the caller inside withTenant(), and this predicate ADDITIONALLY binds the
 * edge to the SAME tenant as the row it labels, matching the explicit
 * caller-bound pattern every other join/subquery in this file uses (e.g. the
 * `commitments` join's `c.user_id = m.user_id`) rather than resting on RLS
 * alone. EXPORTED and reused verbatim by every call site that computes the
 * `superseded` flag or the tier-penalty (searchFused's candidates CTE, the
 * standalone legs below, {@link fetchHitsByIds}, search-list.ts's
 * chronological mode) so the closed-validity + two-edge-type definition and
 * the tenant bind can never drift between them.
 *
 * WARNING — the caller's `FROM memories` MUST be ALIASED and the alias MUST
 * be passed here, even for a single-table query with no other table in scope.
 * `memory_edges` (aliased `e` inside this EXISTS) has its OWN `id` and
 * `user_id` columns, so an UNQUALIFIED `id`/`user_id` reference inside the
 * subquery
 * subquery resolves to the subquery's OWN innermost scope (`e.id`/`e.user_id`)
 * per standard SQL name resolution — NOT to the outer `memories` row, even
 * with no alias collision error to catch it. That silently turned this into
 * `e.to_id = e.id` (effectively never true) wherever a caller queried
 * `FROM memories` unaliased. The signature therefore takes a MANDATORY alias
 * (no bare/empty option), making the unqualified-reference mistake
 * unrepresentable rather than merely documented. The alias now carries the
 * `valid_to` reference too, so it must resolve to the `memories` row the flag
 * describes — `memory_edges` has no `valid_to` column, so a mis-aliased use
 * fails loudly at parse time rather than silently, unlike the id/user_id case
 * above.
 */
export function supersededExists(alias: string): SQL {
  const idCol = sql.raw(`${alias}.id`)
  const userIdCol = sql.raw(`${alias}.user_id`)
  const validToCol = sql.raw(`${alias}.valid_to`)
  return sql`(${validToCol} IS NOT NULL AND EXISTS (
    SELECT 1 FROM memory_edges e
    WHERE e.to_id = ${idCol} AND e.user_id = ${userIdCol}
      AND e.edge_type IN ('supersedes', 'updates')
  ))`
}

/**
 * Keyset continuation predicate over the fused `score` total order
 * (`score DESC, id ASC`). First page (no cursor) → `true`; a continuation page
 * resumes STRICTLY after the cursor row, so a row already shown cannot reappear
 * and an unseen row cannot be skipped — the offset failure mode. The
 * float8 `score =` branch is a within-request tiebreak: cross-request score
 * drift (now()-based recency, window-relative FTS norm) rarely lands an exact
 * match, so continuation leans on the `score <` branch, which stays correct.
 */
function buildCursorPredicate(cursor?: { score: number; id: string }): SQL {
  if (cursor === undefined) return sql`true`
  return sql`(score < ${cursor.score}::float8
              OR (score = ${cursor.score}::float8 AND id > ${cursor.id}::uuid))`
}

export async function searchFused(
  tx: TenantTx,
  userId: string,
  query: string,
  limit: number,
  weights: FusionWeights = DEFAULT_FUSION_WEIGHTS,
  supersessionPenalty: number = DEFAULT_SUPERSESSION_PENALTY,
  queryEmbedding?: number[],
  filters: SearchFilters = {},
  cursor?: { score: number; id: string },
  options: { returnFullPool?: boolean } = {},
): Promise<SearchHit[]> {
  // Over-fetch each leg so fusion has candidates beyond a single leg's top-N.
  // The floor keeps the per-leg recall window deep enough at small limits, where
  // limit * 4 alone starves the candidate set (see
  // CANDIDATE_POOL_FLOOR). The pool is tied to the requested page size,
  // not the offset, so continuation pages rank against the same bounded universe.
  const pool = Math.max(limit * 4, CANDIDATE_POOL_FLOOR)
  // The shared per-row eligibility predicate (status / asOf / dimensional
  // filters). Spliced into EVERY leg, pool, and the candidates clause so a
  // filtered read narrows the SAME candidate set the fusion ranks.
  // With no filters it is `user_id = $userId AND status = 'active'` (pools) /
  // the `m.`-qualified twin (candidates) — the caller-bound tenant predicate
  // rides every splice (defense in depth, module header) and the unfiltered
  // output is unchanged while RLS functions. The unaliased form serves the
  // `FROM memories` pool subqueries; the `m.`-aliased form serves the
  // `FROM memories m` candidates clause.
  const poolEligibility = rowEligibility('', userId, filters)
  const candidateEligibility = rowEligibility('m.', userId, filters)
  // The vector leg runs only when enabled AND fed an embedding; otherwise it is
  // inert. Both the app guard and the composed SQL key on this SAME flag, so a
  // non-zero vector weight WITHOUT an embedding stays inert (pattern).
  const vectorActive = weights.vector > 0 && queryEmbedding !== undefined

  // Build the three vector-dependent SQL fragments CONDITIONALLY. On the inert
  // path none of them reference the embedding param or a `::vector` cast — that
  // is the whole point (see this function's doc comment and toVectorLiteral):
  //   - vectorPoolCte: the over-fetch candidate CTE (active) or empty (inert)
  //   - vectorUnionArm: the candidate_ids UNION arm (active) or empty (inert)
  //   - vectorScoreExpr: the cosine similarity (active) or literal 0 (inert)
  let vectorPoolCte: SQL = sql.empty()
  let vectorUnionArm: SQL = sql.empty()
  let vectorScoreExpr: SQL = sql`0::float8`
  // topicMatch leg: additive bonus when the memory's topic contains the query
  // string (case-insensitive LIKE). Active only when the caller supplies a
  // positive topicMatch weight (short-name entity boost). On the
  // inert path (undefined or 0) it emits a literal 0::float8 with no LIKE
  // expression — no extra cost, no extra parameter.
  const topicMatchActive = (weights.topicMatch ?? 0) > 0
  const queryValue = query
  const topicMatchScoreExpr: SQL = topicMatchActive
    ? sql`CASE WHEN lower(m.topic) LIKE lower('%' || ${queryValue} || '%') THEN 1.0::float8 ELSE 0::float8 END
         * ${weights.topicMatch as number}::float8`
    : sql`0::float8`
  if (vectorActive) {
    // Active path: embedding must be bindable, so validate up front (typed
    // error, never an opaque vector_in failure from the DB).
    assertEmbeddingDimensions(queryEmbedding)
    // See searchVector: filtered HNSW scans need iterative scan to fill the
    // pool. SET LOCAL keeps the GUC scoped to this withTenant() transaction.
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
    const vec = toVectorLiteral(queryEmbedding)
    // EXACTLY mirrors the recency_pool over-fetch shape so the supersession
    // tier-penalty (2) cannot crowd a successor out of the window. NULL-embedding
    // rows are excluded (no vector to compare). The embedding param is cast
    // `::vector` at every occurrence.
    vectorPoolCte = sql`,
    vector_pool AS (
      SELECT id FROM memories
      WHERE ${poolEligibility} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::vector LIMIT ${pool}
    )`
    vectorUnionArm = sql`
      UNION SELECT id FROM vector_pool`
    // pgvector cosine distance (<=>) is in [0, 2], so 1 - distance is in
    // [-1, 1] and goes NEGATIVE for dissimilar pairs. The fusion is a weighted
    // SUM whose legs are contracted to [0, 1] (see module header); an unclamped
    // negative vector term would SUBTRACT from lexical/recency hits pulled in via
    // the UNION. GREATEST(0, ...) clamps the leg back into [0, 1].
    vectorScoreExpr = sql`CASE WHEN m.embedding IS NOT NULL
                  THEN GREATEST(0, 1 - (m.embedding <=> ${vec}::vector))
                  ELSE 0 END`
  }

  const rows = await tx.execute(sql`
    WITH q AS (SELECT websearch_to_tsquery('english', ${query}) AS tsq),
    fts AS (
      SELECT m.id, ts_rank(m.search_tsv, q.tsq) AS raw
      FROM memories m, q
      WHERE ${candidateEligibility} AND m.search_tsv @@ q.tsq
        AND ${weights.fts}::float8 > 0
      ORDER BY raw DESC LIMIT ${pool}
    ),
    fts_norm AS (
      SELECT id,
             CASE WHEN max(raw) OVER () = min(raw) OVER () THEN 1.0
                  ELSE (raw - min(raw) OVER ()) / (max(raw) OVER () - min(raw) OVER ())
             END AS score
      FROM fts
    ),
    -- Each leg contributes candidates only while its weight is non-zero: the
    -- weights are the leg-enable knob, so a disabled leg must neither score
    -- nor recall (Codex P2s on #88/#89). Without the recency union, a query
    -- with no lexical match returned nothing even at recency weight 1.
    recency_pool AS (
      SELECT id FROM memories
      WHERE ${poolEligibility} AND ${weights.recency}::float8 > 0
      ORDER BY recorded_at DESC LIMIT ${pool}
    )${vectorPoolCte},
    candidate_ids AS (
      SELECT id FROM fts_norm
      UNION SELECT id FROM recency_pool${vectorUnionArm}
    ),
    candidates AS (
      SELECT m.id, m.memory_type, m.topic, m.content, c.status AS commitment_status,
             coalesce(f.score, 0) AS fts_score,
             power(0.5, EXTRACT(EPOCH FROM (now() - m.recorded_at)) / 86400.0
                        / ${DEFAULT_RECENCY_HALF_LIFE_DAYS}) AS recency_score,
             -- vector_score is the composed fragment: the cosine similarity on
             -- the active path, the literal 0::float8 on the inert path (no
             -- vector param exists then — see the doc comment).
             ${vectorScoreExpr} AS vector_score,
             -- topic_match_score: additive bonus when the memory's topic contains
             -- the query string (issue #339). Inert path emits literal 0::float8.
             ${topicMatchScoreExpr} AS topic_match_score,
             -- CLOSES_PREDECESSOR (proposals-apply.ts): both revise kinds close
             -- the predecessor's validity, so both demote it here — an
             -- 'updates' revise must rank its predecessor down exactly like a
             -- 'supersedes' revise does, not escape demotion silently. The
             -- predicate additionally requires that closed validity, so an
             -- IMPORTED 'updates' edge (which cannot close its target) does not
             -- demote a still-live memory — see supersededExists.
             ${supersededExists('m')} AS superseded
      FROM memories m
      LEFT JOIN fts_norm f ON f.id = m.id
      LEFT JOIN commitments c ON c.user_id = m.user_id AND c.memory_id = m.id
      WHERE ${candidateEligibility} AND m.id IN (SELECT id FROM candidate_ids)
    ),
    -- Materialize the fused score so the keyset predicate can filter on it: a
    -- computed alias is not referenceable in the same SELECT's WHERE, so the
    -- score is wrapped here and the continuation cursor filters the outer query.
    scored AS (
      SELECT id, memory_type, topic, content, commitment_status,
             -- vector_score is the UNWEIGHTED cosine-scale leg component, surfaced
             -- additively for cosine-scale abstention (core policy reads it on the
             -- top hit and compares to the frozen tau). On the inert path it is the
             -- literal 0::float8 (no vector param exists) and mapHits drops it.
             vector_score,
             -- Carried through so the caller can label a demoted row rather
             -- than receive it unmarked (superseded: boolean on SearchHit).
             superseded,
             (${weights.fts}::float8 * fts_score
              + ${weights.recency}::float8 * recency_score
              + ${weights.vector}::float8 * vector_score
              + topic_match_score
              - CASE WHEN superseded THEN ${supersessionPenalty}::float8 ELSE 0 END) AS score
      FROM candidates
    )
    SELECT id, memory_type, topic, content, commitment_status, vector_score, superseded, score
    FROM scored
    WHERE ${buildCursorPredicate(cursor)}
    ORDER BY score DESC, id ASC
    LIMIT ${options.returnFullPool === true ? pool : limit}
  `)
  // Only attach vectorScore when the vector leg actually ran; on the inert path
  // vector_score is a meaningless literal 0 and must not masquerade as a cosine.
  return mapHits(rows, vectorActive)
}

/**
 * Fetch display rows for a set of ids WITHOUT ranking — the continuation half of
 * the frozen-ordering cursor. The first page froze the ranked
 * ordering; a continuation page slices that frozen ordering by position and
 * calls this to materialize the slice's rows. No scoring runs here: the caller
 * applies the FROZEN scores and the FROZEN order. The same eligibility predicate
 * as {@link searchFused} is applied, so a row that became ineligible (archived,
 * superseded under an active-only view) between requests drops out cleanly — a
 * mid-session corpus shrink yields a shorter page, never a skip of a frozen
 * position. `score` on the returned hits is a placeholder the caller overwrites.
 */
export async function fetchHitsByIds(
  tx: TenantTx,
  userId: string,
  ids: string[],
  filters: SearchFilters = {},
): Promise<SearchHit[]> {
  if (ids.length === 0) return []
  const eligibility = rowEligibility('m.', userId, filters)
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const rows = await tx.execute(sql`
    SELECT m.id, m.memory_type, m.topic, m.content, c.status AS commitment_status,
           ${supersededExists('m')} AS superseded,
           0::float8 AS score
    FROM memories m
    LEFT JOIN commitments c ON c.user_id = m.user_id AND c.memory_id = m.id
    WHERE ${eligibility} AND m.id IN (${idList})
  `)
  return mapHits(rows, false)
}

interface RawRow {
  id: string
  memory_type: string
  topic: string
  content: string
  score: string | number
  vector_score?: string | number
  commitment_status?: string | null
  superseded?: boolean
}

/**
 * Map raw rows to {@link SearchHit}. `withVectorScore` is true only on the
 * active vector path of {@link searchFused}; the FTS/recency-only legs
 * (searchFts, searchRecency) and the inert fused path pass it false so the
 * cosine-scale `vectorScore` stays `undefined` rather than a misleading 0.
 */
function mapHits(result: { rows: unknown[] }, withVectorScore = false): SearchHit[] {
  return (result.rows as RawRow[]).map((r) => ({
    id: r.id,
    memoryType: r.memory_type,
    topic: r.topic,
    content: r.content,
    score: Number(r.score),
    // Always present (required on SearchHit) and always genuinely computed —
    // every caller of mapHits selects `superseded` via supersededExists, so
    // Boolean(...) here is a type coercion (raw driver value), never a
    // stubbed default for a query that skipped the column.
    superseded: Boolean(r.superseded),
    ...(withVectorScore && r.vector_score !== undefined
      ? { vectorScore: Number(r.vector_score) }
      : {}),
    ...(r.commitment_status == null
      ? {}
      : { commitmentStatus: r.commitment_status as CommitmentStatus }),
  }))
}
