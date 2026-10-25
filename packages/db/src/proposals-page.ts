// SPDX-License-Identifier: Apache-2.0
// Keyset reads for complete proposal-review pagination (issue #320).
//
// SQL ONLY (hard rule 5): each function reads ONE proposal table in
// `created_at DESC, id DESC` order, strictly after an optional keyset position,
// and returns each row with its position. MERGING the kinds into one stream,
// choosing how many rows to fetch, and deciding `hasMore`/the next position is
// policy and lives in packages/core (admin/proposals-page.ts). Every query runs
// inside the caller's withTenant() transaction, so RLS scopes rows to the
// caller (the edge reads follow proposals-read.ts and bind no user_id; the
// fact reads follow fact-proposals.ts and also bind it as defense in depth).
//
// MICROSECOND PRECISION (the search-list.ts precedent): `created_at` is the
// writing transaction's `now()`, so a batch of proposals shares ONE timestamp
// at microsecond resolution. The position is therefore selected as
// full-precision ISO text via to_char(... AT TIME ZONE 'UTC' ...) and bound
// back verbatim with `::timestamptz` — never round-tripped through a JS Date,
// whose millisecond truncation would make `created_at = boundary` false for a
// tied group and silently strand it.
//
// Observability (hard rule 6): this module logs nothing; rationale and the
// proposed claim are content and never leave the returned rows.
import { and, count, desc, eq, type SQL, sql } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { TenantTx } from './client.js'
import { FACT_PROPOSAL_COLUMNS, type FactProposalRow } from './fact-proposals.js'
import type { ProposalRow } from './proposals-read.js'
import { consolidationProposals, factProposals } from './schema/memory.js'

/** A position in the `created_at DESC, id DESC` order: full-microsecond ISO text + uuid. */
export interface ProposalKeyset {
  createdAt: string
  id: string
}

/** One row plus its keyset position. */
export interface KeyedProposal<T> {
  record: T
  position: ProposalKeyset
}

/**
 * One keyset read: an optional status filter, the maximum rows to return, and
 * an optional position to resume strictly after. Optional keys admit
 * `undefined` explicitly (exactOptionalPropertyTypes).
 */
export interface ProposalPageQuery {
  status?: string | undefined
  limit: number
  after?: ProposalKeyset | undefined
}

/** `created_at` as full-microsecond UTC ISO 8601 text (module header). */
function createdAtIso(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/** Strictly-after predicate on `(created_at, id)` descending; `undefined` for page 1. */
function afterPredicate(
  createdAt: PgColumn,
  id: PgColumn,
  after: ProposalKeyset | undefined,
): SQL | undefined {
  if (after === undefined) return undefined
  return sql`(${createdAt} < ${after.createdAt}::timestamptz
              OR (${createdAt} = ${after.createdAt}::timestamptz AND ${id} < ${after.id}::uuid))`
}

/** Split a selected row into its record and its keyset position. */
function keyed<T extends { id: string }>(row: T & { createdAtIso: string }): KeyedProposal<T> {
  const { createdAtIso: iso, ...record } = row
  return { record: record as unknown as T, position: { createdAt: iso, id: row.id } }
}

const EDGE_COLUMNS = {
  id: consolidationProposals.id,
  fromId: consolidationProposals.fromId,
  toId: consolidationProposals.toId,
  edgeType: consolidationProposals.edgeType,
  memoryType: consolidationProposals.memoryType,
  similarity: consolidationProposals.similarity,
  rationale: consolidationProposals.rationale,
  status: consolidationProposals.status,
  decidedAt: consolidationProposals.decidedAt,
  createdAt: consolidationProposals.createdAt,
} as const

/** Edge (consolidation) proposals after `query.after`, most-recent first, at most `query.limit`. */
export async function listProposalsAfter(
  tx: TenantTx,
  query: ProposalPageQuery,
): Promise<KeyedProposal<ProposalRow>[]> {
  const t = consolidationProposals
  const rows = await tx
    .select({ ...EDGE_COLUMNS, createdAtIso: createdAtIso(t.createdAt) })
    .from(t)
    .where(
      and(
        query.status === undefined ? undefined : eq(t.status, query.status),
        afterPredicate(t.createdAt, t.id, query.after),
      ),
    )
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(query.limit)
  return rows.map(keyed)
}

/** Fact proposals after `query.after`, most-recent first, at most `query.limit`. */
export async function listFactProposalsAfter(
  tx: TenantTx,
  userId: string,
  query: ProposalPageQuery,
): Promise<KeyedProposal<FactProposalRow>[]> {
  const t = factProposals
  const rows = await tx
    .select({ ...FACT_PROPOSAL_COLUMNS, createdAtIso: createdAtIso(t.createdAt) })
    .from(t)
    .where(
      and(
        eq(t.userId, userId),
        query.status === undefined ? undefined : eq(t.status, query.status),
        afterPredicate(t.createdAt, t.id, query.after),
      ),
    )
    .orderBy(desc(t.createdAt), desc(t.id))
    .limit(query.limit)
  return rows.map(keyed)
}

/** Count the tenant's edge proposals matching an optional status filter. */
export async function countProposals(tx: TenantTx, status?: string): Promise<number> {
  const t = consolidationProposals
  const [row] = await tx
    .select({ n: count() })
    .from(t)
    .where(status === undefined ? undefined : eq(t.status, status))
  return row?.n ?? 0
}

/** Count the tenant's fact proposals matching an optional status filter. */
export async function countFactProposals(
  tx: TenantTx,
  userId: string,
  status?: string,
): Promise<number> {
  const t = factProposals
  const [row] = await tx
    .select({ n: count() })
    .from(t)
    .where(and(eq(t.userId, userId), status === undefined ? undefined : eq(t.status, status)))
  return row?.n ?? 0
}
