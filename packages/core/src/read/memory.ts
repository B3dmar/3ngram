// SPDX-License-Identifier: Apache-2.0
// getMemoryById(): the single-memory inspect policy surface.
//
// apps -> core -> db layering (hard rule 5): thin policy over the db keyed lookup,
// wrapped in withTenant (hard rule 3). An absent id is a TYPED not-found error
// (never a silent undefined that a transport must re-interpret), so the REST
// mapper surfaces a 404 — mirroring the ProposalNotFoundError contract.
//
// Observability (hard rule 6): the returned row carries content — it is NEVER
// logged here; callers log the id only. This module logs nothing.
import { getMemoryById as getMemoryByIdDb, type MemoryDetailRow, withTenant } from '@3ngram/db'

export type { MemoryDetailRow } from '@3ngram/db'

/**
 * Thrown when an inspect targets a memory that does not exist for the tenant. RLS
 * hides cross-tenant rows, so not-found and not-owned collapse to one mapping
 * (the REST layer maps this to a 404). Names the missing id only — never content.
 */
export class MemoryNotFoundError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super(`no memory ${memoryId} for this tenant`)
    this.name = 'MemoryNotFoundError'
    this.memoryId = memoryId
  }
}

/**
 * Fetch one memory by id for the tenant. Returns the full row (incl. content +
 * tags). Throws {@link MemoryNotFoundError} when the id is unknown for the tenant
 * (RLS-filtered), so the caller never has to special-case undefined. Runs inside
 * withTenant(): RLS enforces tenant isolation.
 *
 * @param userId    Tenant whose RLS context the read runs under.
 * @param memoryId  The memory to inspect.
 * @throws {@link MemoryNotFoundError} when no such memory exists for the tenant.
 */
export async function getMemoryById(userId: string, memoryId: string): Promise<MemoryDetailRow> {
  const row = await withTenant(userId, (tx) => getMemoryByIdDb(tx, memoryId))
  if (row === undefined) throw new MemoryNotFoundError(memoryId)
  return row
}
