// SPDX-License-Identifier: Apache-2.0
// Consolidation-proposal read + reject layer (docs/concepts/mcp-design.mdx: review_proposals — the human-in-the-loop side of background
// consolidation, workstream F).
//
// SQL ONLY (hard rule 5): business policy — the read-vs-write scope split,
// bounded defaults, the not_implemented ACCEPT path — lives in packages/core.
// Every query runs inside withTenant(): RLS scopes rows to the caller
// (facts-read.ts precedent), so no query references user_id.
//
// APPEND-AND-SUPERSEDE (docs/concepts/memory-model.mdx) on proposals: the consolidation_proposals row
// is NOT memory data, but it is grant-protected like one — the runtime role has
// SELECT, INSERT, UPDATE and NO DELETE (provision-roles.sql; asserted by the
// append-only suite). REJECT is therefore an UPDATE of the status column
// (proposed -> rejected) plus the decided_at stamp, never a delete. The row
// stays for audit; re-proposal of the same candidate edge after rejection is
// permitted (the partial UNIQUE index constrains only the OPEN 'proposed' row).
//
// ACCEPT is intentionally NOT here: applying a proposal MEANS materializing the
// proposed edge into memory_edges + closing validity, which is the CONSOLIDATOR's
// job (workstream F) and does not exist yet. core review_proposals returns a
// typed not_implemented for accept; this module ships list + reject only.
//
// Observability (hard rule 6): rationale is free text and is NEVER logged; this
// module logs nothing and callers log ids/enum states only.
import { and, count, desc, eq, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { consolidationProposals } from './schema/memory.js'

/** One consolidation-proposal row, typed for the review surface. */
export interface ProposalRow {
  id: string
  fromId: string
  toId: string
  edgeType: string
  memoryType: string
  similarity: number
  rationale: string | null
  status: string
  decidedAt: Date | null
  createdAt: Date
}

/**
 * Thrown when reject targets a proposal that does not exist for the tenant, or
 * is no longer in the 'proposed' state (already applied/rejected — a no-op UPDATE
 * the caller must learn about). RLS hides cross-tenant rows, so not-found and
 * not-owned collapse to one mapping. Names the missing/conflicting id only.
 */
export class ProposalNotFoundError extends Error {
  readonly proposalId: string
  constructor(proposalId: string) {
    super(`no open proposal ${proposalId} for this tenant`)
    this.name = 'ProposalNotFoundError'
    this.proposalId = proposalId
  }
}

const PROPOSAL_COLUMNS = {
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

/**
 * Filters for {@link listProposals}. `status` narrows to one lifecycle state;
 * omit to list all. `limit` BOUNDS the window (no-firehose) — the caller always
 * supplies a bounded default.
 */
export interface ProposalsQuery {
  status?: string
  limit?: number
}

/**
 * List the tenant's consolidation proposals, most-recent first. BOUNDED by
 * `limit` (caller always supplies one). Empty result is empty, never a throw.
 */
export async function listProposals(
  tx: TenantTx,
  query: ProposalsQuery = {},
): Promise<ProposalRow[]> {
  const ordered = tx
    .select(PROPOSAL_COLUMNS)
    .from(consolidationProposals)
    .where(query.status === undefined ? undefined : eq(consolidationProposals.status, query.status))
    .orderBy(desc(consolidationProposals.createdAt), desc(consolidationProposals.id))
  const rows = await (query.limit === undefined ? ordered : ordered.limit(query.limit))
  return rows
}

/**
 * Reject an OPEN proposal: status proposed -> rejected, stamping decided_at
 * (now). An UPDATE, never a DELETE (append-only grant). The WHERE pins
 * status = 'proposed' so an already-decided proposal yields zero rows ->
 * {@link ProposalNotFoundError} (the caller learns it was not open), never a
 * silent no-op. `decidedAt` uses the DB clock (sql`now()`, the commitments.ts
 * resolvedAt precedent) so the stamp matches the row's own transaction time.
 */
export async function rejectProposal(tx: TenantTx, proposalId: string): Promise<ProposalRow> {
  const [row] = await tx
    .update(consolidationProposals)
    .set({ status: 'rejected', decidedAt: sql`now()` })
    .where(
      and(eq(consolidationProposals.id, proposalId), eq(consolidationProposals.status, 'proposed')),
    )
    .returning(PROPOSAL_COLUMNS)
  if (row === undefined) throw new ProposalNotFoundError(proposalId)
  return row
}

/** Count proposals by status for the tenant (used by describe_environment if needed). */
export async function countProposalsByStatus(tx: TenantTx): Promise<Record<string, number>> {
  const rows = await tx
    .select({ key: consolidationProposals.status, n: count() })
    .from(consolidationProposals)
    .groupBy(consolidationProposals.status)
  return Object.fromEntries(rows.map((r) => [r.key, r.n]))
}
