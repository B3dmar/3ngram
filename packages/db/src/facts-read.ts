// SPDX-License-Identifier: Apache-2.0
// Bi-temporal facts read layer (Phase 1B, slice 2: get_facts + as_of).
//
// This module owns the SQL for READING facts only. Business policy (defaults,
// param shaping, response transport) belongs to packages/core (read/facts.ts)
// per the layering rule — keep this at the query layer. TENANT ISOLATION IS
// TWO-LAYER (defense in depth): every query runs inside withTenant(), where RLS
// scopes rows to the caller, AND carries an explicit caller-bound
// `facts.user_id = userId` predicate (the same userId the caller passed into
// withTenant(), search.ts precedent). The predicate is a no-op while RLS
// functions — isolation never rests on a single mechanism.
//
// THE TWO TEMPORAL AXES (docs/concepts/data-model.mdx, docs/concepts/memory-model.mdx append-and-supersede). The
// facts table is append-only — a fact is never updated or deleted, only closed
// (valid_to set) and a successor row appended. Two independent clocks describe
// every row, and this API lets a caller travel along either or both:
//
//   VALID TIME (valid_from .. valid_to): the window during which the fact was
//   TRUE IN THE WORLD. A current ("live") fact has valid_to IS NULL. Asking
//   "what was true at instant T" is the validAt axis:
//       valid_from <= T AND (valid_to IS NULL OR valid_to > T)
//
//   TRANSACTION TIME (recorded_at): the instant we LEARNED the fact. Because
//   rows are append-only, recorded_at alone captures the knowledge axis (there
//   is no deletion clock). Asking "what did we KNOW at instant T" is the
//   asKnownAt axis:
//       recorded_at <= T
//
// The classic bi-temporal case: a fact recorded LATE (valid_from in the past,
// recorded_at = now) is true-in-the-past but was-not-yet-known. Combining both
// axes answers "what we believed was true at X, as of what we knew at Y"
// (true-at-X-as-known-at-Y). This surface is the template for the memories
// as_of read that lands later.
//
// Content discipline (hard rule 6): subject/predicate/value are content-
// adjacent and are NEVER logged here; callers log lengths/ids only.
import { and, asc, desc, eq, gt, isNull, lte, or, type SQL } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { facts } from './schema/memory.js'

/** One fact row, typed from the bi-temporal facts table. */
export interface FactRow {
  id: string
  memoryId: string
  subject: string
  predicate: string
  value: string
  confidence: number | null
  validFrom: Date
  validTo: Date | null
  recordedAt: Date
}

/**
 * Point-in-time coordinates for a bi-temporal read. Both axes are independent
 * and optional; supply one, the other, or both.
 *
 * @property validAt    VALID-TIME instant — return the fact that was TRUE at
 *   this moment (valid_from <= validAt AND (valid_to IS NULL OR valid_to >
 *   validAt)). Omit to use the current-row default (valid_to IS NULL).
 * @property asKnownAt  TRANSACTION-TIME instant — return only facts we had
 *   RECORDED by this moment (recorded_at <= asKnownAt). Models "as of what we
 *   knew at Y": a fact recorded after this instant is invisible, even if its
 *   valid-time window covers validAt. Omit to consider all recorded rows.
 *
 *   LIMITATION (single transaction-time clock): the memory model's append-and-supersede (docs/concepts/memory-model.mdx)
 *   model records only ONE clock per row, recorded_at, capturing the row's
 *   INSERT instant. It does NOT track when valid_to is later set at supersession
 *   — there is no second clock for that mutation. So asKnownAt alone is
 *   transaction-time-lossy: a row closed AFTER the asKnownAt instant still
 *   appears closed, because the close is invisible to the recorded_at filter.
 *   For the most faithful as-known-at reads, pair asKnownAt WITH validAt: the
 *   valid-time predicate reconstructs which row was live at the target instant,
 *   compensating for the untracked closure.
 */
export interface AsOf {
  validAt?: Date
  asKnownAt?: Date
}

/**
 * Filters for {@link getFacts}. subject/predicate narrow the key space, both
 * optional; with neither, the call lists facts across all keys. `limit` BOUNDS
 * the row count — list mode would otherwise return every current fact, so the
 * caller (packages/core) always supplies a bounded default (no-firehose). Omitted
 * here means no LIMIT clause, but core never omits it.
 */
export interface FactsQuery {
  subject?: string
  predicate?: string
  asOf?: AsOf
  limit?: number
}

/**
 * VALID-TIME predicate. With no `validAt`, selects the CURRENT ROW (the live
 * assertion: valid_to IS NULL). With a `validAt`, selects the row whose valid
 * window contains that instant — what was TRUE at validAt — which is the live
 * row for any instant inside an open-ended (valid_to IS NULL) window.
 *
 * Exported for unit testing the window logic in isolation.
 */
export function validTimePredicate(validAt?: Date): SQL {
  if (validAt === undefined) {
    // Current-row default: the single live fact per (subject, predicate).
    return isNull(facts.validTo)
  }
  // What was true AT validAt: window is [valid_from, valid_to), half-open so a
  // successor whose valid_from == the predecessor's valid_to does not
  // double-count the boundary instant.
  return and(
    lte(facts.validFrom, validAt),
    or(isNull(facts.validTo), gt(facts.validTo, validAt)),
  ) as SQL
}

/**
 * TRANSACTION-TIME predicate. With no `asKnownAt`, imposes no constraint (all
 * recorded rows are visible). With an `asKnownAt`, restricts to rows we had
 * already recorded by that instant (recorded_at <= asKnownAt) — what we KNEW
 * at asKnownAt. Returns `undefined` when there is nothing to constrain so the
 * caller can omit the clause entirely.
 *
 * Exported for unit testing the window logic in isolation.
 */
export function transactionTimePredicate(asKnownAt?: Date): SQL | undefined {
  if (asKnownAt === undefined) return undefined
  return lte(facts.recordedAt, asKnownAt)
}

/**
 * Read facts for the current tenant, bi-temporally.
 *
 * DEFAULT (no asOf): returns the CURRENT ROW per matching (subject, predicate)
 * — the live fact, valid_to IS NULL. In list mode (no subject/predicate filter)
 * results are ordered by recency (recorded_at DESC), matching search.ts's
 * recency leg — orchestrator decision, slice 2.
 *
 * TIME-TRAVEL (asOf set): travels along either temporal axis or both —
 *   - validAt only:   what was TRUE at that instant (valid-time)
 *   - asKnownAt only: what we KNEW by that instant (transaction-time)
 *   - both:           true-at-validAt as-known-at-asKnownAt (the bi-temporal
 *                     case — e.g. a late-recorded correction is invisible until
 *                     asKnownAt reaches its recorded_at)
 *
 * Empty result is empty, never a throw. Runs inside withTenant(): RLS plus the
 * caller-bound `facts.user_id = userId` predicate enforce tenant isolation on
 * every path (module header).
 *
 * Primitive inputs (subject/predicate strings, asOf Dates) are validated at
 * this boundary by the caller in packages/core: there is NO facts-query Zod
 * input in packages/schema yet, and hard rule 2 forbids adding new schemas to
 * core, so core validates primitives inline and documents the gap. This helper
 * trusts its typed arguments.
 *
 * @param tx      Tenant-scoped transaction from withTenant().
 * @param userId  The authenticated tenant (the withTenant userId) — bound as an
 *                explicit predicate alongside RLS.
 * @param query   Optional subject/predicate filters and as_of coordinates.
 */
export async function getFacts(
  tx: TenantTx,
  userId: string,
  query: FactsQuery = {},
): Promise<FactRow[]> {
  const conditions: SQL[] = [eq(facts.userId, userId), validTimePredicate(query.asOf?.validAt)]

  const txTime = transactionTimePredicate(query.asOf?.asKnownAt)
  if (txTime !== undefined) conditions.push(txTime)
  if (query.subject !== undefined) conditions.push(eq(facts.subject, query.subject))
  if (query.predicate !== undefined) conditions.push(eq(facts.predicate, query.predicate))

  const ordered = tx
    .select({
      id: facts.id,
      memoryId: facts.memoryId,
      subject: facts.subject,
      predicate: facts.predicate,
      value: facts.value,
      confidence: facts.confidence,
      validFrom: facts.validFrom,
      validTo: facts.validTo,
      recordedAt: facts.recordedAt,
    })
    .from(facts)
    .where(and(...conditions))
    // List-mode recency axis: recorded_at DESC (consistent with search.ts), id
    // as a stable tiebreaker so equal-recency rows order deterministically.
    .orderBy(desc(facts.recordedAt), asc(facts.id))

  // Bound the window when the caller supplies a limit (core always does, so list
  // mode never returns the whole table — no-firehose). Applied AFTER ordering so
  // it is the N most-recent rows.
  return query.limit === undefined ? ordered : ordered.limit(query.limit)
}
