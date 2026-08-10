// SPDX-License-Identifier: Apache-2.0
// searchChronological(): the list-mode retrieval policy surface.
//
// apps -> core -> db layering (hard rule 5): db/search-list.ts owns the SQL
// (filters + ordering + keyset); this module owns the PRODUCT POLICY — scope
// resolution and the read-path content excerpt, same split as search.ts.
// UNLIKE search()/searchDashboardPage(), this path NEVER acquires an
// embedding: no gateway call, no query-embed cost row, no abstention signal
// (there is no vectorScore to compare against tau) — it is a pure filtered
// enumeration, not a ranked retrieval.
import { type ChronologicalCursor, searchList, withTenant } from '@3ngram/db'
import { type ListOptions, resolveListOptions } from './search-options.js'
import { type SearchHit, shapeSearchHit } from './search-results.js'

export type { ListOptions } from './search-options.js'

/** One chronological list page: shaped hits plus the continuation state. */
export interface ListPage {
  hits: SearchHit[]
  hasMore: boolean
  /** The keyset position to resume from; `undefined` when the page is empty or exhausted. */
  nextCursor: ChronologicalCursor | undefined
  /** The scope a retrieval-scope policy applied to an unscoped call, or `null` when nothing was narrowed. */
  appliedScope: string | null
}

/**
 * Exhaustive, chronological (most-recent-first) listing of live memories,
 * narrowed by the SAME candidate filters ranked search applies. No query, no
 * embedding, no fusion — a filtered enumeration, not a ranked retrieval.
 *
 * RETRIEVAL-SCOPE POLICY (issue #47) applies identically to ranked search: a
 * `require`-mode policy with no scope filter throws before any database work.
 *
 * @param userId Tenant whose RLS context the read runs under.
 * @param opts   Optional limit / cursor / filters / access gate / retrieval policy.
 */
export async function searchChronological(
  userId: string,
  opts: ListOptions = {},
): Promise<ListPage> {
  if (opts.access) await opts.access.assertRead(userId)
  const resolved = resolveListOptions(opts)
  const page = await withTenant(userId, (tx) =>
    searchList(tx, userId, resolved.limit, resolved.filters, resolved.cursor),
  )
  return {
    hits: page.hits.map(shapeSearchHit),
    hasMore: page.hasMore,
    nextCursor: page.cursor,
    appliedScope: resolved.appliedScope,
  }
}
