// SPDX-License-Identifier: Apache-2.0
// Fact-proposal ACCEPT: the one step that turns a reviewed candidate into a
// queryable fact. Split from fact-proposals.ts the way proposals-apply.ts is
// split from proposals-write/read — insert and reject never touch memory data,
// this does.
//
// One transaction (hard rule 3): the status flip and the facts INSERT land or
// roll back together, so a proposal can never read as 'applied' without the
// fact it promised, and a fact can never exist with its proposal still open.
//
// Append-only (hard rule 1): this INSERTs a fact and UPDATEs a status. It never
// deletes the proposal — the decided row IS the audit trail of who accepted
// what, and the runtime role has no DELETE here.
//
// Observability (hard rule 6): ids and enum states only; the triple itself is
// memory content and is never logged.
import { and, eq, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { FACT_PROPOSAL_COLUMNS, type FactProposalRow } from './fact-proposals.js'
import { insertFact } from './facts-write.js'
import { ProposalNotFoundError } from './proposals-read.js'
import { factProposals } from './schema/memory.js'

/** The applied proposal and the id of the fact it produced. */
export interface AppliedFactProposal {
  proposal: FactProposalRow
  factId: string
}

/**
 * Apply an OPEN fact proposal: flip it to 'applied' and write the fact it
 * proposed, in the caller's transaction.
 *
 * THE STATUS FLIP GOES FIRST, and its WHERE pins status = 'proposed'. That
 * UPDATE is the claim: whichever transaction wins it owns the transition, so a
 * concurrent double-apply finds zero rows and raises
 * {@link ProposalNotFoundError} instead of writing the fact twice. A
 * SELECT-then-write ordering would leave that race open under READ COMMITTED.
 * An already-rejected or already-applied proposal fails the same way — a
 * reviewer learns the decision did not take, never a silent no-op.
 *
 * VALIDITY: `valid_from` is nullable on a proposal (an extractor often cannot
 * date a claim) but NOT NULL on `facts`. A null falls through as `undefined` so
 * the column takes its own default of now() — the fact becomes true when it was
 * accepted, which is the only defensible reading when nobody could date it. The
 * table's CHECK already guarantees a `valid_to` cannot arrive without a
 * `valid_from`, so this cannot produce a window that ends before it begins.
 *
 * SUPERSEDED SOURCE MEMORY: applying against a memory that has since been
 * superseded is ALLOWED (reviewed decision). The composite FK guarantees the
 * source EXISTS and belongs to the tenant; it says nothing about liveness. A
 * fact carries its own bi-temporal validity and stands on its own once
 * asserted, and the reviewer accepted the claim, not the prose version. Facts
 * extracted from a memory that was revised while awaiting review would
 * otherwise be silently undecidable.
 */
export async function applyFactProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
): Promise<AppliedFactProposal> {
  const [proposal] = await tx
    .update(factProposals)
    .set({ status: 'applied', decidedAt: sql`now()` })
    .where(
      and(
        eq(factProposals.userId, userId),
        eq(factProposals.id, proposalId),
        eq(factProposals.status, 'proposed'),
      ),
    )
    .returning(FACT_PROPOSAL_COLUMNS)
  if (proposal === undefined) throw new ProposalNotFoundError(proposalId)

  const { id: factId } = await insertFact(tx, {
    userId,
    memoryId: proposal.memoryId,
    subject: proposal.subject,
    predicate: proposal.predicate,
    value: proposal.value,
    confidence: proposal.confidence ?? undefined,
    validFrom: proposal.validFrom ?? undefined,
    validTo: proposal.validTo ?? undefined,
  })
  return { proposal, factId }
}
