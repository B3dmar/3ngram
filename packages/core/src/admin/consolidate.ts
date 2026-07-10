// SPDX-License-Identifier: Apache-2.0
// Background consolidation policy. This is the
// BUSINESS LOGIC the apps/worker BullMQ harness invokes — the harness only
// schedules/invokes/shuts down (hard rule 5); everything below is core.
//
// ADVISORY ONLY (docs/concepts/memory-model.mdx "Consolidation is advisory", hard rule 1): the consolidator NEVER mutates or
// destroys memory rows. It scans a tenant's memories, finds near-duplicate pairs
// by cosine similarity (reusing the db vector helper — no cosine reimplemented),
// applies the per-type CONSOLIDATION_POLICIES gate, and INSERTs `proposed`
// suggestion rows for a human to review (F3). Auto-apply does not exist here.
//
// KEY INVARIANT:
// episodic `event` memories are textually near-identical by construction and
// were a large share of destructive merges. They may receive ADVISORY 'extends'
// proposals ONLY — never supersedes/updates/derives. CONSOLIDATION_POLICIES
// encodes this at the type level; this module re-applies it at runtime by
// choosing the edge type per the pair's memory type.
//
// Observability (hard rule 6): ids/types/counts/scores only — NEVER memory
// content or the free-text rationale.
import {
  findSimilarPairs as findSimilarPairsDb,
  insertProposals,
  listTenantIds,
  type ProposalWrite,
  type SimilarPair,
  withTenant,
} from '@3ngram/db'
import {
  CONSOLIDATION_POLICIES,
  type EdgeType,
  type MemoryType,
  memoryTypeSchema,
} from '@3ngram/schema'

/**
 * The minimum cosine similarity a pair must clear to be PROPOSED. Conservative:
 * a high bar keeps the human review queue precise (advisory, not auto-applied).
 * A policy constant, not a magic number — tunable as the ratchet matures.
 */
export const DEFAULT_CONSOLIDATION_SIMILARITY = 0.92

/** Default cap on candidate pairs scanned per tenant per run (no-firehose). */
export const DEFAULT_CONSOLIDATION_LIMIT = 200

/**
 * The data seam the consolidator needs, injectable so the policy is unit-tested
 * against a fake repo with NO database (the worker test stubs this). The default
 * implementation ({@link dbConsolidateRepo}) wraps the @3ngram/db helpers in
 * withTenant().
 */
export interface ConsolidateRepo {
  /** Every tenant's user id (the per-tenant fan-out seed). */
  listTenantIds(): Promise<string[]>
  /** Near-duplicate pairs for one tenant, >= minSimilarity, bounded by limit. */
  findSimilarPairs(userId: string, minSimilarity: number, limit: number): Promise<SimilarPair[]>
  /** INSERT advisory proposals for one tenant; returns the count of NEW rows. */
  insertProposals(userId: string, proposals: ProposalWrite[]): Promise<number>
}

/** Tunables for one consolidation run. */
export interface ConsolidateOptions {
  minSimilarity?: number
  limitPerTenant?: number
}

/** Per-run outcome, content-free — safe to log. */
export interface ConsolidateResult {
  tenantsScanned: number
  pairsConsidered: number
  proposalsInserted: number
}

/**
 * Choose the advisory edge type to propose for a candidate pair, given both
 * endpoints' memory types. Returns `undefined` when no proposal should be made.
 *
 * The pair's effective policy is the INTERSECTION of both endpoints' policies:
 * an edge type is proposable only if BOTH types admit it. This upholds the S1
 * invariant transitively — if EITHER side is `event`, the only common edge is
 * 'extends' (event's sole proposable edge), so an event pair can never receive
 * supersedes/updates/derives. We prefer the WEAKEST admissible advisory edge
 * ('extends') so the suggestion is maximally conservative: a human upgrades it
 * on accept (F3), the worker never proposes a destructive-looking edge.
 */
export function chooseProposedEdge(fromType: MemoryType, toType: MemoryType): EdgeType | undefined {
  const fromEdges: readonly EdgeType[] = CONSOLIDATION_POLICIES[fromType].proposableEdges
  const toEdges: readonly EdgeType[] = CONSOLIDATION_POLICIES[toType].proposableEdges
  const common = fromEdges.filter((edge) => toEdges.includes(edge))
  if (common.length === 0) return undefined
  // Conservative preference order: advisory 'extends' first (the only edge an
  // event pair admits and the least destructive-looking), then the rest.
  return common.includes('extends') ? 'extends' : common[0]
}

/** Map a db SimilarPair to a proposal row, or undefined if no edge is admissible. */
function pairToProposal(userId: string, pair: SimilarPair): ProposalWrite | undefined {
  // The db column is a free text type; narrow it back to the schema enum at this
  // boundary (the single validation boundary lives in @3ngram/schema, hard rule
  // 2). An unknown type is skipped rather than crashing the whole run.
  const fromType = memoryTypeSchema.safeParse(pair.fromType)
  const toType = memoryTypeSchema.safeParse(pair.toType)
  if (!fromType.success || !toType.success) return undefined
  const edgeType = chooseProposedEdge(fromType.data, toType.data)
  if (edgeType === undefined) return undefined
  return {
    userId,
    fromId: pair.fromId,
    toId: pair.toId,
    edgeType,
    // The proposal is ABOUT the pair; record the from-side type for the
    // per-type precision audit (the column is the proposal's own subject type).
    memoryType: fromType.data,
    similarity: pair.similarity,
    rationale: `cosine ${pair.similarity.toFixed(3)} >= ${edgeType} threshold`,
  }
}

/**
 * Run one consolidation pass across all tenants. For each tenant:
 * find near-duplicate pairs, map each to an advisory proposal under the per-type
 * policy gate, and INSERT the proposals. Returns content-free counts.
 *
 * NEVER mutates memories (advisory-only, docs/concepts/memory-model.mdx "Consolidation is advisory"). The worker schedules this;
 * it owns no scheduling itself. A per-tenant failure is NOT swallowed silently —
 * it propagates so the BullMQ job is marked failed and retried (the harness owns
 * retry policy), rather than reporting a falsely-green run.
 */
export async function consolidate(
  repo: ConsolidateRepo,
  options: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const minSimilarity = options.minSimilarity ?? DEFAULT_CONSOLIDATION_SIMILARITY
  const limitPerTenant = options.limitPerTenant ?? DEFAULT_CONSOLIDATION_LIMIT
  const tenants = await repo.listTenantIds()
  let pairsConsidered = 0
  let proposalsInserted = 0
  for (const userId of tenants) {
    const pairs = await repo.findSimilarPairs(userId, minSimilarity, limitPerTenant)
    pairsConsidered += pairs.length
    const proposals = pairs
      .map((pair) => pairToProposal(userId, pair))
      .filter((p): p is ProposalWrite => p !== undefined)
    if (proposals.length > 0) {
      proposalsInserted += await repo.insertProposals(userId, proposals)
    }
  }
  return { tenantsScanned: tenants.length, pairsConsidered, proposalsInserted }
}

/**
 * The production {@link ConsolidateRepo}: the @3ngram/db helpers wrapped in
 * withTenant() (hard rule 3 — RLS scopes every per-tenant read/write). Tenant
 * enumeration is the one pre-tenant read (listTenantIds, system table).
 */
export const dbConsolidateRepo: ConsolidateRepo = {
  listTenantIds,
  findSimilarPairs: (userId, minSimilarity, limit) =>
    withTenant(userId, (tx) => findSimilarPairsDb(tx, minSimilarity, limit)),
  insertProposals: (userId, proposals) =>
    withTenant(userId, (tx) => insertProposals(tx, proposals)),
}
