// SPDX-License-Identifier: Apache-2.0
// getFacts(): the bi-temporal fact read path.
//
// apps -> core -> db layering (hard rule 5): this is the policy surface for the
// read JTBD. It owns the DEFAULT limit and delegates the SQL to packages/db
// (facts-read.ts) inside a withTenant transaction (hard rule 3). Transports
// (REST/MCP) validate inputs via the single Zod boundary in packages/schema
// (factsQueryInputSchema) before calling core (hard rule 2).
//
// RETRIEVAL-SCOPE POLICY DECISION (issue #47): getFacts is deliberately NOT
// policy-enforced. The facts surface has NO scope axis — FactsQuery is
// subject/predicate/asOf/limit and the facts table carries no scope column —
// so a `default` scope has nothing to apply and `require` would brick the
// tool with no compliant call shape. If facts ever grow a scope axis, they
// adopt the shared helpers in ./retrieval-policy.ts with it.
//
// Observability (hard rule 6): subject/predicate/value are content-adjacent and
// are NEVER logged. This module logs nothing; callers honour the same rule.
import { type FactRow, type FactsQuery, getFacts as getFactsDb, withTenant } from '@3ngram/db'

export type { AsOf, FactRow, FactsQuery } from '@3ngram/db'

/**
 * Default list-mode window. List mode (no subject/predicate) would otherwise
 * return EVERY current fact — an unbounded read. Mirrors the MCP schema default
 * ({@link factsQueryInputSchema} DEFAULT_FACTS_LIMIT); duplicated here, not
 * imported, so a direct core caller (REST/SDK adopting the schema later) is
 * STILL bounded even if it bypasses the MCP default. No-firehose, fail-safe.
 */
const DEFAULT_FACTS_LIMIT = 50

/**
 * Read facts for `userId`, bi-temporally.
 *
 * DEFAULT (no asOf): the CURRENT live fact per matching (subject, predicate);
 * list mode (no filters) is ordered by recency and BOUNDED to `query.limit`
 * (default 50) so it never returns the whole table. Mirrors the old system's
 * get_facts surface: current fact for a (subject, predicate), or a recency list.
 *
 * TIME-TRAVEL (asOf): travel along VALID TIME (validAt — what was TRUE at an
 * instant), TRANSACTION TIME (asKnownAt — what we KNEW at an instant), or BOTH
 * (true-at-validAt as-known-at-asKnownAt). See packages/db facts-read.ts for the
 * axis semantics. NOTE (docs/concepts/memory-model.mdx single clock): asKnownAt alone is
 * transaction-time-lossy — recorded_at captures only a row's INSERT instant, not
 * when valid_to is later set at supersession, so a row closed AFTER asKnownAt
 * still appears closed; pair asKnownAt WITH validAt for the most faithful
 * as-known-at reads.
 *
 * Empty result is an empty array, never a throw. Runs inside withTenant(): RLS
 * enforces tenant isolation on every path.
 *
 * Input validation is the transport's responsibility (packages/schema
 * factsQueryInputSchema parsed by REST/MCP before calling core — hard rule 2).
 *
 * @param userId  Tenant whose RLS context the read runs under.
 * @param query   Optional subject/predicate filters and as_of coordinates.
 */
export async function getFacts(userId: string, query: FactsQuery = {}): Promise<FactRow[]> {
  // Always bound the read — list mode (no filters) must never return the whole
  // table (no-firehose). A caller that omits `limit` gets the default; the MCP
  // schema also defaults it, so this is the fail-safe for any direct core caller.
  const bounded = { ...query, limit: query.limit ?? DEFAULT_FACTS_LIMIT }
  return withTenant(userId, (tx) => getFactsDb(tx, userId, bounded))
}
