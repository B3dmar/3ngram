// SPDX-License-Identifier: Apache-2.0
// Observability bootstrap (docs/concepts/observability.mdx §2–§3). Import this module FIRST
// in every app entrypoint — Sentry's OTel auto-instrumentation must load
// before http/pg/etc. Never import it from library code; apps only.
import * as Sentry from '@sentry/node'
import { type Env, loadEnv } from './env.js'
import { logger } from './logger.js'
import { contentDigest, REDACTED, REDACTED_FIELDS } from './redaction.js'

const REDACTED_FIELD_SET: ReadonlySet<string> = new Set(REDACTED_FIELDS)

/**
 * Deep-scrub for Sentry payloads: same field list as the log redaction, so
 * the §1 red line (no memory content in error events or traces) holds in one
 * place. Returns plain data — Sentry events are JSON-shaped.
 */
export function scrubEvent<T>(event: T): T {
  return scrubValue(event) as T
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = REDACTED_FIELD_SET.has(key) ? REDACTED : scrubValue(entry)
    }
    return out
  }
  return value
}

function redactFreeText(text: string): string {
  return `[redacted len=${text.length} sha256_8=${contentDigest(text)}]`
}

function safeStackFrames(stack: string | undefined): string[] | undefined {
  const frames = stack
    ?.split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, 20)
  return frames && frames.length > 0 ? frames : undefined
}

/**
 * Error-event scrub for the beforeSend gate. Field-name scrubbing alone is
 * not enough for error events: `exception.values[].value` carries the raw
 * Error message (and `message`/breadcrumb messages are free text), so memory
 * content embedded in an exception would reach Sentry past the field scrub.
 * Free text becomes a len+digest token; structured stacktrace frames survive,
 * so grouping (stack-based) and correlation both keep working. Raw text only
 * in local dev.
 */
export function scrubSentryEvent<T>(event: T): T {
  const scrubbed = scrubValue(event) as Record<string, unknown>
  if (loadEnv().NODE_ENV === 'development') return scrubbed as T

  if (typeof scrubbed.message === 'string') {
    scrubbed.message = redactFreeText(scrubbed.message)
  }
  const exception = scrubbed.exception as { values?: Array<Record<string, unknown>> } | undefined
  for (const entry of exception?.values ?? []) {
    if (typeof entry.value === 'string') entry.value = redactFreeText(entry.value)
  }
  const breadcrumbs = scrubbed.breadcrumbs as
    | Array<Record<string, unknown>>
    | { values?: Array<Record<string, unknown>> }
    | undefined
  const crumbs = Array.isArray(breadcrumbs) ? breadcrumbs : (breadcrumbs?.values ?? [])
  for (const crumb of crumbs) {
    if (typeof crumb.message === 'string') crumb.message = redactFreeText(crumb.message)
  }
  return scrubbed as T
}

/**
 * The Sentry `environment` tag. Hosted staging and production both run with
 * NODE_ENV=production, so deriving the tag from NODE_ENV alone makes the two
 * indistinguishable. Precedence: an explicit SENTRY_ENVIRONMENT, then
 * the Railway-injected environment name, then NODE_ENV. Each candidate is
 * trimmed and a blank/whitespace-only value is treated as unset — a plain `??`
 * is insufficient because '' is not null/undefined and would otherwise be taken
 * as an authoritative empty environment.
 */
export function resolveSentryEnvironment(
  env: Pick<Env, 'SENTRY_ENVIRONMENT' | 'RAILWAY_ENVIRONMENT_NAME' | 'NODE_ENV'>,
): string {
  const norm = (value: string): string | undefined => {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  return norm(env.SENTRY_ENVIRONMENT) ?? norm(env.RAILWAY_ENVIRONMENT_NAME) ?? env.NODE_ENV
}

let initialized = false

/**
 * Error tracking + tracing, DSN-gated: an empty SENTRY_DSN means fully
 * disabled — no phone-home, the self-host default (§2). With a DSN, Sentry's
 * Node SDK boots its bundled OpenTelemetry SDK (auto-instrumentation for
 * http/pg/fetch) and exports spans to Sentry; release is tagged with the git
 * SHA. Explicit crash handlers either way: a worker crash is an event, not a
 * silent restart.
 *
 * METRIC EXPORT IS DELIBERATELY NOT WIRED YET (§3: instrumentation now, the
 * backend can wait — Sentry's metrics product was sunset, so counters need an
 * OTLP target chosen with the first deployable). metrics.ts instruments are
 * recorded against whatever global MeterProvider exists; until one is
 * registered they are API no-ops. Wiring it later is contained here: register
 * an @opentelemetry/sdk-metrics MeterProvider (PeriodicExportingMetricReader
 * + OTLP exporter) behind this same DSN/env gate — call sites never change,
 * and the provider-rebind test in metrics.test.ts proves instruments pick up
 * a provider installed after first use.
 */
export function initObservability(options: { release?: string } = {}): void {
  if (initialized) return
  initialized = true

  const env = loadEnv()
  if (env.SENTRY_DSN === '') {
    logger.info('observability: telemetry disabled (no SENTRY_DSN)')
    registerCrashHandlers(false)
    return
  }

  const release = options.release ?? (env.GIT_SHA || env.RAILWAY_GIT_COMMIT_SHA)
  const environment = resolveSentryEnvironment(env)
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment,
    ...(release === '' ? {} : { release }),
    // Solo-scale: sample everything; revisit before real traffic.
    tracesSampleRate: 1.0,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  })
  registerCrashHandlers(true)
  logger.info({ release, environment }, 'observability: Sentry + OTel enabled')
}

function registerCrashHandlers(sentryEnabled: boolean): void {
  process.on('unhandledRejection', (reason) => die('unhandledRejection', reason, sentryEnabled))
  process.on('uncaughtException', (error) => die('uncaughtException', error, sentryEnabled))
}

/**
 * Crash reasons are logged in a safe projection: an Error message built from
 * memory content (and the stack's first line, which repeats it verbatim)
 * would otherwise hit stdout on exactly the path where invariants break.
 * Frames locate the crash; message length+digest correlate it. The raw
 * exception still goes to captureException, but the beforeSend gate
 * (scrubSentryEvent) sanitizes its message before anything leaves the
 * process. Raw passthrough only in local dev.
 */
export function crashSafeError(cause: unknown): Record<string, unknown> {
  if (loadEnv().NODE_ENV === 'development') return { err: cause }
  if (cause instanceof Error) {
    return {
      err_type: cause.name,
      message_len: cause.message.length,
      message_sha256_8: contentDigest(cause.message),
      // V8 callsites only. Some drivers append SQL/params as non-frame stack
      // lines; those are free text and must not reach logs.
      stack_frames: safeStackFrames(cause.stack),
    }
  }
  if (typeof cause === 'string') {
    return { err_type: 'string', message_len: cause.length, message_sha256_8: contentDigest(cause) }
  }
  return { err_type: typeof cause }
}

function die(kind: string, cause: unknown, sentryEnabled: boolean): void {
  logger.fatal({ ...crashSafeError(cause), kind }, `fatal: ${kind}`)
  if (!sentryEnabled) {
    process.exit(1)
  }
  Sentry.captureException(cause)
  void Sentry.flush(2000).finally(() => process.exit(1))
}
