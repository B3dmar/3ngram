// SPDX-License-Identifier: Apache-2.0
// Chronological list mode (exhaustive/chronological retrieval): a filter-driven
// enumeration of memories in recorded-time order — no fusion, no scoring, no
// embedding call. A SEPARATE small module from search.ts (already near the
// 500-line file cap, hard rule 5) so the ranked-fusion path stays free of an
// unrelated branch; reuses rowEligibility + supersededExists from search.ts so
// the two retrieval modes can never drift on what a filter or the superseded
// flag means.
//
// LIVE GATE DIVERGES FROM RANKED SEARCH (deliberate — docs/concepts/memory-model.mdx
// documents all three "live" definitions used across this codebase: the
// status='active' default, this valid_to IS NULL exhaustive-list gate, and the
// asOf bi-temporal view). searchFused NEVER filters on valid_to — it demotes a
// superseded predecessor by score penalty, never drops it (demote-not-filter).
// An EXHAUSTIVE list has no ranking to demote WITH: without a live gate, a
// superseded predecessor would sit at the SAME rank as its successor and
// double-count the "current" set. List mode therefore filters to
// valid_to IS NULL — the SAME live gate listMemories (memory-read.ts) uses —
// UNLESS an asOf coordinate explicitly asks for a historical view (surface
// history when asked, never silently drop): rowEligibility's bi-temporal
// predicate already selects the single row valid at that instant, so forcing
// valid_to IS NULL on top would silently exclude the very row asOf asked for.
import { type SQL, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { rowEligibility, type SearchFilters, type SearchHit, supersededExists } from './search.js'

/** Position within the chronological total order (`recorded_at DESC, id DESC`). */
export interface ChronologicalCursor {
  recordedAt: Date
  id: string
}

/** One page of an exhaustive chronological listing. */
export interface ChronologicalPage {
  hits: SearchHit[]
  /** The last-returned row's position, for minting the next page's cursor. `undefined` iff `hits` is empty. */
  cursor: ChronologicalCursor | undefined
  hasMore: boolean
}

/**
 * Keyset continuation over the chronological total order (`recorded_at DESC,
 * id DESC`). Unlike {@link buildCursorPredicate}'s fused-score keyset,
 * `recorded_at` is DRIFT-FREE — it never changes after insert — so this
 * cursor can never repeat or skip a row even under concurrent writes; no
 * frozen candidate pool is needed the way ranked search needs one.
 */
function buildChronologicalCursorPredicate(cursor: ChronologicalCursor | undefined): SQL {
  if (cursor === undefined) return sql`true`
  return sql`(recorded_at < ${cursor.recordedAt}::timestamptz
              OR (recorded_at = ${cursor.recordedAt}::timestamptz AND id < ${cursor.id}::uuid))`
}

interface ListRow {
  id: string
  memory_type: string
  topic: string
  content: string
  recorded_at: string
  superseded: boolean
  score: string | number
}

/**
 * Exhaustive, filter-driven chronological listing (most-recent-first). No
 * fusion, no embedding — `score` is a literal 0 placeholder (list mode is
 * unranked). Reuses rowEligibility for the SAME candidate-narrowing filters
 * ranked search applies, so the two modes can never drift on filter semantics.
 *
 * Overfetches `limit + 1` to detect `hasMore` without a separate COUNT query;
 * the extra row is trimmed before mapping. Runs inside withTenant(): RLS
 * isolates, and the caller-bound `user_id` predicate (via rowEligibility)
 * binds defense in depth (module header, search.ts).
 */
export async function searchList(
  tx: TenantTx,
  userId: string,
  limit: number,
  filters: SearchFilters = {},
  cursor?: ChronologicalCursor,
): Promise<ChronologicalPage> {
  // FROM memories is aliased `m` below (the supersededExists WARNING doc
  // comment applies), so rowEligibility is called with the matching 'm.'
  // prefix for consistency with every other aliased call site in search.ts —
  // unqualified refs would still resolve correctly at this top-level WHERE
  // (no competing table in THIS query's own scope, unlike the EXISTS
  // subquery), but qualifying keeps the convention uniform and future-proof
  // against this query later growing a join.
  const eligibility = rowEligibility('m.', userId, filters)
  const hasTimeTravel = filters.asOf?.validAt !== undefined || filters.asOf?.asKnownAt !== undefined
  const liveGate = hasTimeTravel ? sql`true` : sql`valid_to IS NULL`
  // FROM memories MUST be aliased — supersededExists's own WARNING doc comment
  // (search.ts) explains why an unaliased FROM silently binds the EXISTS
  // subquery's unqualified id/user_id to memory_edges' OWN columns instead of
  // this row's.
  const rows = await tx.execute(sql`
    SELECT id, memory_type, topic, content, recorded_at,
           ${supersededExists('m')} AS superseded,
           0::float8 AS score
    FROM memories m
    WHERE ${eligibility} AND ${liveGate} AND ${buildChronologicalCursorPredicate(cursor)}
    ORDER BY recorded_at DESC, id DESC
    LIMIT ${limit + 1}
  `)
  const allRows = rows.rows as unknown as ListRow[]
  const hasMore = allRows.length > limit
  const page = hasMore ? allRows.slice(0, limit) : allRows
  const last = page[page.length - 1]
  return {
    hits: page.map((r) => ({
      id: r.id,
      memoryType: r.memory_type,
      topic: r.topic,
      content: r.content,
      score: Number(r.score),
      superseded: Boolean(r.superseded),
    })),
    cursor:
      last === undefined ? undefined : { recordedAt: new Date(last.recorded_at), id: last.id },
    hasMore,
  }
}
