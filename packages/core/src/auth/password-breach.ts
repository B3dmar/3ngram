// SPDX-License-Identifier: Apache-2.0
// Known-breach password screening (NIST 800-63B, research R3). Rejects a password
// that appears in the HaveIBeenPwned "Pwned Passwords" corpus using the
// k-anonymity range API: the password is SHA-1 hashed locally and only the first
// 5 hex chars of that digest ever leave the process — the password itself is
// never transmitted or logged (hard rule 6).
//
// FAIL-OPEN by contract: a disabled flag, a timeout, a non-2xx, or any transport
// failure ALLOWS the password (account availability outranks a best-effort
// screen). A positive corpus hit is the ONLY rejection. The toggle (enabled) and
// the fail-open behaviour are separate axes (data-model D4): enabling the check
// never blocks account creation when the corpus is unreachable.
import { createHash } from 'node:crypto'

const PWNED_RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range'
const DEFAULT_TIMEOUT_MS = 800
const SHA1_PREFIX_LENGTH = 5

/**
 * Thrown by {@link assertPasswordNotBreached} when (and only when) the password
 * is present in the breach corpus. Callers map it to a generic validation failure
 * surfaced on the password field — it leaks nothing about account existence (the
 * verdict depends on the password value alone, identical for any email).
 */
export class PasswordBreachedError extends Error {
  constructor() {
    super('password appears in a known-breach corpus')
    this.name = 'PasswordBreachedError'
  }
}

/**
 * Fetch the HIBP range body for a 5-char SHA-1 prefix. The body is newline-
 * delimited `SUFFIX:COUNT` lines (the suffix is the remaining 35 hex chars).
 * Injected in tests so the corpus can be faked with no network.
 */
export type PwnedRangeFetcher = (prefix: string, signal: AbortSignal) => Promise<string>

/**
 * Minimal pino-shaped logger surface (obj-then-msg), mirroring embed.ts's
 * EmbedLogger: transports INJECT the configured `@3ngram/config` logger; core
 * never imports one. Used only to make a fail-open outage observable — the obj
 * carries a bounded reason code and never any password material (hard rule 6).
 */
export interface BreachCheckLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

/** No-op logger: the default when the caller injects none. */
const noopLogger: BreachCheckLogger = { warn: () => {} }

export interface PasswordBreachCheckOptions {
  /** The PASSWORD_BREACH_CHECK_ENABLED toggle. When false the check is a no-op. */
  enabled: boolean
  /** Outbound budget; the range query is a single attempt with no retry. */
  timeoutMs?: number
  /** Range-body fetcher; defaults to the live HIBP endpoint. */
  fetchRange?: PwnedRangeFetcher
  /** Injected logger for the content-free fail-open warning. Defaults to no-op. */
  logger?: BreachCheckLogger | undefined
}

/** SHA-1 hex of `value`, uppercased to match the HIBP range-API encoding. */
function sha1UpperHex(value: string): string {
  return createHash('sha1').update(value).digest('hex').toUpperCase()
}

const liveFetchRange: PwnedRangeFetcher = async (prefix, signal) => {
  const response = await fetch(`${PWNED_RANGE_ENDPOINT}/${prefix}`, {
    signal,
    headers: {
      // Add-Padding blunts the response-size oracle: HIBP pads the range with
      // synthetic zero-count entries so the body length reveals nothing.
      'Add-Padding': 'true',
      // HIBP requires an identifying User-Agent and may 403 a generic/default
      // one (Node sends `node`). A 403 would throw → fail open → screening
      // silently becomes a no-op, so identify the consuming app explicitly.
      'User-Agent': '3ngram-password-breach-check',
    },
  })
  if (!response.ok) throw new Error(`pwned range query failed: ${response.status}`)
  return response.text()
}

/** True if `suffix` (35 upper-hex chars) appears with a non-zero count in `body`. */
function suffixIsBreached(body: string, suffix: string): boolean {
  for (const line of body.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    if (line.slice(0, separator).trim().toUpperCase() !== suffix) continue
    const count = Number.parseInt(line.slice(separator + 1).trim(), 10)
    return Number.isFinite(count) && count > 0
  }
  return false
}

/**
 * Reject a known-breached password. No-op when disabled. Fails open on any
 * transport error or timeout (returns without throwing). Throws
 * {@link PasswordBreachedError} only on a positive corpus hit — that throw sits
 * OUTSIDE the fail-open catch so a real breach is never swallowed. The password
 * is never logged (hard rule 6) and never leaves the process (only its 5-char
 * SHA-1 prefix is sent).
 */
export async function assertPasswordNotBreached(
  password: string,
  options: PasswordBreachCheckOptions,
): Promise<void> {
  if (!options.enabled) return

  const digest = sha1UpperHex(password)
  const prefix = digest.slice(0, SHA1_PREFIX_LENGTH)
  const suffix = digest.slice(SHA1_PREFIX_LENGTH)
  const fetchRange = options.fetchRange ?? liveFetchRange
  const logger = options.logger ?? noopLogger
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let body: string
  try {
    body = await fetchRange(prefix, controller.signal)
  } catch {
    // Fail open: timeout / unreachable / non-2xx must never block the user. Make
    // the outage OBSERVABLE (research R3) — emit a bounded, content-free counter
    // (a reason code + the budget, never the password or its SHA-1 prefix) so an
    // HIBP/proxy outage that silently disables screening under
    // PASSWORD_BREACH_CHECK_ENABLED=true is alertable rather than invisible.
    logger.warn(
      { reason: controller.signal.aborted ? 'timeout' : 'unreachable', timeoutMs },
      'password breach check failed open; screening skipped',
    )
    return
  } finally {
    clearTimeout(timer)
  }

  if (suffixIsBreached(body, suffix)) throw new PasswordBreachedError()
}
