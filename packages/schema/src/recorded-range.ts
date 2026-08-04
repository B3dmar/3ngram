// SPDX-License-Identifier: Apache-2.0
// Shared recorded_at range rules (issue #58) — ONE implementation of the
// cross-field sanity checks for the recordedAfter/recordedBefore pair, applied
// by EVERY transport schema that accepts the pair (MCP searchQueryV2Schema →
// carried into V3 via safeExtend; REST memoriesListQuerySchema). Issue #58
// item 1 existed precisely because the inverted-range rule lived inline in one
// superRefine and not the other — sharing the rule set makes MCP↔REST parity
// structural, not reviewed-for.
//
// This module is deliberately zod-free: it returns plain issue descriptors and
// each schema's superRefine maps them to ctx.addIssue, so it adds no coupling
// to zod's refinement-context type and stays trivially unit-testable.

/**
 * Maximum fractional-second digits a recorded_at range bound may carry.
 *
 * WHY 3: both transports convert a bound to a JS `Date` before it reaches SQL
 * (`new Date(iso)` in apps/server), and JS Dates hold MILLISECOND precision —
 * while Postgres stores `recorded_at` at MICROSECOND precision. A bound like
 * `...T00:00:00.1234567Z` would be silently truncated to `.123`, shifting an
 * INCLUSIVE bound and letting a boundary row leak past the requested range.
 * Rejected loudly at the one validation boundary (hard rule 2) instead of
 * silently truncating — the least invasive fix per issue #58 item 2 (the
 * alternative, threading bounds as text into SQL, would widen the Date-typed
 * filter contracts across db/core/server and the cursor fingerprint
 * canonicalization).
 */
export const MAX_RECORDED_BOUND_FRACTION_DIGITS = 3

/**
 * Schema-visible descriptions for the two bounds. Custom refinements disappear
 * from emitted JSON Schema, so the public contract must advertise the precision
 * limit as well as enforce it at runtime.
 */
export function recordedBoundDescription(path: 'recordedAfter' | 'recordedBefore'): string {
  const direction = path === 'recordedAfter' ? 'lower' : 'upper'
  const ordering =
    path === 'recordedAfter'
      ? 'Must not be later than recordedBefore when both are given.'
      : 'Must not be earlier than recordedAfter when both are given.'
  return `Inclusive ${direction} bound on recorded_at. Use at most ${MAX_RECORDED_BOUND_FRACTION_DIGITS} fractional-second digits (millisecond precision). ${ordering}`
}

/** True when an ISO datetime carries more fractional-second digits than a JS Date can represent. */
export function exceedsRecordedBoundPrecision(iso: string): boolean {
  return (/\.(\d+)/.exec(iso)?.[1]?.length ?? 0) > MAX_RECORDED_BOUND_FRACTION_DIGITS
}

/** One recorded-range violation: the offending field plus a caller-facing message. */
export interface RecordedRangeIssue {
  path: 'recordedAfter' | 'recordedBefore'
  message: string
}

/**
 * Validate a recordedAfter/recordedBefore pair (each bound optional):
 *
 *  - PRECISION (per bound): more than {@link MAX_RECORDED_BOUND_FRACTION_DIGITS}
 *    fractional-second digits is rejected — see the constant's rationale.
 *  - RANGE SANITY (cross-field): an INVERTED range (recordedAfter later than
 *    recordedBefore) can never match anything — a caller error, rejected
 *    loudly instead of silently returning an empty result. Equal bounds are a
 *    valid single-instant range (both bounds inclusive).
 *
 * Returns issue descriptors for the calling schema's superRefine to emit
 * (`ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message })`).
 */
export function recordedRangeIssues(range: {
  recordedAfter?: string | undefined
  recordedBefore?: string | undefined
}): RecordedRangeIssue[] {
  const issues: RecordedRangeIssue[] = []
  for (const path of ['recordedAfter', 'recordedBefore'] as const) {
    const bound = range[path]
    if (bound !== undefined && exceedsRecordedBoundPrecision(bound)) {
      issues.push({
        path,
        message: `${path} precision exceeds milliseconds — use at most ${MAX_RECORDED_BOUND_FRACTION_DIGITS} fractional-second digits`,
      })
    }
  }
  if (
    range.recordedAfter !== undefined &&
    range.recordedBefore !== undefined &&
    Date.parse(range.recordedAfter) > Date.parse(range.recordedBefore)
  ) {
    issues.push({
      path: 'recordedAfter',
      message: 'recordedAfter must not be later than recordedBefore — inverted range',
    })
  }
  return issues
}
