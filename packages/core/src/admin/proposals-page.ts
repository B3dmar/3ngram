// SPDX-License-Identifier: Apache-2.0
// Complete, read-only pagination over the proposal review queues (issue #320).
// apps -> core -> db (hard rule 5): the db layer reads ONE table per call in
// keyset order; this module MERGES the kinds into one stream, decides the page,
// `hasMore` and the next position, and wraps the whole page in one withTenant
// transaction (hard rule 3). The opaque cursor encoding is transport-side
// (apps/server/src/cursor.ts), as it is for search.
//
// THE MERGE: every kind is ordered `created_at DESC, id DESC`, ids are uuidv7
// from disjoint tables, so the union has a strict total order. Each page reads
// `limit + 1` rows from EVERY source under the same filter and strictly-after
// predicate — the union's first `limit + 1` rows are guaranteed to be among
// them — merges, and emits the first `limit`. More than `limit` rows in the
// union means `hasMore`, and the last EMITTED row is the next position. A
// future kind (resolution proposals, issue #229) joins by adding one more source
// to {@link mergeProposalStreams}; the position type does not change.
//
// SNAPSHOT: the page rows and `totals` are read in ONE `repeatable read`,
// `read only` transaction, so a page agrees with its own totals and listing
// cannot write anything (proposal or memory) even by accident. Across pages the
// walk is LIVE — see packages/schema/src/proposals-page.ts for the concurrent
// create/decide contract.
import {
  countFactProposals,
  countProposals,
  type KeyedProposal,
  listFactProposalsAfter,
  listProposalsAfter,
  type ProposalKeyset,
  type TenantTx,
  withTenant,
} from '@3ngram/db'
import type { FactProposalRecord, ProposalRecord } from './proposals.js'

/** A position in the merged `created_at DESC, id DESC` proposal order. */
export type ProposalPosition = ProposalKeyset

/** One page request: optional status filter, page size across ALL kinds, optional resume position. */
export interface ProposalsPageQuery {
  status?: string | undefined
  limit: number
  after?: ProposalPosition | undefined
}

/** The outcome of a merge: the emitted rows, whether more remain, and where to resume. */
export interface MergedPage<R> {
  page: R[]
  hasMore: boolean
  /** Position of the last emitted row; present exactly when `hasMore`. */
  next: ProposalPosition | undefined
}

/** Both kinds (MCP `review_proposals` list). */
export interface ProposalsPage {
  proposals: ProposalRecord[]
  factProposals: FactProposalRecord[]
  /** Live per-kind count of rows matching the status filter, as of this page's read. */
  totals: { edge: number; fact: number }
  hasMore: boolean
  next: ProposalPosition | undefined
}

/** Edge proposals only (REST `GET /api/v1/proposals`). */
export interface EdgeProposalsPage {
  proposals: ProposalRecord[]
  totals: { edge: number }
  hasMore: boolean
  next: ProposalPosition | undefined
}

/** The page is a pure read: one consistent snapshot, and no write can run in it. */
const READ_ONLY_SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

/** Descending `(createdAt, id)`: fixed-width µs ISO text and lowercase uuid text sort like Postgres. */
function newerFirst(a: ProposalPosition, b: ProposalPosition): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  if (a.id !== b.id) return a.id < b.id ? 1 : -1
  return 0
}

/**
 * Merge per-kind keyset reads (each already `created_at DESC, id DESC`, each
 * fetched with `limit + 1`) into one page of at most `limit` rows. Generic over
 * the number of sources so a new proposal kind is one more array.
 */
export function mergeProposalStreams<R extends { position: ProposalPosition }>(
  sources: readonly (readonly R[])[],
  limit: number,
): MergedPage<R> {
  const merged = sources.flat().sort((a, b) => newerFirst(a.position, b.position))
  const hasMore = merged.length > limit
  const page = merged.slice(0, limit)
  const last = page[page.length - 1]
  return { page, hasMore, next: hasMore && last !== undefined ? last.position : undefined }
}

type Tagged =
  | { kind: 'edge'; position: ProposalPosition; record: ProposalRecord }
  | { kind: 'fact'; position: ProposalPosition; record: FactProposalRecord }

const tag =
  <K extends Tagged['kind']>(kind: K) =>
  <T>(row: KeyedProposal<T>) => ({ kind, position: row.position, record: row.record })

/** The db query for one source: `limit + 1` rows so the merge can see past the page. */
function sourceQuery(query: ProposalsPageQuery) {
  return { status: query.status, limit: query.limit + 1, after: query.after }
}

async function readBothKinds(
  tx: TenantTx,
  userId: string,
  query: ProposalsPageQuery,
): Promise<ProposalsPage> {
  const dbQuery = sourceQuery(query)
  const edges = (await listProposalsAfter(tx, dbQuery)).map(tag('edge'))
  const facts = (await listFactProposalsAfter(tx, userId, dbQuery)).map(tag('fact'))
  const { page, hasMore, next } = mergeProposalStreams<Tagged>([edges, facts], query.limit)
  const proposals: ProposalRecord[] = []
  const factProposals: FactProposalRecord[] = []
  for (const row of page) {
    if (row.kind === 'edge') proposals.push(row.record)
    else factProposals.push(row.record)
  }
  const totals = {
    edge: await countProposals(tx, query.status),
    fact: await countFactProposals(tx, userId, query.status),
  }
  return { proposals, factProposals, totals, hasMore, next }
}

/**
 * One page of the tenant's edge AND fact proposals in the merged
 * `created_at DESC, id DESC` order, at most `query.limit` rows across both
 * kinds, resuming strictly after `query.after`. Runs under withTenant/RLS in a
 * read-only repeatable-read transaction.
 */
export function listProposalsPage(
  userId: string,
  query: ProposalsPageQuery,
): Promise<ProposalsPage> {
  return withTenant(userId, (tx) => readBothKinds(tx, userId, query), READ_ONLY_SNAPSHOT)
}

/**
 * One page of the tenant's EDGE proposals only (the REST list's shipped
 * scope), with the same keyset contract as {@link listProposalsPage}.
 */
export function listEdgeProposalsPage(
  userId: string,
  query: ProposalsPageQuery,
): Promise<EdgeProposalsPage> {
  return withTenant(
    userId,
    async (tx) => {
      const rows = await listProposalsAfter(tx, sourceQuery(query))
      const { page, hasMore, next } = mergeProposalStreams([rows], query.limit)
      return {
        proposals: page.map((row) => row.record),
        totals: { edge: await countProposals(tx, query.status) },
        hasMore,
        next,
      }
    },
    READ_ONLY_SNAPSHOT,
  )
}
