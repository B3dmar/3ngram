// SPDX-License-Identifier: Apache-2.0
// Typed SDK errors. The REST surface (apps/server/src/rest/router.ts) returns a
// `{ error: <reason> }` body on every non-2xx response (status 400/401/403/404/
// 409/503) and a generic `internal_error` on 500. The client maps those two
// failure shapes to DISTINCT classes so callers can branch without parsing:
//   - ThreengramApiError      — the server replied with a non-2xx status; carries
//     the HTTP `.status` and the `{ error }` `.reason` code (e.g. 'not_found',
//     'invalid_transition', 'embedding_unavailable', 'invalid_input').
//   - ThreengramNetworkError  — fetch itself rejected (DNS, connection refused,
//     timeout, aborted): no HTTP exchange completed, so there is no status/reason.

/** A non-2xx REST response: carries the HTTP status and the `{ error }` reason code. */
export class ThreengramApiError extends Error {
  /** The HTTP status code of the failing response (e.g. 404, 409, 503). */
  readonly status: number
  /** The REST `{ error: <reason> }` body code (e.g. 'not_found'); 'unknown' when absent. */
  readonly reason: string
  /** Optional bounded recovery guidance supplied by the REST error contract. */
  readonly detail: string | undefined

  constructor(status: number, reason: string, detail?: string) {
    super(`3ngram REST request failed: ${status} ${reason}`)
    this.name = 'ThreengramApiError'
    this.status = status
    this.reason = reason
    this.detail = detail
  }
}

/** A transport-level failure: `fetch` rejected before any HTTP response arrived. */
export class ThreengramNetworkError extends Error {
  /** The underlying transport rejection (the original fetch error), if any. */
  override readonly cause: unknown

  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'ThreengramNetworkError'
    this.cause = cause
  }
}
