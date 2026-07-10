// SPDX-License-Identifier: Apache-2.0
// Postgres driver-error detection, shared across packages/db write helpers.
//
// drizzle wraps the pg driver error, so the pg error (carrying `code`) may sit
// on `.cause` rather than the thrown error itself — check both levels. Keeping
// this in one place means every write path that races a unique constraint maps
// the collision to a typed domain error instead of leaking pg internals.

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505'
/**
 * Postgres check-violation SQLSTATE. The commitment FSM trigger
 * (enforce_commitment_fsm, migration 0001) raises this for an illegal
 * status transition; CHECK constraints also raise it.
 */
const PG_CHECK_VIOLATION = '23514'

const hasCode = (value: unknown, code: string): boolean =>
  typeof value === 'object' && value !== null && (value as { code?: string }).code === code

const getCause = (error: unknown): unknown => (error as { cause?: unknown } | null)?.cause

/**
 * True when `error` (or its wrapped `.cause`) is a Postgres unique-constraint
 * violation. Callers translate this into a typed conflict error.
 */
export const isUniqueViolation = (error: unknown): boolean =>
  hasCode(error, PG_UNIQUE_VIOLATION) || hasCode(getCause(error), PG_UNIQUE_VIOLATION)

/**
 * True when `error` (or its wrapped `.cause`) is a Postgres check-violation.
 * drizzle wraps the pg driver error so the SQLSTATE may sit on `.cause` — the
 * same cause-walk as {@link isUniqueViolation}.
 */
export const isCheckViolation = (error: unknown): boolean =>
  hasCode(error, PG_CHECK_VIOLATION) || hasCode(getCause(error), PG_CHECK_VIOLATION)

/**
 * The FSM trigger's RAISE message ("illegal commitment transition: % -> %"),
 * matched so a CHECK-violation from the FSM guard maps to a transition error
 * rather than a generic check failure. The message text may live on the error
 * or its wrapped `.cause`.
 */
const ILLEGAL_TRANSITION_MARKER = 'illegal commitment transition'

const hasMessageMarker = (value: unknown, marker: string): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { message?: string }).message === 'string' &&
  (value as { message: string }).message.includes(marker)

/**
 * True when `error` is the commitment FSM trigger's illegal-transition raise: a
 * check-violation (23514) whose message carries the trigger marker. This is the
 * DB BACKSTOP firing — core validates transitions via canTransition BEFORE the
 * DB call (hard rule 2), so this only triggers when that validation is bypassed.
 */
export const isIllegalCommitmentTransition = (error: unknown): boolean =>
  isCheckViolation(error) &&
  (hasMessageMarker(error, ILLEGAL_TRANSITION_MARKER) ||
    hasMessageMarker(getCause(error), ILLEGAL_TRANSITION_MARKER))

const getMessage = (value: unknown): string | undefined =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { message?: string }).message === 'string'
    ? (value as { message: string }).message
    : undefined

/**
 * Extract the `from`/`to` status pair from the FSM trigger's raise message
 * ("illegal commitment transition: open -> resolved"), checking the error and
 * its wrapped `.cause`. Returns undefined if neither carries a parseable pair —
 * callers fall back to the requested target.
 */
export const illegalTransitionPair = (error: unknown): { from: string; to: string } | undefined => {
  const re = /illegal commitment transition:\s*(\w+)\s*->\s*(\w+)/
  for (const m of [getMessage(error), getMessage(getCause(error))]) {
    const match = m?.match(re)
    if (match?.[1] && match[2]) return { from: match[1], to: match[2] }
  }
  return undefined
}
