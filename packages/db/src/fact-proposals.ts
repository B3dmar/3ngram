// SPDX-License-Identifier: Apache-2.0
// Fact-proposal review layer: insert (the extractor's side), list, and reject.
// Applying a proposal — the step that writes a real fact — lives in
// fact-proposals-apply.ts, mirroring the proposals-write/read/apply split.
//
// SQL ONLY (hard rule 5): the extraction POLICY (what to propose, at what
// confidence) belongs to packages/core; this module is the thin persistence
// helper it calls inside withTenant() (hard rule 3), so RLS scopes every row
// and no query references user_id beyond the value the composite FK requires.
//
// STAGING, NOT TRUTH: a proposal is a candidate awaiting human review, never a
// queryable fact. Nothing here touches the `facts` table (that is the apply
// step) and nothing here mutates memory data — the runtime role has INSERT,
// SELECT and UPDATE on fact_proposals and NO DELETE, so a decision flips a
// status and the row survives as its own audit trail (hard rule 1).
//
// Observability (hard rule 6): subject/predicate/value and rationale are memory
// content and are NEVER logged here; this module logs nothing, and callers log
// ids, enum states and counts only.
import type { MemoryType } from '@3ngram/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { ProposalNotFoundError } from './proposals-read.js'
import { factProposals } from './schema/memory.js'

/**
 * One extracted fact awaiting review. `status` is fixed to 'proposed' by
 * {@link insertFactProposals} — callers supply only the candidate — so an
 * already-decided row can never be created on the write path.
 *
 * `validFrom`/`validTo` are OPTIONAL because an extractor often cannot date a
 * claim; a `validTo` without a `validFrom` is rejected by the table's CHECK.
 */
export interface FactProposalWrite {
  userId: string
  memoryId: string
  subject: string
  predicate: string
  value: string
  memoryType: MemoryType
  confidence?: number | undefined
  validFrom?: Date | undefined
  validTo?: Date | undefined
  rationale?: string | undefined
}

/** A fact proposal as returned to a reviewer. */
export interface FactProposalRow {
  id: string
  memoryId: string
  subject: string
  predicate: string
  value: string
  memoryType: string
  confidence: number | null
  validFrom: Date | null
  validTo: Date | null
  rationale: string | null
  status: string
  decidedAt: Date | null
  createdAt: Date
}

/** Shared projection so list/reject/apply return the identical row shape. */
export const FACT_PROPOSAL_COLUMNS = {
  id: factProposals.id,
  memoryId: factProposals.memoryId,
  subject: factProposals.subject,
  predicate: factProposals.predicate,
  value: factProposals.value,
  memoryType: factProposals.memoryType,
  confidence: factProposals.confidence,
  validFrom: factProposals.validFrom,
  validTo: factProposals.validTo,
  rationale: factProposals.rationale,
  status: factProposals.status,
  decidedAt: factProposals.decidedAt,
  createdAt: factProposals.createdAt,
} as const

/**
 * INSERT candidate facts for the tenant, all in status 'proposed'. Returns the
 * number of NEW rows: a triple that already has an OPEN proposal is skipped via
 * onConflictDoNothing, so re-running an extractor over the same memory is a
 * clean no-op rather than a unique-violation crash, and the count is new-only.
 * An empty input is a no-op returning 0 (never a malformed empty INSERT).
 *
 * CONFLICT TARGET: it must byte-mirror the partial `fact_proposals_open_idx` —
 * its columns, its `md5(value)` EXPRESSION, and its WHERE predicate. Postgres
 * matches a partial expression index by INFERENCE, so anything less specific
 * matches no index and the statement fails outright. `value` is digested in the
 * index because it is unbounded text that would otherwise overflow btree's
 * tuple limit (migration 0031), so the target has to name the same expression
 * rather than the bare column.
 *
 * WHY A SQL TEMPLATE AND NOT THE BUILDER: drizzle's `onConflictDoNothing({
 * target })` builds the target with `escapeName(getColumnCasing(column))` — it
 * accepts COLUMNS ONLY, and handing it a sql expression throws on a missing
 * `.name` (pinned in test/fact-proposals.test.ts). An expression target is
 * therefore inexpressible through the typed API on the pinned version. The
 * alternative — a bare `ON CONFLICT DO NOTHING` with no target — would swallow
 * every future constraint silently instead of just the open-proposal one, which
 * is exactly the drift this key is supposed to make loud. Values stay BOUND
 * PARAMETERS (never interpolated), and this runs inside the caller's
 * withTenant() transaction like every other statement here (hard rule 3).
 *
 * The key deliberately omits memory_type, confidence and the validity window,
 * so two extractions of one triple collapse to a single open proposal and the
 * FIRST one's metadata wins — re-proposing with a better confidence is a no-op
 * until the open row is decided.
 */
export async function insertFactProposals(
  tx: TenantTx,
  proposals: readonly FactProposalWrite[],
): Promise<number> {
  if (proposals.length === 0) return 0
  const values = sql.join(
    proposals.map(
      (proposal) =>
        sql`(${proposal.userId}, ${proposal.memoryId}, ${proposal.subject}, ${proposal.predicate}, ${proposal.value}, ${proposal.memoryType}, ${proposal.confidence ?? null}, ${proposal.validFrom ?? null}, ${proposal.validTo ?? null}, ${proposal.rationale ?? null}, 'proposed')`,
    ),
    sql`, `,
  )
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO fact_proposals
      (user_id, memory_id, subject, predicate, value, memory_type, confidence, valid_from, valid_to, rationale, status)
    VALUES ${values}
    ON CONFLICT (user_id, memory_id, subject, predicate, md5(value)) WHERE status = 'proposed'
    DO NOTHING
    RETURNING id
  `)
  return inserted.rows.length
}

/**
 * Filters for {@link listFactProposals}. `status` narrows to one lifecycle
 * state; omit to list all. `limit` BOUNDS the window (no-firehose) — the caller
 * always supplies a bounded default.
 */
export interface FactProposalsQuery {
  status?: string
  limit?: number
}

/**
 * List the tenant's fact proposals, most-recent first. BOUNDED by `limit`
 * (the caller always supplies one). An empty result is empty, never a throw.
 */
export async function listFactProposals(
  tx: TenantTx,
  userId: string,
  query: FactProposalsQuery = {},
): Promise<FactProposalRow[]> {
  const ordered = tx
    .select(FACT_PROPOSAL_COLUMNS)
    .from(factProposals)
    .where(
      query.status === undefined
        ? eq(factProposals.userId, userId)
        : and(eq(factProposals.userId, userId), eq(factProposals.status, query.status)),
    )
    .orderBy(desc(factProposals.createdAt), desc(factProposals.id))
  return query.limit === undefined ? ordered : ordered.limit(query.limit)
}

/**
 * Reject an OPEN fact proposal: status proposed -> rejected, stamping
 * decided_at from the DB clock. An UPDATE, never a DELETE (append-only grant).
 *
 * The WHERE pins status = 'proposed', so an already-decided proposal yields
 * zero rows and raises {@link ProposalNotFoundError} rather than silently
 * no-op'ing — the same contract (and error type) as rejectProposal, because a
 * reviewer cannot tell the two proposal kinds apart from a failure either way.
 * RLS hides cross-tenant rows, so not-found and not-owned collapse to one
 * mapping by design.
 */
export async function rejectFactProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
): Promise<FactProposalRow> {
  const [row] = await tx
    .update(factProposals)
    .set({ status: 'rejected', decidedAt: sql`now()` })
    .where(
      and(
        eq(factProposals.userId, userId),
        eq(factProposals.id, proposalId),
        eq(factProposals.status, 'proposed'),
      ),
    )
    .returning(FACT_PROPOSAL_COLUMNS)
  if (row === undefined) throw new ProposalNotFoundError(proposalId)
  return row
}
