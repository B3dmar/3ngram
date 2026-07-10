// SPDX-License-Identifier: Apache-2.0
// Consolidation-proposal WRITE layer (workstream F1 — the
// background consolidator's insert side; proposals-read.ts owns list/reject).
//
// SQL ONLY (hard rule 5): the consolidator's POLICY (per-tenant scan, pairwise
// similarity, the CONSOLIDATION_POLICIES gate, the S1 event-only-`extends`
// invariant) lives in packages/core/src/admin/consolidate.ts. This module is the
// thin INSERT helper it calls, inside withTenant() (hard rule 3) so RLS scopes
// every row to the caller — no query references user_id beyond the value column
// the composite FK requires.
//
// ADVISORY ONLY (docs/concepts/memory-model.mdx "Consolidation is advisory", hard rule 1): a proposal is a SUGGESTION row, never
// a mutation of memory data. The runtime role has INSERT on consolidation_proposals
// and NO DELETE; this module only ever INSERTs `status = 'proposed'` rows and
// never touches the memories table. Applying a proposal (materializing the edge)
// is F3 — a human-reviewed step that does not exist here.
//
// Idempotency: the `proposals_open_idx` partial unique index admits at most one
// OPEN proposal per (user_id, from_id, to_id, edge_type). A repeated scan that
// re-proposes the same candidate edge would violate it, so inserts use
// onConflictDoNothing on that index — a re-run is a no-op for already-open
// candidates rather than a crash, and the returned count reflects only NEW rows.
//
// Observability (hard rule 6): rationale is free text and is NEVER logged here;
// this module logs nothing and callers log ids/enum states/counts only.
import type { EdgeType, MemoryType } from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { consolidationProposals } from './schema/memory.js'

/**
 * One advisory consolidation proposal to INSERT. `similarity` is the measured
 * cosine score in [0, 1]; `rationale` is an optional short, content-free note
 * (never logged). `status` is fixed to 'proposed' by {@link insertProposals} —
 * callers supply only the candidate edge — so an applied/rejected row can never
 * be created on the write path.
 */
export interface ProposalWrite {
  userId: string
  fromId: string
  toId: string
  edgeType: EdgeType
  memoryType: MemoryType
  similarity: number
  rationale?: string | undefined
}

/**
 * INSERT advisory consolidation proposals for the tenant, all in status
 * 'proposed'. Returns the number of NEW rows written: a candidate edge that
 * already has an OPEN proposal is skipped via onConflictDoNothing on
 * `proposals_open_idx` (idempotent re-scan), so the count is new-only. An empty
 * input is a no-op returning 0 (never a malformed empty INSERT).
 *
 * Runs inside the caller's withTenant() transaction (RLS scopes the rows). NEVER
 * touches the memories table — advisory-only (docs/concepts/memory-model.mdx "Consolidation is advisory", hard rule 1).
 */
export async function insertProposals(tx: TenantTx, proposals: ProposalWrite[]): Promise<number> {
  if (proposals.length === 0) return 0
  const rows = await tx
    .insert(consolidationProposals)
    .values(
      proposals.map((p) => ({
        userId: p.userId,
        fromId: p.fromId,
        toId: p.toId,
        edgeType: p.edgeType,
        memoryType: p.memoryType,
        similarity: p.similarity,
        rationale: p.rationale ?? null,
        status: 'proposed' as const,
      })),
    )
    // Skip a candidate edge that already has an OPEN proposal: the conflict
    // target MUST mirror the partial `proposals_open_idx` exactly (its columns
    // AND its WHERE predicate), so the re-scan is a clean no-op rather than a
    // unique-violation crash. A non-partial target would not match the index.
    .onConflictDoNothing({
      target: [
        consolidationProposals.userId,
        consolidationProposals.fromId,
        consolidationProposals.toId,
        consolidationProposals.edgeType,
      ],
      where: sql`status = 'proposed'`,
    })
    .returning({ id: consolidationProposals.id })
  return rows.length
}
