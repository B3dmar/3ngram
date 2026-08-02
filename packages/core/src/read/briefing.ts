// SPDX-License-Identifier: Apache-2.0
// briefing(): the session-orientation read path.
// The policy surface for the "start my session
// oriented" JTBD.
//
// apps -> core -> db layering (hard rule 5): this owns the DEFAULTS, the SELECTOR
// DISCIPLINE, the brief/full mode, and the overdue/stale derivations, then
// delegates each bounded list to packages/db (briefing-read.ts) inside ONE
// withTenant transaction (hard rule 3) — so every section reads against one
// consistent snapshot. Transports (REST/MCP) call this and hold zero logic.
//
// NO-FIREHOSE: a briefing REQUIRES an explicit
// selector (scope | project | 'all'). A MISSING selector is a typed
// {@link MissingSelectorError}, never a silent "everything" default — that
// firehose is exactly what the old system regretted. Every list is BOUNDED by a
// DEFAULT/MAX limit constant (get_facts precedent).
//
// MODES: `brief` (DEFAULT) returns COUNTS plus a small TOP slice per section;
// `full` returns the bounded lists. Even `full` is size-disciplined — its limits
// are the MAX constants, never unbounded.
//
// INJECTED TIME (no datetime.now() in business logic): the caller passes `now`;
// the overdue split (due_at < now) and the stale window (updated_at < now - N
// days) are derived from it, so a briefing is deterministic and testable.
//
// VALIDATION GAP (hard rule 2): the single Zod boundary is packages/schema. The
// SELECTOR shape is validated by the MCP schema at the transport; this core layer
// additionally enforces the SEMANTIC invariant (a selector MUST be present, and a
// scope/project selector MUST carry its value) as a typed error — the same
// inline-stand-in pattern facts.ts documents. It adds NO Zod to core.
//
// Observability (hard rule 6): topic/content are content-adjacent and are NEVER
// logged. This module logs nothing; callers honour the same rule.
import {
  activeBlockers,
  activePreferences,
  type BriefingCommitmentRow,
  type BriefingMemoryRow,
  type BriefingSelector,
  openCommitments,
  overdueCommitments,
  recentDecisions,
  staleCandidates,
  withTenant,
} from '@3ngram/db'

export type { BriefingSelector } from '@3ngram/db'

/**
 * Thrown when a briefing/handoff is requested without an explicit selector, or
 * with a scope/project selector missing its value. The no-firehose rule is the
 * design's centerpiece: there is NO unfiltered default, so an
 * absent selector is a caller error, not "give me everything". A typed,
 * actionable error for transports to surface as a 4xx (stands in for the Zod
 * ValidationError at the core boundary; the MCP schema also rejects the shape).
 */
export class MissingSelectorError extends Error {
  constructor(message = 'a briefing requires an explicit selector (scope, project, or all)') {
    super(message)
    this.name = 'MissingSelectorError'
  }
}

/** The briefing detail level. `brief` (default) = counts + top items; `full` = bounded lists. */
export type BriefingMode = 'brief' | 'full'

/**
 * Stale window: a live, active memory untouched for this many DAYS is a stale
 * CANDIDATE (it has gone quiet and may want review). 30 days is the sensible
 * default — long enough that a memory is genuinely dormant, short enough that the
 * briefing still surfaces drift. Documented here as the single source of truth;
 * core derives `now - STALE_WINDOW_DAYS` and passes the instant to db.
 */
export const STALE_WINDOW_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * `brief` mode TOP-slice size per section. brief returns the COUNT plus only this
 * many items per list — enough to orient, never the firehose. Small by design
 * (output discipline).
 */
export const DEFAULT_BRIEFING_TOP = 3

/**
 * `full` mode per-section ceiling — the MAX a single section ever returns. Even
 * `full` is bounded (no-firehose); a caller wanting more pages via search/get_facts.
 */
export const MAX_BRIEFING_SECTION = 25

/** Inputs for {@link briefing}. `now` is injected (no wall-clock read in core). */
export interface BriefingQuery {
  selector: BriefingSelector | undefined
  mode?: BriefingMode
  now: Date
}

/** A commitment line in the briefing (ids/topic/status/timestamps — no content). */
export interface BriefingCommitment {
  id: string
  memoryId: string
  topic: string
  status: string
  dueAt: string | null
  overdue: boolean
}

/** A memory line in a briefing section (topic only in brief; content stays out of brief). */
export interface BriefingMemoryItem {
  id: string
  memoryType: string
  topic: string
  scope: string
  project: string | null
  recordedAt: string
  updatedAt: string
}

/**
 * One briefing section. BRIEF-MODE CONTRACT: `count` is the EXACT total from a
 * `count(*) OVER()` window read in the SAME statement as the rows, while `items`
 * is a CAPPED slice (at most {@link MAX_BRIEFING_SECTION}, or
 * {@link DEFAULT_BRIEFING_TOP} in brief mode). A client compares `count` to
 * `items.length` to detect truncation — `items` is bounded, `count` is exact and
 * snapshot-consistent with the slice.
 */
export interface BriefingSection<T> {
  count: number
  items: T[]
}

/**
 * The structured briefing: the selector echoed back, the mode,
 * and one size-disciplined section per orientation concern. EVERY section reports
 * an EXACT `count` (a `count(*) OVER()` window read in the SAME statement as its
 * rows) while `items` stays a CAPPED slice — a client compares the two to detect
 * truncation. `overdue` (open|waiting
 * with due_at < now) is additionally its OWN
 * bounded query, NOT a filter over the `commitments` slice — a late commitment
 * that sorts after the general cap must never be dropped.
 */
export interface Briefing {
  selector: BriefingSelector
  mode: BriefingMode
  generatedAt: string
  commitments: BriefingSection<BriefingCommitment>
  overdue: BriefingSection<BriefingCommitment>
  blockers: BriefingSection<BriefingMemoryItem>
  staleCandidates: BriefingSection<BriefingMemoryItem>
  recentDecisions: BriefingSection<BriefingMemoryItem>
  preferences: BriefingSection<BriefingMemoryItem>
}

/**
 * Validate the selector invariant and return the typed selector, or throw
 * {@link MissingSelectorError}. Shared by briefing() and handoff() so the
 * no-firehose rule has ONE enforcement point.
 */
export function requireSelector(selector: BriefingSelector | undefined): BriefingSelector {
  if (selector === undefined) throw new MissingSelectorError()
  if (selector.kind === 'scope' && selector.scope.trim() === '') {
    throw new MissingSelectorError('a scope selector requires a non-empty scope')
  }
  if (selector.kind === 'project' && selector.project.trim() === '') {
    throw new MissingSelectorError('a project selector requires a non-empty project')
  }
  return selector
}

/** Per-section fetch limit: brief reads only the top slice; full reads up to the ceiling. */
function sectionLimit(mode: BriefingMode): number {
  return mode === 'brief' ? DEFAULT_BRIEFING_TOP : MAX_BRIEFING_SECTION
}

function toCommitment(row: BriefingCommitmentRow, now: Date): BriefingCommitment {
  return {
    id: row.id,
    memoryId: row.memoryId,
    topic: row.topic,
    status: row.status,
    dueAt: row.dueAt?.toISOString() ?? null,
    // Overdue == a due instant strictly in the past relative to the injected now.
    overdue: row.dueAt !== null && row.dueAt.getTime() < now.getTime(),
  }
}

function toMemoryItem(row: BriefingMemoryRow): BriefingMemoryItem {
  return {
    id: row.id,
    memoryType: row.memoryType,
    topic: row.topic,
    scope: row.scope,
    project: row.project,
    recordedAt: row.recordedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * A section is its EXACT `count` (a window total, passed in) plus a `top`-bounded
 * item slice. count is NOT items.length: items is capped at the fetch ceiling, so
 * deriving the count from it would under-report once a section exceeds the cap.
 */
function section<T>(count: number, items: T[], top: number): BriefingSection<T> {
  return { count, items: items.slice(0, top) }
}

/**
 * Build the structured briefing for `userId`.
 *
 * REQUIRES an explicit selector (no-firehose): omit it and the
 * call throws {@link MissingSelectorError}. Mode defaults to `brief` (counts +
 * top {@link DEFAULT_BRIEFING_TOP} items); `full` returns the bounded lists (up
 * to {@link MAX_BRIEFING_SECTION} per section). The overdue split is derived from
 * the injected `now` against each commitment's due_at.
 *
 * Runs every section in ONE withTenant transaction so the snapshot is consistent;
 * RLS scopes every read to the tenant on every path.
 *
 * @throws {@link MissingSelectorError} no selector / empty scope|project value.
 */
export async function briefing(userId: string, query: BriefingQuery): Promise<Briefing> {
  const selector = requireSelector(query.selector)
  const mode: BriefingMode = query.mode ?? 'brief'
  const top = sectionLimit(mode)
  // brief shows the top slice; full shows the ceiling. We always FETCH the
  // ceiling so the COUNT is meaningful (how many open commitments exist, not just
  // how many we surfaced) while the slice is bounded by `top`.
  const fetchLimit = MAX_BRIEFING_SECTION
  const staleBefore = new Date(query.now.getTime() - STALE_WINDOW_DAYS * MS_PER_DAY)

  // Each section query returns BOTH its CAPPED list and the EXACT total over the
  // SAME predicate in ONE statement (a `count(*) OVER()` window in briefing-read.ts):
  // `totalCount` never under-reports once a section exceeds the cap, and — because
  // it rides the same statement/snapshot as the rows — it stays consistent with the
  // slice even under READ COMMITTED, where a separate COUNT(*) could see a different
  // snapshot. Run in ONE withTenant transaction.
  const fetched = await withTenant(userId, async (tx) => ({
    commitments: await openCommitments(tx, userId, selector, fetchLimit),
    // Overdue is a DEDICATED bounded read with its OWN exact total, never a filter
    // over the capped general slice — a late commitment that sorts after the cap
    // must never be dropped.
    overdue: await overdueCommitments(tx, userId, selector, query.now, fetchLimit),
    blockers: await activeBlockers(tx, userId, selector, fetchLimit),
    stale: await staleCandidates(tx, userId, selector, staleBefore, fetchLimit),
    decisions: await recentDecisions(tx, userId, selector, fetchLimit),
    preferences: await activePreferences(tx, userId, selector, fetchLimit),
  }))

  const allCommitments = fetched.commitments.items.map((row) => toCommitment(row, query.now))
  const overdueItems = fetched.overdue.items.map((row) => toCommitment(row, query.now))

  return {
    selector,
    mode,
    generatedAt: query.now.toISOString(),
    commitments: section(fetched.commitments.totalCount, allCommitments, top),
    overdue: section(fetched.overdue.totalCount, overdueItems, top),
    blockers: section(fetched.blockers.totalCount, fetched.blockers.items.map(toMemoryItem), top),
    staleCandidates: section(fetched.stale.totalCount, fetched.stale.items.map(toMemoryItem), top),
    recentDecisions: section(
      fetched.decisions.totalCount,
      fetched.decisions.items.map(toMemoryItem),
      top,
    ),
    preferences: section(
      fetched.preferences.totalCount,
      fetched.preferences.items.map(toMemoryItem),
      top,
    ),
  }
}
