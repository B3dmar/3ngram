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
import { guardSessionMutation } from './credential-guard.js'
import { FACT_PROPOSAL_COLUMNS, type FactProposalRow } from './fact-proposals.js'
import { insertFact } from './facts-write.js'
import { ProposalNotFoundError } from './proposals-read.js'
import { factProposals, memories } from './schema/memory.js'

export class FactProposalSourceNotLiveError extends Error {
  constructor(readonly proposalId: string) {
    super(`fact proposal ${proposalId} source is no longer live`)
    this.name = 'FactProposalSourceNotLiveError'
  }
}

async function lockLiveSource(tx: TenantTx, userId: string, proposalId: string): Promise<void> {
  const [source] = await tx
    .select({ status: memories.status, validTo: memories.validTo })
    .from(memories)
    .innerJoin(factProposals, eq(factProposals.memoryId, memories.id))
    .where(
      and(
        eq(factProposals.userId, userId),
        eq(factProposals.id, proposalId),
        eq(factProposals.status, 'proposed'),
        eq(memories.userId, userId),
      ),
    )
    .for('share', { of: memories })
  if (source === undefined) throw new ProposalNotFoundError(proposalId)
  if (source.status !== 'active' || source.validTo !== null) {
    throw new FactProposalSourceNotLiveError(proposalId)
  }
}

/** The applied proposal and the id of the fact it produced. */
export interface AppliedFactProposal {
  proposal: FactProposalRow
  factId: string
}

/**
 * Apply an OPEN fact proposal: flip it to 'applied' and write the fact it
 * proposed, in the caller's transaction.
 *
 * After locking the live source, the status flip pins status = 'proposed'. That
 * UPDATE is the claim: whichever transaction wins it owns the transition, so a
 * concurrent double-apply finds zero rows and raises
 * {@link ProposalNotFoundError} instead of writing the fact twice.
 * The conditional UPDATE still decides the race under READ COMMITTED.
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
 * SOURCE LIVENESS: current fact reads hide retired parents (#369). Lock the
 * source before claiming the proposal or closing existing values, so a stale
 * proposal cannot replace current truth with an invisible fact. A refusal
 * leaves it open for rejection; never silently retarget it to a successor.
 * Lock order is account lifecycle, source memory, proposal, then fact key.
 */
export async function applyFactProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
): Promise<AppliedFactProposal> {
  await guardSessionMutation(tx, userId)
  await lockLiveSource(tx, userId, proposalId)
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
    sourceFactProposalId: proposalId,
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
