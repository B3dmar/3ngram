// SPDX-License-Identifier: Apache-2.0
// Consolidation-proposal APPLY layer (docs/concepts/memory-model.mdx
// append-and-supersede; docs/concepts/mcp-design.mdx: the accept side of review_proposals).
//
// SQL ONLY (hard rule 5): the read/reject layer lives in proposals-read.ts; the
// list-vs-write scope split and bounded defaults are core policy. This module
// owns the single APPLY transaction. Every statement runs inside withTenant():
// RLS scopes rows to the caller, so no query references user_id beyond the row
// values the FKs require.
//
// APPLY = materialize the proposal's typed edge into memory_edges, and FOR a
// supersedes/updates edge ALSO close the predecessor's bi-temporal validity
// (valid_to = now ONLY — content is NEVER touched, docs/concepts/memory-model.mdx), then mark the
// proposal status proposed -> applied + stamp decided_at. NEVER a hard delete
// or merge of a memory row (hard rule 1): closing validity is the only memory
// mutation, and it mirrors revise()'s supersede semantics.
//
// EDGE DIRECTION IS LOAD-BEARING (memory-edges.ts:10-13, search.ts:458-461): the
// proposal stores the edge as it was proposed (from_id -> to_id, edge_type), so
// APPLY inserts it verbatim. The single repo convention is that a supersedes/
// updates edge runs FROM the successor TO the predecessor, and supersession
// ranking keys on EXISTS(edge WHERE e.to_id = m.id AND e.edge_type IN
// ('supersedes', 'updates')) — i.e. the PREDECESSOR is to_id. So for a
// supersedes/updates edge the validity close targets to_id (the row being
// superseded/updated by from_id), matching reviseMemory (memory-revise.ts:200-204,
// which closes the predecessor = to_id).
// The append-only suite already proves the runtime role has no DELETE on
// memories / memory_edges.
//
// EPISODIC EXCLUSION (docs/concepts/memory-model.mdx "Consolidation is advisory"): `event`-type memories are
// excluded from auto-edge application — they may at most receive advisory
// `extends` proposals. So APPLY refuses to close validity for an event-type
// supersedes/updates proposal (typed EpisodicSupersessionError), preventing a
// malformed/legacy event+supersedes row from corrupting an episodic memory.
// The guard reads the LIVE memories.memory_type of BOTH endpoints inside the
// tx (Codex P1): consolidation_proposals.memory_type is denormalized with only
// an enum CHECK — no FK ties it to memories.memory_type — so a stale/wrong
// value must never be the thing standing between the close UPDATE and an
// episodic row. The denormalized value is still refused when it says `event`
// (a malformed row stays un-applied), but the memories rows are authoritative.
//
// IDEMPOTENCY / NO DOUBLE-APPLY: the proposal status guard is the gate. The
// status WHERE pins 'proposed', so a concurrent or repeated apply of the same
// proposal yields zero rows on the final UPDATE -> ProposalNotFoundError (the
// caller learns it was not open), never a second edge insert with a side effect.
//
// PRE-EXISTING EDGE = ALREADY SATISFIED (Codex WARNING): if the proposed edge
// already exists (e.g. a prior revise already linked successor -> predecessor),
// the proposal's whole intent is ALREADY satisfied. We detect this UP FRONT with
// a SELECT — BEFORE touching the predecessor or attempting an INSERT — and treat
// it as idempotent-success: flip the proposal proposed -> applied and return,
// WITHOUT closing validity or auditing (the prior write already did that;
// re-closing a dead predecessor would emit a duplicate `supersede` event). The
// up-front SELECT is load-bearing: a prior revise already superseded the
// predecessor (valid_to set) when it wrote that edge, so the validity-close
// UPDATE below would match ZERO live rows and wrongly raise
// PredecessorAlreadySupersededError. Worse, relying on insertEdge's unique
// violation to detect the duplicate POISONS the transaction (Postgres aborts the
// tx on the 23505; the subsequent flip UPDATE then errors 25P02), surfacing a
// generic handler failure instead of idempotent success. Detecting the edge
// first keeps the tx clean and routes idempotency and genuine-conflict down
// DISTINCT paths: idempotent = edge present; conflict = edge absent + dead
// predecessor. This avoids leaving the proposal stranded `proposed`.
//
// ALREADY-SUPERSEDED PREDECESSOR = CONFLICT (Codex WARNING): for a FRESH apply of
// a CLOSES_PREDECESSOR type (the proposed edge does NOT yet exist — checked first,
// above), the predecessor MUST be live. The validity-close UPDATE pins
// `valid_to IS NULL` and `.returning()`s the row; zero rows means the predecessor
// was already superseded by some other path WITHOUT the proposed edge, so we
// throw PredecessorAlreadySupersededError (rolling the tx back) BEFORE inserting
// the edge / writing the audit event / flipping status — no duplicate `supersede`
// event over a dead predecessor, mirroring reviseMemory (memory-revise.ts:191-193).
// This is a DISTINCT branch from the pre-existing-edge idempotent path above:
// idempotent = edge present; conflict = edge absent AND predecessor dead.
//
// STALE SUCCESSOR = CONFLICT: candidate generation only
// emits LIVE pairs at proposal time, but a proposal can sit queued while its
// from_id (the proposed SUCCESSOR) is itself superseded by a later revise.
// Applying it then would close the still-live predecessor and hang the
// supersedes edge FROM an already-closed memory — neither side of that
// knowledge stays live. So a FRESH CLOSES_PREDECESSOR apply (edge absent)
// requires from_id to be LIVE by the repo's one liveness definition
// (status = 'active' AND valid_to IS NULL — briefing-read.ts / search.ts);
// otherwise SuccessorNotLiveError is thrown BEFORE any write. The check rides
// the SAME endpoint read as the episodic guard (one query, no extra
// round-trip) but is ENFORCED only on the fresh path: on the idempotent
// pre-existing-edge path a dead from_id is fine — the prior write chain
// already handled it, so flipping to applied stays correct. The stale
// proposal is left `proposed` (NOT auto-rejected): the strict
// reviewProposalsOutputSchema union admits only list/rejected/applied, so a
// rejected-stale outcome cannot be surfaced without widening the contract,
// and a rejection write inside this tx would roll back with the throw anyway.
// The human rejects it via the existing reject path; the consolidator must
// re-propose against the live successor chain.
//
// COMMITMENT CARRY ON APPLY: a commitment is
// its OWN entity (FSM, due/surfacing state) riding a commitment-type memory.
// Closing the predecessor's validity here is the IDENTICAL close reviseMemory
// performs, and reviseMemory keeps the obligation aligned with the live memory
// via carryCommitment (memory-revise.ts) — without the equivalent, the apply
// path strands an open obligation invisibly: briefing/overdue inner-join
// commitments -> memories and filter valid_to IS NULL (briefing-read.ts), and
// resolveByMemoryId on the successor finds nothing. So, in the SAME tx, right
// after the live close succeeds: a live (open/waiting) row on the predecessor
// either MOVES to the successor (live commitment-type successor with no row of
// its own — carryCommitment's commitment->commitment case) or is transitioned
// to 'resolved' (successor non-commitment, or it already rides its own row —
// the dedupe case, where the successor's row carries the live obligation; the
//  Option A decision: explicitly close, never silently strand). The
// idempotent pre-existing-edge path deliberately does NOT touch commitments —
// a prior write (revise or apply) already handled the predecessor — and the
// conflict path throws before any write.
//
// Observability (hard rule 6): rationale is free text and is NEVER logged; this
// module logs nothing and callers log ids/enum states only.
import type { ActorKind, EdgeType } from '@3ngram/schema'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { insertEdge } from './memory-edges.js'
import { PredecessorAlreadySupersededError } from './memory-revise.js'
import { ProposalNotFoundError } from './proposals-read.js'
import {
  commitments,
  consolidationProposals,
  memories,
  memoryEdges,
  memoryEvents,
} from './schema/memory.js'

/** A consolidation-proposal row after a successful apply (status 'applied'). */
export interface AppliedProposalRow {
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
 * Thrown when accept targets a supersedes/updates proposal whose memory_type is
 * `event`. docs/concepts/memory-model.mdx "Consolidation is advisory" bars event-type memories from
 * auto-edge application; closing an episodic memory's validity is the corruption
 * class the ADR was written to prevent. A malformed/legacy event+supersedes row
 * must therefore be refused at accept, not silently applied. Names the proposal
 * id + memory_type only (never content — observability hard rule 6).
 */
export class EpisodicSupersessionError extends Error {
  readonly proposalId: string
  readonly memoryType: string
  constructor(proposalId: string, memoryType: string) {
    super(
      'event-type memories cannot be superseded/updated via a proposal (docs/concepts/memory-model.mdx "Consolidation is advisory")',
    )
    this.name = 'EpisodicSupersessionError'
    this.proposalId = proposalId
    this.memoryType = memoryType
  }
}

/**
 * Thrown when a FRESH supersedes/updates apply finds the proposed SUCCESSOR
 * (from_id) no longer live (missing, archived, or valid_to set) — the proposal
 * went stale between proposal time and accept (e.g. a later revise superseded
 * from_id itself). Applying anyway would close the still-live predecessor and
 * point the supersedes edge FROM a dead memory, leaving NO live row on either
 * side of that knowledge. The proposal stays `proposed`: it must be re-proposed
 * against the live successor chain (or rejected by the human via the existing
 * reject path) — it can never be applied as-is. Names ids only (hard rule 6).
 */
export class SuccessorNotLiveError extends Error {
  readonly proposalId: string
  readonly fromId: string
  constructor(proposalId: string, fromId: string) {
    super('proposed successor is no longer live; re-propose against the live successor chain')
    this.name = 'SuccessorNotLiveError'
    this.proposalId = proposalId
    this.fromId = fromId
  }
}

const APPLIED_PROPOSAL_COLUMNS = {
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

/** Edge types whose application closes the predecessor (to_id) validity. */
const CLOSES_PREDECESSOR = new Set(['supersedes', 'updates'])

/**
 * Apply an OPEN proposal inside the caller's tenant-scoped transaction. In ONE
 * tx: (1) if the proposed edge ALREADY exists, flip the proposal to `applied`
 * idempotently and return (no close / audit); otherwise (2) for a
 * supersedes/updates edge close the predecessor (to_id) bi-temporal validity
 * (valid_to = now, content untouched) and record a `supersede` audit event on it,
 * (3) INSERT the proposed typed edge (from_id -> to_id, edge_type), then (4) flip
 * the proposal status proposed -> applied stamping decided_at. All land or roll
 * back together (hard rule 3).
 *
 * Episodic exclusion (docs/concepts/memory-model.mdx "Consolidation is advisory"): a supersedes/updates proposal is REFUSED
 * before any write ({@link EpisodicSupersessionError}) when its denormalized
 * memory_type says `event` OR when the LIVE memories.memory_type of either
 * endpoint is `event` (read inside this tx — the denormalized column has no FK
 * to memories, so the live rows are authoritative). Event-type memories are
 * barred from auto-edge application, so closing an episodic memory's validity
 * is never legal here.
 *
 * The status guard is the no-double-apply gate: the leading SELECT pins
 * status = 'proposed' (RLS scopes it to the tenant), so a missing / not-owned /
 * already-decided proposal surfaces {@link ProposalNotFoundError} BEFORE any
 * edge insert — never a silent re-apply.
 *
 * `decidedAt` and `valid_to` use the DB clock (sql`now()`, the rejectProposal /
 * reviseMemory precedent) so the stamps match the row's own transaction time.
 *
 * `userId` scopes the rows the FKs require (RLS still binds the tenant); every
 * statement is additionally pinned to it, matching the reviseMemory precedent.
 *
 * Pre-existing edge (Codex WARNING): if the proposed edge already exists (detected
 * by an up-front SELECT, before any mutation), the proposal is treated as ALREADY
 * SATISFIED — flipped to `applied` idempotently (no validity close / audit), never
 * stranded `proposed` behind a 409, and the tx is never poisoned by a failed insert.
 *
 * Already-superseded predecessor (Codex WARNING): for a FRESH CLOSES_PREDECESSOR
 * apply (edge absent) whose predecessor (to_id) is already closed, throws {@link
 * PredecessorAlreadySupersededError} BEFORE inserting the edge / audit / flip (no
 * duplicate event). Distinct from the idempotent path: edge absent + dead predecessor.
 *
 * Commitment carry (Codex P1): when the closed predecessor rides a
 * live (open/waiting) commitment row, the obligation MOVES to a live
 * commitment-type successor without a row of its own, or is transitioned to
 * 'resolved' otherwise — never silently stranded on the closed predecessor.
 * See {@link carryOrResolvePredecessorCommitment} for the full branch matrix.
 *
 * Stale successor: a FRESH CLOSES_PREDECESSOR apply also
 * requires from_id (the proposed successor) to be LIVE (status 'active',
 * valid_to IS NULL) — read in the same endpoint query as the episodic guard.
 * A proposal whose successor was itself superseded while queued throws {@link
 * SuccessorNotLiveError} BEFORE any write and stays `proposed` (re-propose, or
 * reject via the existing reject path). The idempotent pre-existing-edge path
 * is exempt: the prior write chain already handled the dead successor.
 *
 * @throws {@link ProposalNotFoundError} no open proposal for the tenant.
 * @throws {@link EpisodicSupersessionError} event-type supersedes/updates proposal.
 * @throws {@link PredecessorAlreadySupersededError} fresh edge over a dead predecessor.
 * @throws {@link SuccessorNotLiveError} fresh edge whose successor is no longer live.
 */
export async function applyProposal(
  tx: TenantTx,
  userId: string,
  proposalId: string,
  actorKind: ActorKind,
): Promise<AppliedProposalRow> {
  // Read the open proposal (RLS hides cross-tenant rows). Pin status='proposed'
  // so an already-decided / missing / not-owned id is one not-found mapping, and
  // no edge is inserted for a proposal that cannot be applied.
  const [open] = await tx
    .select({
      fromId: consolidationProposals.fromId,
      toId: consolidationProposals.toId,
      edgeType: consolidationProposals.edgeType,
      memoryType: consolidationProposals.memoryType,
    })
    .from(consolidationProposals)
    .where(
      and(
        eq(consolidationProposals.userId, userId),
        eq(consolidationProposals.id, proposalId),
        eq(consolidationProposals.status, 'proposed'),
      ),
    )
    .limit(1)
  if (open === undefined) throw new ProposalNotFoundError(proposalId)

  // docs/concepts/memory-model.mdx "Consolidation is advisory" episodic exclusion: refuse to close an event-type memory's
  // validity. A supersedes/updates proposal targeting an event-type pair is a
  // malformed/legacy row (the consolidator may at most emit advisory `extends`
  // for episodic) — reject BEFORE any write so nothing is materialized. The
  // LIVE memories.memory_type of both endpoints is authoritative (Codex P1):
  // the proposal's denormalized memory_type has no FK back to memories, so a
  // stale value must not gate the validity close.
  // The same read also reports whether from_id (the proposed successor) is
  // still LIVE — enforced further down, on the FRESH-apply path only.
  let successorLive = true
  if (CLOSES_PREDECESSOR.has(open.edgeType)) {
    successorLive = await assertNoEpisodicEndpoint(tx, userId, proposalId, open)
  }

  // Pre-existing edge (Codex WARNING): detect the proposed edge UP FRONT, before
  // touching the predecessor or inserting. If it already exists (e.g. a prior
  // revise linked successor -> predecessor), the proposal's whole intent is
  // already satisfied — treat it as idempotent success: flip to `applied` and
  // return WITHOUT closing validity / auditing (the prior write already did that;
  // re-closing a dead predecessor would emit a duplicate `supersede` event). This
  // SELECT must precede the predecessor close: a prior revise already superseded
  // the predecessor when it wrote that edge, so the close below would match ZERO
  // live rows and wrongly raise PredecessorAlreadySupersededError. Detecting the
  // edge first also keeps the tx clean — a failed INSERT (23505) would poison the
  // tx and turn the subsequent flip UPDATE into a generic handler failure.
  const [existingEdge] = await tx
    .select({ id: memoryEdges.fromId })
    .from(memoryEdges)
    .where(
      and(
        eq(memoryEdges.userId, userId),
        eq(memoryEdges.fromId, open.fromId),
        eq(memoryEdges.toId, open.toId),
        eq(memoryEdges.edgeType, open.edgeType),
      ),
    )
    .limit(1)
  if (existingEdge !== undefined) return flipApplied(tx, userId, proposalId)

  // No pre-existing edge: this is a fresh application. For a superseding/updating
  // edge, close the PREDECESSOR (to_id) validity FIRST — valid_to ONLY, content
  // never touched (docs/concepts/memory-model.mdx). The predecessor is to_id by the load-bearing edge
  // convention (memory-edges.ts, search.ts): a supersedes edge runs
  // successor(from_id) -> predecessor(to_id), and search penalizes the to_id row.
  // The isNull guard pins a LIVE predecessor; `.returning()` lets us detect zero
  // rows = predecessor already superseded by some other path.
  //
  // Already-superseded predecessor (Codex WARNING): the edge does NOT yet exist
  // (checked above), so a dead predecessor means another path closed it WITHOUT
  // the proposed edge — the genuine broken case. THROW before inserting the edge
  // or auditing (rolling the tx back) so we never emit a duplicate `supersede`
  // event over a dead predecessor — mirrors reviseMemory:191-193. This is a
  // DISTINCT path from the idempotent one above (edge present): here the edge is
  // absent and the predecessor is dead.
  //
  // Stale successor: the edge is absent, so this fresh
  // apply would close the predecessor and hang the supersedes edge FROM
  // from_id — which MUST therefore still be live (status='active', valid_to
  // IS NULL, read by assertNoEpisodicEndpoint above). A from_id superseded
  // while the proposal sat queued means applying would leave NO live side:
  // throw BEFORE any write. The proposal stays `proposed` (the strict output
  // union cannot express a rejected-stale outcome, and a rejection write
  // would roll back with this throw) — re-propose or reject manually.
  if (CLOSES_PREDECESSOR.has(open.edgeType)) {
    if (!successorLive) throw new SuccessorNotLiveError(proposalId, open.fromId)
    const closed = await tx
      .update(memories)
      .set({ validTo: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(memories.userId, userId), eq(memories.id, open.toId), isNull(memories.validTo)))
      .returning({ id: memories.id })
    if (closed.length === 0) {
      throw new PredecessorAlreadySupersededError(open.toId)
    }
    await tx.insert(memoryEvents).values({
      userId,
      memoryId: open.toId,
      eventKind: 'supersede',
      actorKind,
    })
    // The close above is the IDENTICAL close reviseMemory performs, so the
    // obligation riding the predecessor needs the carryCommitment equivalent
    // (Codex P1) — same tx, right after the live close succeeded.
    await carryOrResolvePredecessorCommitment(tx, userId, open.fromId, open.toId, actorKind)
  }

  // Materialize the proposed edge verbatim (from_id -> to_id). The pre-existing
  // edge was ruled out above, so this is always a fresh INSERT; insertEdge still
  // maps any race-window duplicate to a typed EdgeConflictError. The edgeType is a
  // CHECK-constrained enum value from the proposal row.
  await insertEdge(tx, {
    userId,
    fromId: open.fromId,
    toId: open.toId,
    edgeType: open.edgeType as EdgeType,
    createdBy: actorKind,
  })

  return flipApplied(tx, userId, proposalId)
}

/**
 * Keep the commitment obligation aligned with the LIVE memory after the apply
 * path closes the predecessor — the apply-side
 * equivalent of reviseMemory's carryCommitment, in the SAME tx. A commitment's
 * identity is the obligation, not the memory revision; stranding a live row on
 * the just-closed predecessor makes it invisible (briefing-read.ts inner-joins
 * commitments -> memories with valid_to IS NULL) and unresolvable via the
 * successor. Branches:
 *
 *   1. No LIVE (open/waiting — the exact briefing-read liveness filter) row on
 *      the predecessor -> nothing to carry; a resolved/expired row stays put on
 *      the closed predecessor as history (no obligation strands).
 *   2. Successor is a LIVE commitment-type memory with NO commitments row of
 *      its own -> MOVE the row (UPDATE memory_id only), mirroring
 *      carryCommitment's commitment->commitment case: FSM
 *      status/resolved_at/due/surfacing all survive on the live memory.
 *      ANY existing successor row (even terminal) blocks the move —
 *      commitments_memory_idx is UNIQUE (user_id, memory_id).
 *   3. Otherwise (non-commitment successor, or it already rides its own row —
 *      the dedupe case, where the successor's row carries the live obligation)
 *      -> transition the predecessor's row to 'resolved' (DB clock, the
 *      transitionCommitment pattern: status + resolved_at + updated_at, plus
 *  the 'resolve' audit event on the predecessor memory). The Option A
 *      decision: an obligation is explicitly closed, never silently stranded.
 *      open->resolved and waiting->resolved are both legal FSM transitions
 *      (COMMITMENT_TRANSITIONS), so the DB trigger backstop never fires here.
 */
async function carryOrResolvePredecessorCommitment(
  tx: TenantTx,
  userId: string,
  fromId: string,
  toId: string,
  actorKind: ActorKind,
): Promise<void> {
  const [obligation] = await tx
    .select({ id: commitments.id })
    .from(commitments)
    .where(
      and(
        eq(commitments.userId, userId),
        eq(commitments.memoryId, toId),
        inArray(commitments.status, ['open', 'waiting']),
      ),
    )
    .limit(1)
  if (obligation === undefined) return

  // MOVE requires a LIVE commitment-type successor (the close above touched
  // only to_id, but liveness/type are re-read rather than assumed)...
  const [liveCommitmentSuccessor] = await tx
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        eq(memories.id, fromId),
        eq(memories.memoryType, 'commitment'),
        isNull(memories.validTo),
      ),
    )
    .limit(1)
  if (liveCommitmentSuccessor !== undefined) {
    // ...AND no commitments row already riding it (ANY status: the UNIQUE
    // (user_id, memory_id) index would reject the move outright).
    const [successorRow] = await tx
      .select({ id: commitments.id })
      .from(commitments)
      .where(and(eq(commitments.userId, userId), eq(commitments.memoryId, fromId)))
      .limit(1)
    if (successorRow === undefined) {
      await tx
        .update(commitments)
        .set({ memoryId: fromId, updatedAt: sql`now()` })
        .where(and(eq(commitments.userId, userId), eq(commitments.id, obligation.id)))
      return
    }
  }

  // Resolve branch (Option A): explicit close on the predecessor's row,
  // mirroring transitionCommitment's resolved-target stamps + audit event.
  //
  // TOCTOU guard (same defect class): the liveness SELECT
  // above reads a snapshot — the background sweep (sweepCommitments) can flip
  // the row to 'expired' before this UPDATE. The liveness predicate on the
  // UPDATE is load-bearing: without it, the UPDATE would attempt
  // expired->resolved, the FSM trigger backstop would reject it, and the whole
  // apply tx would abort. Losing the race means zero rows updated and no
  // 'resolve' audit event (terminal rows stay untouched, no event without a
  // transition).
  const resolved = await tx
    .update(commitments)
    .set({ status: 'resolved', resolvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(commitments.userId, userId),
        eq(commitments.id, obligation.id),
        inArray(commitments.status, ['open', 'waiting']),
      ),
    )
    .returning({ id: commitments.id })
  if (resolved.length === 0) return
  await tx.insert(memoryEvents).values({
    userId,
    memoryId: toId,
    eventKind: 'resolve',
    actorKind,
  })
}

/**
 * Refuse a CLOSES_PREDECESSOR apply that touches an episodic memory (docs/concepts/memory-model.mdx
 * §3). Two layers: (1) the proposal's denormalized memory_type saying `event`
 * marks the row malformed — refuse cheaply without another read; (2) the LIVE
 * memories.memory_type of BOTH endpoints, read inside the same tx (RLS-scoped,
 * pinned to userId). Layer 2 is the authoritative one (Codex P1): the
 * denormalized column has only an enum CHECK — no FK/consistency tie to
 * memories.memory_type — so a stale `fact` value there must never let the
 * validity-close UPDATE land on an event row.
 *
 * The SAME endpoint read also reports whether from_id (the proposed successor)
 * is still LIVE — the repo's one liveness definition (briefing-read.ts,
 * search.ts): status = 'active' AND valid_to IS NULL; a missing row is not
 * live. Returned, NOT thrown, because the guard only binds on the FRESH-apply
 * path (edge absent): on the idempotent pre-existing-edge path a dead from_id
 * is fine — the prior write chain already handled it. Folding the read in here
 * keeps it one query (stale-successor finding).
 *
 * @returns whether from_id is live (the caller throws
 * {@link SuccessorNotLiveError} on the fresh path when it is not).
 * @throws {@link EpisodicSupersessionError} either endpoint (or the proposal
 * row itself) is event-typed.
 */
async function assertNoEpisodicEndpoint(
  tx: TenantTx,
  userId: string,
  proposalId: string,
  open: { fromId: string; toId: string; memoryType: string },
): Promise<boolean> {
  if (open.memoryType === 'event') {
    throw new EpisodicSupersessionError(proposalId, open.memoryType)
  }
  const endpoints = await tx
    .select({
      id: memories.id,
      memoryType: memories.memoryType,
      status: memories.status,
      validTo: memories.validTo,
    })
    .from(memories)
    .where(and(eq(memories.userId, userId), inArray(memories.id, [open.fromId, open.toId])))
  for (const endpoint of endpoints) {
    if (endpoint.memoryType === 'event') {
      throw new EpisodicSupersessionError(proposalId, endpoint.memoryType)
    }
  }
  const successor = endpoints.find((endpoint) => endpoint.id === open.fromId)
  return successor !== undefined && successor.status === 'active' && successor.validTo === null
}

/**
 * Flip an open proposal proposed -> applied, re-pinning status='proposed' so a
 * concurrent apply that won the race loses here (zero rows) -> not-found, never a
 * double stamp. decided_at uses the DB clock. Shared by the normal apply path and
 * the pre-existing-edge idempotent path.
 *
 * @throws {@link ProposalNotFoundError} the proposal was decided concurrently.
 */
async function flipApplied(
  tx: TenantTx,
  userId: string,
  proposalId: string,
): Promise<AppliedProposalRow> {
  const [applied] = await tx
    .update(consolidationProposals)
    .set({ status: 'applied', decidedAt: sql`now()` })
    .where(
      and(
        eq(consolidationProposals.userId, userId),
        eq(consolidationProposals.id, proposalId),
        eq(consolidationProposals.status, 'proposed'),
      ),
    )
    .returning(APPLIED_PROPOSAL_COLUMNS)
  if (applied === undefined) throw new ProposalNotFoundError(proposalId)
  return applied
}
