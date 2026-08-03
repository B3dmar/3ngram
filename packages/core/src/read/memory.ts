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
import {
  getMemoriesByIds as getMemoriesByIdsDb,
  getMemoryById as getMemoryByIdDb,
  type MemoryDetailRow,
  withTenant,
} from '@3ngram/db'
import { DEFAULT_GET_CONTENT_CHARS } from '@3ngram/schema'
import { excerptContent } from './excerpt.js'

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
  const row = await withTenant(userId, (tx) => getMemoryByIdDb(tx, userId, memoryId))
  if (row === undefined) throw new MemoryNotFoundError(memoryId)
  return row
}

/** Options for {@link getMemoriesByIds}: the per-item content bound. */
export interface GetMemoriesOptions {
  /** Per-item content cap (chars). Validated at the schema boundary; defaults to DEFAULT_GET_CONTENT_CHARS. */
  maxContentChars?: number
}

/**
 * One batch-read result row: the full detail row with `content` replaced by
 * the BOUNDED excerpt plus the excerpting triple (`contentLength` = full
 * stored length, `truncated` = the cut flag). Read-side shaping only — the
 * stored row is never touched (docs/concepts/memory-model.mdx).
 */
export interface MemoryBatchItem extends Omit<MemoryDetailRow, 'content'> {
  content: string
  contentLength: number
  truncated: boolean
}

/** A batch read result: the found rows plus the ids that resolved to nothing. */
export interface MemoriesBatchRead {
  memories: MemoryBatchItem[]
  /** Requested ids (lowercased, deduped, request order) with no row for THIS tenant — unknown and cross-tenant alike. */
  notFound: string[]
}

/**
 * Fetch a batch of memories by id for the tenant — the follow-up read for a
 * search/handoff line that came back `truncated: true`. ONE withTenant / ONE
 * batched query (id = ANY), never a per-id getMemoryById loop. Each row's
 * content is bounded to `maxContentChars` by the shared excerpting policy
 * (excerpt.ts) — an import-scale row (up to 262,144 chars) never rides back
 * verbatim. A missing or cross-tenant id lands in `notFound`, NEVER an error
 * (unlike the single-id inspect's typed 404): one bad id must not fail the
 * batch, and RLS + the caller-bound predicate collapse not-found/not-owned so
 * the result never leaks whether a foreign id exists. Ids are lowercased and
 * deduped ONCE at entry: z.uuid() accepts mixed-case spellings and Postgres's
 * uuid type matches them (so the row IS found), but rows come back with
 * lowercase ids — without normalization the case-sensitive diff would put a
 * FOUND memory's requested id into notFound too.
 */
export async function getMemoriesByIds(
  userId: string,
  memoryIds: string[],
  options: GetMemoriesOptions = {},
): Promise<MemoriesBatchRead> {
  const maxContentChars = options.maxContentChars ?? DEFAULT_GET_CONTENT_CHARS
  const requestedIds = [...new Set(memoryIds.map((id) => id.toLowerCase()))]
  const rows = await withTenant(userId, (tx) => getMemoriesByIdsDb(tx, userId, requestedIds))
  const found = new Set(rows.map((row) => row.id))
  const notFound = requestedIds.filter((id) => !found.has(id))
  return {
    memories: rows.map((row) => ({ ...row, ...excerptContent(row.content, maxContentChars) })),
    notFound,
  }
}
