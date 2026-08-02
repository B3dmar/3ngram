// SPDX-License-Identifier: Apache-2.0
// Briefing read layer (docs/concepts/mcp-design.mdx `briefing`/`handoff`).
//
// This module owns the SQL for the ORIENTATION reads only — the bounded list
// queries that compose the structured briefing (open/waiting commitments with an
// overdue split, blockers, stale candidates, recent decisions, preferences).
// Business policy (the selector discipline, brief vs full mode, defaults) belongs
// to packages/core (read/briefing.ts) per the layering rule (hard rule 5) — keep
// this at the query layer. TENANT ISOLATION IS TWO-LAYER (defense in depth):
// every query runs inside withTenant(), where RLS scopes rows to the caller, AND
// every predicate carries an explicit caller-bound `memories.user_id = userId`
// condition (the same userId the caller passed into withTenant()). The predicate
// is a no-op while RLS functions and keeps the read caller-only if it ever does
// not — isolation never rests on a single mechanism.
//
// NO-FIREHOSE (docs/concepts/mcp-design.mdx, hard rule "output size discipline"): EVERY list is
// BOUNDED by an explicit LIMIT the caller supplies — there is no unbounded path.
// The selector (scope/project/all) narrows the row space; core enforces that a
// selector is present, this layer trusts its typed `BriefingSelector`.
//
// SNAPSHOT-SAFE EXACT COUNTS (Codex P2, comment 3372242177): each capped section
// returns BOTH its bounded item slice AND the EXACT total of matching rows in a
// SINGLE statement via the window aggregate `count(*) OVER()`. withTenant() runs
// at the default READ COMMITTED isolation (client.ts), where a SEPARATE COUNT(*)
// statement would take its OWN snapshot — a concurrent insert/revise/archive
// between the list read and the count read could make the count describe a
// DIFFERENT snapshot than the items, breaking the exact-count-plus-capped-slice
// contract. One statement == one snapshot, so list and count are provably
// consistent (and we halve the round-trips). The window count is evaluated over
// the FULL predicate BEFORE the LIMIT applies, so it is the true total, not the
// truncated slice length. Zero rows → total 0 (no row to read it from).
//
// INJECTED TIME (no datetime.now() in business logic): the overdue split and the
// stale window are computed against a `now` instant the CALLER passes in, never a
// wall-clock read inside the query — so the read is deterministic and testable.
//
// INDEX USE: the commitment queries lead with (user_id, status, next_surfacing_at)
// = commitments_surfacing_idx. The stale-candidate query scans memories by
// updated_at with no covering index for that ordering; it is bounded tight (LIMIT
// before any sort pressure matters) — see {@link staleCandidates}. A dedicated
// (user_id, status, updated_at) partial index is FUTURE WORK if EXPLAIN shows the
// scan is hot in production.
//
// Content discipline (hard rule 6): topic/content are content-adjacent and are
// NEVER logged here; callers log ids/counts/lengths only.
import { and, asc, desc, eq, isNull, lt, ne, or, type SQL, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { commitments, memories } from './schema/memory.js'

/**
 * Which slice of memory the briefing covers. The `kind` discriminates how the
 * scope/project predicate is built; core REQUIRES one of these (no-firehose:
 * there is no "everything unfiltered" default), this layer trusts the typed value.
 *
 *   - `{ kind: 'all' }`        — every scope/project for the tenant (still bounded
 *      by each list's LIMIT; "all" widens the row space, not the row count).
 *   - `{ kind: 'scope', scope }`     — one scope.
 *   - `{ kind: 'project', project }` — one project.
 */
export type BriefingSelector =
  | { kind: 'all' }
  | { kind: 'scope'; scope: string }
  | { kind: 'project'; project: string }

/** A commitment row for the briefing (ids/status/timestamps only — no content). */
export interface BriefingCommitmentRow {
  id: string
  memoryId: string
  topic: string
  status: string
  dueAt: Date | null
  nextSurfacingAt: Date | null
}

/** A memory row for the briefing list sections (decision/blocker/preference). */
export interface BriefingMemoryRow {
  id: string
  memoryType: string
  topic: string
  content: string
  scope: string
  project: string | null
  recordedAt: Date
  updatedAt: Date
}

/**
 * A bounded briefing section: the CAPPED item slice plus the EXACT total of
 * matching rows. Both come from ONE statement (a `count(*) OVER()` window beside
 * the rows), so `totalCount` is a snapshot-consistent count of the SAME predicate
 * the items were drawn from — never the truncated `items.length`, never a count
 * from a divergent second snapshot (Codex P2, comment 3372242177). `totalCount`
 * is 0 when there are no matching rows.
 */
export interface BriefingPage<T> {
  items: T[]
  totalCount: number
}

/**
 * The window aggregate that rides every briefing list query: `count(*) OVER()`
 * partitions over the whole result set BEFORE the LIMIT, so each returned row
 * carries the EXACT total of rows matching the WHERE predicate. Selecting it in
 * the SAME statement as the items is what makes the count snapshot-consistent
 * with the slice under READ COMMITTED (one statement, one snapshot). Reading it
 * from any returned row yields the total; zero rows means total 0.
 */
const TOTAL_COUNT = sql<number>`count(*) over()`.mapWith(Number)

/**
 * Read `totalCount` from a window-count result. The window value is identical on
 * every row, so the first row carries it; an empty result means no matching rows,
 * hence total 0.
 */
function totalFrom(rows: ReadonlyArray<{ totalCount: number }>): number {
  return rows[0]?.totalCount ?? 0
}

/**
 * Build the scope/project narrowing predicate for the `memories` table from a
 * {@link BriefingSelector}. Returns `undefined` for `kind: 'all'` (no narrowing).
 */
function memoryScopePredicate(selector: BriefingSelector): SQL | undefined {
  if (selector.kind === 'scope') return eq(memories.scope, selector.scope)
  if (selector.kind === 'project') return eq(memories.project, selector.project)
  return undefined
}

/**
 * The OPEN-commitment predicate for {@link openCommitments}: open|waiting
 * commitments whose riding memory is live — the SAME two-condition liveness used
 * by liveMemoriesByType / staleCandidates: valid_to IS NULL (not superseded) AND
 * status = 'active' (not archived). Without the status check an archived but
 * un-superseded commitment topic would still surface in briefing/handoff,
 * contradicting the liveness definition the module enforces.
 *
 * Leads with the caller-bound `memories.user_id = userId` tenant condition
 * (module header): the join's `commitments.user_id = memories.user_id` is only
 * a key-equality between the two tables, so the caller binding must be its own
 * condition.
 */
function openCommitmentPredicate(userId: string, selector: BriefingSelector): SQL {
  const conditions: SQL[] = [
    eq(memories.userId, userId),
    or(eq(commitments.status, 'open'), eq(commitments.status, 'waiting')) as SQL,
    isNull(memories.validTo),
    eq(memories.status, 'active'),
  ]
  const scoped = memoryScopePredicate(selector)
  if (scoped !== undefined) conditions.push(scoped)
  return and(...conditions) as SQL
}

/**
 * Open + waiting commitments for the tenant, joined to their riding memory for
 * the topic, scope/project-narrowed, ORDERED by surfacing urgency
 * (next_surfacing_at ASC NULLS LAST, then due_at) and BOUNDED by `limit`.
 *
 * Leads the index with status IN ('open','waiting') (commitments_surfacing_idx is
 * (user_id, status, next_surfacing_at)). The OVERDUE split is NOT derived from this
 * slice — a commitment that is overdue but sorts after `limit` would be silently
 * dropped (Codex P1, comment 3367224044). Overdue is its own bounded read,
 * {@link overdueCommitments}, with its own exact total.
 *
 * BRIEF-MODE CONTRACT: `items` is CAPPED at `limit`; `totalCount` is the EXACT
 * total over the same predicate, read from a `count(*) OVER()` window in the SAME
 * statement so it stays snapshot-consistent with the slice (Codex P2, comment
 * 3372242177) — items is the slice, totalCount is exact.
 */
export async function openCommitments(
  tx: TenantTx,
  userId: string,
  selector: BriefingSelector,
  limit: number,
): Promise<BriefingPage<BriefingCommitmentRow>> {
  const rows = await tx
    .select({
      id: commitments.id,
      memoryId: commitments.memoryId,
      topic: memories.topic,
      status: commitments.status,
      dueAt: commitments.dueAt,
      nextSurfacingAt: commitments.nextSurfacingAt,
      totalCount: TOTAL_COUNT,
    })
    .from(commitments)
    .innerJoin(
      memories,
      and(eq(commitments.userId, memories.userId), eq(commitments.memoryId, memories.id)),
    )
    .where(openCommitmentPredicate(userId, selector))
    // Most-urgent first: a due/surfacing instant outranks an open-ended one.
    .orderBy(asc(commitments.nextSurfacingAt), asc(commitments.dueAt), asc(commitments.id))
    .limit(limit)
  return { items: rows.map(stripCount), totalCount: totalFrom(rows) }
}

/**
 * The OVERDUE predicate for {@link overdueCommitments}: open|waiting commitments
 * whose riding memory is live (the SAME two-condition liveness from
 * {@link openCommitments}: valid_to IS NULL AND status = 'active') and whose
 * due_at is strictly in the past relative to the injected `now`.
 *
 * `now` is injected (no wall-clock read here) so the read is deterministic.
 * Leads with the caller-bound `memories.user_id = userId` tenant condition
 * (module header) — the join equality alone does not bind to the caller.
 */
function overduePredicate(userId: string, selector: BriefingSelector, now: Date): SQL {
  const conditions: SQL[] = [
    eq(memories.userId, userId),
    or(eq(commitments.status, 'open'), eq(commitments.status, 'waiting')) as SQL,
    isNull(memories.validTo),
    eq(memories.status, 'active'),
    lt(commitments.dueAt, now),
  ]
  const scoped = memoryScopePredicate(selector)
  if (scoped !== undefined) conditions.push(scoped)
  return and(...conditions) as SQL
}

/**
 * OVERDUE commitments — open|waiting, live riding memory, due_at strictly in the
 * PAST relative to the injected `now` — ORDERED by due_at ASC (most overdue first)
 * and BOUNDED by `limit`.
 *
 * This is a DEDICATED bounded read, NOT a filter over the {@link openCommitments}
 * slice: an overdue commitment that sorts after the general slice's `limit` (which
 * orders by surfacing urgency, not due_at) would otherwise be silently dropped —
 * exactly the late obligation a briefing must never omit (Codex P1, comment
 * 3367224044).
 *
 * BRIEF-MODE CONTRACT: `items` is CAPPED at `limit`; `totalCount` is the EXACT
 * overdue total from a `count(*) OVER()` window in the SAME statement, so it stays
 * snapshot-consistent with the slice (Codex P2, comment 3372242177).
 */
export async function overdueCommitments(
  tx: TenantTx,
  userId: string,
  selector: BriefingSelector,
  now: Date,
  limit: number,
): Promise<BriefingPage<BriefingCommitmentRow>> {
  const rows = await tx
    .select({
      id: commitments.id,
      memoryId: commitments.memoryId,
      topic: memories.topic,
      status: commitments.status,
      dueAt: commitments.dueAt,
      nextSurfacingAt: commitments.nextSurfacingAt,
      totalCount: TOTAL_COUNT,
    })
    .from(commitments)
    .innerJoin(
      memories,
      and(eq(commitments.userId, memories.userId), eq(commitments.memoryId, memories.id)),
    )
    .where(overduePredicate(userId, selector, now))
    // Most overdue first: the earliest past-due instant leads.
    .orderBy(asc(commitments.dueAt), asc(commitments.id))
    .limit(limit)
  return { items: rows.map(stripCount), totalCount: totalFrom(rows) }
}

/** Drop the window-count column from a commitment row to yield the public shape. */
function stripCount(row: BriefingCommitmentRow & { totalCount: number }): BriefingCommitmentRow {
  const { totalCount: _ignored, ...rest } = row
  return rest
}

/** Drop the window-count column from a memory row to yield the public shape. */
function stripMemoryCount(row: BriefingMemoryRow & { totalCount: number }): BriefingMemoryRow {
  const { totalCount: _ignored, ...rest } = row
  return rest
}

/**
 * The LIVE-memory-by-type predicate for {@link liveMemoriesByType}: rows of
 * `memoryType` whose liveness holds — "Live/active" == valid_to IS NULL AND
 * status = 'active' — scope/project-narrowed. Leads with the caller-bound
 * `memories.user_id = userId` tenant condition (module header).
 */
function liveMemoryByTypePredicate(
  userId: string,
  selector: BriefingSelector,
  memoryType: string,
): SQL {
  const conditions: SQL[] = [
    eq(memories.userId, userId),
    eq(memories.memoryType, memoryType),
    isNull(memories.validTo),
    eq(memories.status, 'active'),
  ]
  const scoped = memoryScopePredicate(selector)
  if (scoped !== undefined) conditions.push(scoped)
  return and(...conditions) as SQL
}

/**
 * Live memories of a given `memoryType`, scope/project-narrowed, ordered by
 * recency (recorded_at DESC) and BOUNDED by `limit`. The single shared shape for
 * the blocker / decision / preference sections (each differs only by type and
 * the caller's limit). "Live/active" == valid_to IS NULL AND status = 'active'.
 *
 * BRIEF-MODE CONTRACT: `items` is CAPPED at `limit`; `totalCount` is the EXACT
 * total per type from a `count(*) OVER()` window in the SAME statement, so it
 * stays snapshot-consistent with the slice (Codex P2, comment 3372242177).
 */
async function liveMemoriesByType(
  tx: TenantTx,
  userId: string,
  selector: BriefingSelector,
  memoryType: string,
  limit: number,
): Promise<BriefingPage<BriefingMemoryRow>> {
  const rows = await tx
    .select({
      id: memories.id,
      memoryType: memories.memoryType,
      topic: memories.topic,
      content: memories.content,
      scope: memories.scope,
      project: memories.project,
      recordedAt: memories.recordedAt,
      updatedAt: memories.updatedAt,
      totalCount: TOTAL_COUNT,
    })
    .from(memories)
    .where(liveMemoryByTypePredicate(userId, selector, memoryType))
    .orderBy(desc(memories.recordedAt), asc(memories.id))
    .limit(limit)
  return { items: rows.map(stripMemoryCount), totalCount: totalFrom(rows) }
}

/** Active blockers (memory_type = 'blocker'), most-recent first, bounded + exact total. */
export function activeBlockers(
  tx: TenantTx,
  userId: string,
  selector: BriefingSelector,
  limit: number,
): Promise<BriefingPage<BriefingMemoryRow>> {
  return liveMemoriesByType(tx, userId, selector, 'blocker', limit)
}

/** Recent decisions (memory_type = 'decision'), recorded_at DESC, bounded + exact total. */
export function recentDecisions(
  tx: TenantTx,
  userId: string,
  selector: BriefingSelector,
  limit: number,
): Promise<BriefingPage<BriefingMemoryRow>> {
  return liveMemoriesByType(tx, userId, selector, 'decision', limit)
}

/** Active preferences (memory_type = 'preference'), most-recent first, bounded + exact total. */
export function activePreferences(
  tx: TenantTx,
  userId: string,
  selector: BriefingSelector,
  limit: number,
): Promise<BriefingPage<BriefingMemoryRow>> {
  return liveMemoriesByType(tx, userId, selector, 'preference', limit)
}

/**
 * The STALE-candidate predicate for {@link staleCandidates}: LIVE active
 * non-commitment memories untouched (updated_at) since `staleBefore`,
 * scope/project-narrowed. Commitment-type rows are excluded — they surface via
 * their own (open/waiting) list, not by staleness. Leads with the caller-bound
 * `memories.user_id = userId` tenant condition (module header).
 */
function staleCandidatePredicate(
  userId: string,
  selector: BriefingSelector,
  staleBefore: Date,
): SQL {
  const conditions: SQL[] = [
    eq(memories.userId, userId),
    isNull(memories.validTo),
    eq(memories.status, 'active'),
    lt(memories.updatedAt, staleBefore),
    ne(memories.memoryType, 'commitment'),
  ]
  const scoped = memoryScopePredicate(selector)
  if (scoped !== undefined) conditions.push(scoped)
  return and(...conditions) as SQL
}

/**
 * Stale candidates: LIVE, active memories not touched (updated_at) since
 * `staleBefore`, scope/project-narrowed, ordered OLDEST-first (the most-stale
 * first) and BOUNDED by `limit`.
 *
 * `staleBefore` is computed by core from the injected `now` minus the stale
 * window (no wall-clock read here). Excludes commitment-type memories: an open
 * commitment is surfaced by its own list, not by staleness — staleness is for
 * notes/facts/etc. that have gone quiet.
 *
 * BRIEF-MODE CONTRACT: `items` is CAPPED at `limit`; `totalCount` is the EXACT
 * total from a `count(*) OVER()` window in the SAME statement, so it stays
 * snapshot-consistent with the slice (Codex P2, comment 3372242177).
 *
 * INDEX NOTE: there is no (user_id, status, updated_at) covering index, so this is
 * the one section whose ORDER BY has no supporting index. It is bounded tight by
 * `limit` and the predicate already excludes superseded/archived rows; if EXPLAIN
 * shows it hot in production, add the partial index (future work, documented in
 * the module header).
 */
export async function staleCandidates(
  tx: TenantTx,
  userId: string,
  selector: BriefingSelector,
  staleBefore: Date,
  limit: number,
): Promise<BriefingPage<BriefingMemoryRow>> {
  const rows = await tx
    .select({
      id: memories.id,
      memoryType: memories.memoryType,
      topic: memories.topic,
      content: memories.content,
      scope: memories.scope,
      project: memories.project,
      recordedAt: memories.recordedAt,
      updatedAt: memories.updatedAt,
      totalCount: TOTAL_COUNT,
    })
    .from(memories)
    .where(staleCandidatePredicate(userId, selector, staleBefore))
    // Oldest-touched first: the most-stale memory leads.
    .orderBy(asc(memories.updatedAt), asc(memories.id))
    .limit(limit)
  return { items: rows.map(stripMemoryCount), totalCount: totalFrom(rows) }
}
