// SPDX-License-Identifier: Apache-2.0
// listMemories(): the bounded dashboard memory-list policy surface.
//
// apps -> core -> db layering (hard rule 5): this owns the read POLICY (one
// withTenant tx for a consistent page + its unpaged total) and delegates the SQL
// to packages/db (memory-read.ts) under withTenant (hard rule 3). Transports
// (REST) call this and hold zero business logic.
//
// VALIDATION (hard rule 2): the single boundary is packages/schema
// (memoriesListQuerySchema). The transport parses there and passes the validated,
// typed query through; this module trusts its typed arguments (it does not
// re-validate — mirroring listProposals).
//
// Observability (hard rule 6): topic/project/scope are content-adjacent and are
// NEVER logged. This module logs nothing; callers honour the same rule.
import {
  countMemories,
  listMemories as listMemoriesDb,
  listMemoryFacets as listMemoryFacetsDb,
  type MemoriesListQuery,
  type MemoryFacets,
  type MemoryListRow,
  withTenant,
} from '@3ngram/db'

export type { MemoriesListQuery, MemoryFacets, MemoryListRow } from '@3ngram/db'

/** A page of memories plus the unpaged total for the same filters. */
export interface MemoriesPage {
  memories: MemoryListRow[]
  total: number
}

/**
 * List the tenant's LIVE memories (status='active' AND valid_to IS NULL), most
 * recent first, paged + narrowed by `query`, with the unpaged total for the same
 * filters. The page and its total are read in ONE withTenant transaction so they
 * are a consistent snapshot (no torn count under a concurrent write). RLS
 * enforces tenant isolation on both reads.
 *
 * @param userId  Tenant whose RLS context the read runs under.
 * @param query   Validated paging + filters (the transport parsed the schema).
 */
export async function listMemories(
  userId: string,
  query: MemoriesListQuery,
): Promise<MemoriesPage> {
  return withTenant(userId, async (tx) => {
    const memories = await listMemoriesDb(tx, query)
    const total = await countMemories(tx, query)
    return { memories, total }
  })
}

/**
 * Return the DISTINCT scope and project values present in the tenant's LIVE
 * memories. One withTenant transaction for a consistent snapshot. RLS enforces
 * tenant isolation. Used by GET /api/v1/memories/facets.
 *
 * @param userId  Tenant whose RLS context the read runs under.
 */
export async function listMemoryFacets(userId: string): Promise<MemoryFacets> {
  return withTenant(userId, (tx) => listMemoryFacetsDb(tx))
}
