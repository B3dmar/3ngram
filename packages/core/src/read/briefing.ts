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
  type BriefingPage,
  type BriefingSelector,
  openCommitments,
  overdueCommitments,
  recentDecisions,
  staleCandidates,
  withTenant,
} from '@3ngram/db'
import {
  BRIEFING_SECTION_NAMES,
  type BriefingSectionName,
  MAX_BRIEFING_SECTION_CEILING,
  type MemoryType,
} from '@3ngram/schema'

export type { BriefingSelector } from '@3ngram/db'

import { applyPolicyToSelector, type RetrievalPolicy } from './retrieval-policy.js'

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

/**
 * Stale-candidate memory-type ALLOWLIST: only these types qualify for the
 * staleness review, alongside the {@link STALE_WINDOW_DAYS} window.
 *
 * WHY AN ALLOWLIST (not a NOT-IN exclusion): the original predicate excluded
 * only 'commitment', so EVERY other live memory older than the window was a
 * "stale candidate". In production that matched ~74% of active memories —
 * dominated by bulk-imported event/note rows — which turned the section into
 * unusable noise. An allowlist also fails CLOSED: a future or imported memory
 * type is EXCLUDED by default and must argue its way in, instead of silently
 * flooding the briefing again.
 *
 * WHY THESE FOUR: decision/preference/blocker/fact are the curated, reviewable
 * statements whose going quiet is a meaningful signal — a decision may have
 * been overtaken, a preference may have drifted, a blocker may have cleared, a
 * fact may have gone out of date. The rest go stale by NATURE, not by neglect:
 * 'event' and 'note' are episodic/free-form records (nothing to re-review),
 * 'pattern' is consolidation-derived, and 'commitment' surfaces via its own
 * open/waiting/overdue lists, never by staleness.
 */
export const STALE_CANDIDATE_TYPES: readonly MemoryType[] = [
  'decision',
  'preference',
  'blocker',
  'fact',
]

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * `brief` mode TOP-slice size per section. brief returns the COUNT plus only this
 * many items per list — enough to orient, never the firehose. Small by design
 * (output discipline).
 */
export const DEFAULT_BRIEFING_TOP = 3

/**
 * `full`-mode DEFAULT section bound — the per-section item count a `full`
 * briefing returns when the caller does not tune `sectionLimit`. NOT the max
 * (bounds V2, issue #45): the hard server-side ceiling is
 * {@link MAX_BRIEFING_SECTION_CEILING} (re-exported from `@3ngram/schema`);
 * a caller may tune up to it, never past it.
 */
export const MAX_BRIEFING_SECTION = 25

/**
 * Inputs for {@link briefing}. `now` is injected (no wall-clock read in core).
 *
 * BOUNDS V2 (issue #45): `sections` picks a SUBSET of the six sections — an
 * un-requested section is skipped entirely (its query never runs; absent =
 * all six, today's behavior). `sectionLimit` is the caller-tunable per-section
 * item bound (absent = the mode default, 3 brief / 25 full); the effective
 * fetch limit is clamped to {@link MAX_BRIEFING_SECTION_CEILING} so the
 * server-side no-firehose ceiling always wins. Both knobs are validated at the
 * transport boundary (briefingToolInputV2Schema); core re-clamps for direct
 * callers.
 */
export interface BriefingQuery {
  selector: BriefingSelector | undefined
  mode?: BriefingMode
  sections?: readonly BriefingSectionName[] | undefined
  sectionLimit?: number | undefined
  /**
   * Injected per-user retrieval-scope policy (issue #47), resolved once per
   * request by the transport (ADR-0011: a parameter, never ambient state).
   * A `kind: 'all'` selector under mode `default` is narrowed to the
   * configured scope — the result echoes BOTH the effective selector and
   * `appliedScope` (never silent); under `require` it throws the typed
   * UnscopedRetrievalError. A scope/project selector always passes through.
   */
  retrievalPolicy?: RetrievalPolicy | undefined
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
  /** Explicit truncation signal: `count > items.length` (more exist than returned). */
  hasMore: boolean
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
 *
 * SECTIONS ARE OPTIONAL (bounds V2, issue #45): a section key is PRESENT
 * exactly when it was requested (all six when `sections` is absent) and OMITTED
 * when the caller excluded it — its query never ran, so there is no count to
 * report (an omitted key, never a fabricated zero).
 */
export interface Briefing {
  selector: BriefingSelector
  mode: BriefingMode
  generatedAt: string
  /**
   * The scope the injected retrieval policy applied to a `kind: 'all'` call
   * (issue #47) — PRESENT exactly when the policy narrowed this briefing (the
   * echoed `selector` is then the effective scope selector, not the caller's
   * `all`). Omitted when nothing was narrowed: no policy, mode `off`, or an
   * explicit caller selector. Narrowing is never silent.
   */
  appliedScope?: string
  commitments?: BriefingSection<BriefingCommitment>
  overdue?: BriefingSection<BriefingCommitment>
  blockers?: BriefingSection<BriefingMemoryItem>
  staleCandidates?: BriefingSection<BriefingMemoryItem>
  recentDecisions?: BriefingSection<BriefingMemoryItem>
  preferences?: BriefingSection<BriefingMemoryItem>
}

/**
 * A briefing computed WITHOUT section selection: all six sections PRESENT —
 * the shipped V1 result shape. {@link briefing}'s overloads return THIS type
 * for a query carrying no `sections`, so a strict legacy consumer
 * (`result.commitments.items`) keeps compiling unchanged; only an actual
 * subset call yields the partial {@link Briefing}.
 */
export interface FullBriefing extends Briefing {
  commitments: BriefingSection<BriefingCommitment>
  overdue: BriefingSection<BriefingCommitment>
  blockers: BriefingSection<BriefingMemoryItem>
  staleCandidates: BriefingSection<BriefingMemoryItem>
  recentDecisions: BriefingSection<BriefingMemoryItem>
  preferences: BriefingSection<BriefingMemoryItem>
}

/**
 * Thrown when a direct core caller passes an EMPTY `sections` array. The
 * transport boundary already rejects it (`.min(1)` on the V2 input) and the V2
 * output contract forbids a zero-section briefing — core mirrors the same
 * decision for the published API (the inline-stand-in pattern, module header)
 * instead of silently returning a metadata-only envelope. Omit `sections`
 * entirely to compute all six.
 */
export class EmptySectionsError extends Error {
  constructor(
    message = 'sections must name at least one briefing section — omit it to compute all sections',
  ) {
    super(message)
    this.name = 'EmptySectionsError'
  }
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
  if (selector.kind === 'scope_project') {
    if (selector.scope.trim() === '') {
      throw new MissingSelectorError('a scope_project selector requires a non-empty scope')
    }
    if (selector.project.trim() === '') {
      throw new MissingSelectorError('a scope_project selector requires a non-empty project')
    }
  }
  return selector
}

/**
 * Effective per-section limit (bounds V2, issue #45): the caller-tunable
 * `sectionLimit` when present, else the mode default (brief top slice / full
 * bounded list) — clamped into [1, {@link MAX_BRIEFING_SECTION_CEILING}] so the
 * server-side no-firehose ceiling ALWAYS wins. The transport schema already
 * rejects an out-of-range or fractional value; core NORMALIZES for direct
 * callers (the inline-stand-in pattern, module header): `sectionLimit` is typed
 * only as `number`, so a fractional value is truncated toward zero and a
 * non-finite one (NaN/±Infinity) falls back to the mode default BEFORE the
 * clamp — a raw fractional/NaN limit must never reach the SQL LIMIT clause.
 */
function effectiveSectionLimit(mode: BriefingMode, sectionLimit: number | undefined): number {
  const fallback = mode === 'brief' ? DEFAULT_BRIEFING_TOP : MAX_BRIEFING_SECTION
  const requested =
    sectionLimit !== undefined && Number.isFinite(sectionLimit)
      ? Math.trunc(sectionLimit)
      : fallback
  return Math.min(Math.max(requested, 1), MAX_BRIEFING_SECTION_CEILING)
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
 * item slice. count is NOT items.length: items is capped at the fetch limit, so
 * deriving the count from it would under-report once a section exceeds the cap.
 * `hasMore` is the explicit truncation signal (`count > items.length`) callers
 * previously had to derive by hand (bounds V2, issue #45).
 */
function section<T>(count: number, items: T[], top: number): BriefingSection<T> {
  const slice = items.slice(0, top)
  return { count, items: slice, hasMore: count > slice.length }
}

/** The window-count pages one briefing read fetches (absent = section skipped). */
interface FetchedSections {
  commitments?: BriefingPage<BriefingCommitmentRow> | undefined
  overdue?: BriefingPage<BriefingCommitmentRow> | undefined
  blockers?: BriefingPage<BriefingMemoryRow> | undefined
  stale?: BriefingPage<BriefingMemoryRow> | undefined
  decisions?: BriefingPage<BriefingMemoryRow> | undefined
  preferences?: BriefingPage<BriefingMemoryRow> | undefined
}

/**
 * Shape the fetched pages into the optional output sections: a fetched page
 * becomes a {@link section} (exact count + bounded slice + hasMore); a skipped
 * page contributes NO key (conditional spread — never a fabricated zero).
 */
function toSections(fetched: FetchedSections, top: number, now: Date): Partial<Briefing> {
  const commitment = (row: BriefingCommitmentRow) => toCommitment(row, now)
  return {
    ...(fetched.commitments && {
      commitments: section(
        fetched.commitments.totalCount,
        fetched.commitments.items.map(commitment),
        top,
      ),
    }),
    ...(fetched.overdue && {
      overdue: section(fetched.overdue.totalCount, fetched.overdue.items.map(commitment), top),
    }),
    ...(fetched.blockers && {
      blockers: section(fetched.blockers.totalCount, fetched.blockers.items.map(toMemoryItem), top),
    }),
    ...(fetched.stale && {
      staleCandidates: section(
        fetched.stale.totalCount,
        fetched.stale.items.map(toMemoryItem),
        top,
      ),
    }),
    ...(fetched.decisions && {
      recentDecisions: section(
        fetched.decisions.totalCount,
        fetched.decisions.items.map(toMemoryItem),
        top,
      ),
    }),
    ...(fetched.preferences && {
      preferences: section(
        fetched.preferences.totalCount,
        fetched.preferences.items.map(toMemoryItem),
        top,
      ),
    }),
  }
}

/**
 * Build the structured briefing for `userId`.
 *
 * REQUIRES an explicit selector (no-firehose): omit it and the
 * call throws {@link MissingSelectorError}. Mode defaults to `brief` (counts +
 * top {@link DEFAULT_BRIEFING_TOP} items); `full` returns the bounded lists (up
 * to {@link MAX_BRIEFING_SECTION} per section by default; `sectionLimit` tunes
 * the bound up to {@link MAX_BRIEFING_SECTION_CEILING}). `sections` restricts
 * the read to a subset — an un-requested section's query NEVER runs (6 queries
 * → k queries) and its key is omitted from the result. The overdue split is
 * derived from the injected `now` against each commitment's due_at.
 *
 * Runs every requested section in ONE withTenant transaction so the snapshot is
 * consistent; RLS scopes every read to the tenant on every path.
 *
 * OVERLOADS (published-API stability): a query with NO `sections` is
 * runtime-guaranteed all six sections, so it returns {@link FullBriefing}
 * (required sections — the shipped V1 result type); a query that MAY carry a
 * subset returns the partial {@link Briefing}. Legacy strict-TS consumers
 * keep compiling without optional chaining.
 *
 * @throws {@link MissingSelectorError} no selector / empty scope|project value.
 * @throws {@link EmptySectionsError} `sections: []` — a zero-section briefing
 *   is a caller error (the transport `.min(1)` decision, mirrored for direct
 *   core callers), never a metadata-only envelope.
 */
export async function briefing(
  userId: string,
  query: BriefingQuery & { sections?: undefined },
): Promise<FullBriefing>
export async function briefing(userId: string, query: BriefingQuery): Promise<Briefing>
export async function briefing(userId: string, query: BriefingQuery): Promise<Briefing> {
  const requested = requireSelector(query.selector)
  // RETRIEVAL-SCOPE POLICY (issue #47): a `kind: 'all'` selector is the scope
  // axis omitted — `default` narrows it (echoed below, never silent),
  // `require` rejects it typed, an explicit selector always passes through.
  const { selector, appliedScope } = applyPolicyToSelector(query.retrievalPolicy, requested)
  if (query.sections !== undefined && query.sections.length === 0) {
    throw new EmptySectionsError()
  }
  const mode: BriefingMode = query.mode ?? 'brief'
  const top = effectiveSectionLimit(mode, query.sectionLimit)
  // FETCH exactly what is returned: the EXACT total rides `count(*) OVER()` in
  // the SAME statement as the rows (briefing-read.ts), so the count stays
  // meaningful (and snapshot-consistent even under READ COMMITTED) without
  // over-fetching — brief mode reads only its top slice.
  const fetchLimit = top
  const wanted: ReadonlySet<BriefingSectionName> = new Set(query.sections ?? BRIEFING_SECTION_NAMES)
  const staleBefore = new Date(query.now.getTime() - STALE_WINDOW_DAYS * MS_PER_DAY)

  // Only the REQUESTED sections are read (fewer queries; skipped = undefined).
  // Overdue stays a DEDICATED bounded read with its OWN exact total, never a
  // filter over the capped general slice — a late commitment that sorts after
  // the cap must never be dropped. Run in ONE withTenant transaction.
  const fetched = await withTenant(
    userId,
    async (tx): Promise<FetchedSections> => ({
      commitments: wanted.has('commitments')
        ? await openCommitments(tx, userId, selector, fetchLimit)
        : undefined,
      overdue: wanted.has('overdue')
        ? await overdueCommitments(tx, userId, selector, query.now, fetchLimit)
        : undefined,
      blockers: wanted.has('blockers')
        ? await activeBlockers(tx, userId, selector, fetchLimit)
        : undefined,
      stale: wanted.has('staleCandidates')
        ? await staleCandidates(
            tx,
            userId,
            selector,
            staleBefore,
            fetchLimit,
            STALE_CANDIDATE_TYPES,
          )
        : undefined,
      decisions: wanted.has('recentDecisions')
        ? await recentDecisions(tx, userId, selector, fetchLimit)
        : undefined,
      preferences: wanted.has('preferences')
        ? await activePreferences(tx, userId, selector, fetchLimit)
        : undefined,
    }),
  )

  return {
    selector,
    mode,
    generatedAt: query.now.toISOString(),
    // Present exactly when the policy narrowed this call (conditional spread —
    // the key is OMITTED, never a fabricated null, matching the section shape
    // discipline above).
    ...(appliedScope !== null ? { appliedScope } : {}),
    ...toSections(fetched, top, query.now),
  }
}
