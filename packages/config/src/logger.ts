// SPDX-License-Identifier: Apache-2.0
import { type DestinationStream, type Logger, pino } from 'pino'
import { getContext, type RequestContext } from './context.js'
import { loadEnv } from './env.js'
import { redactDeep } from './redaction.js'

const CONTEXT_LOG_KEYS = {
  requestId: 'request_id',
  surface: 'surface',
  userIdHash: 'user_id',
  operation: 'operation',
  toolName: 'tool_name',
  sessionId: 'session_id',
  jobId: 'job_id',
  queue: 'queue',
  attempt: 'attempt',
} as const satisfies Record<keyof RequestContext, string>

/** camelCase context → snake_case log keys, mapped once here (docs/concepts/observability.mdx §1). */
export function contextBindings(ctx: RequestContext): Record<string, unknown> {
  const bindings: Record<string, unknown> = {}
  for (const [key, logKey] of Object.entries(CONTEXT_LOG_KEYS)) {
    const value = ctx[key as keyof RequestContext]
    if (value !== undefined) bindings[logKey] = value
  }
  return bindings
}

/**
 * Production logger config in one place; tests inject a sink to assert on the
 * exact JSON the real config emits.
 */
export function createLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      level: loadEnv().LOG_LEVEL,
      // Recursive redaction of the entire log object — any key, any depth,
      // arrays included. Serializers/redact-path allowlists were rejected:
      // they miss memory rows under unanticipated keys ({ results: rows }).
      formatters: {
        log: (object) => redactDeep(object) as Record<string, unknown>,
      },
    },
    destination,
  )
}

/** Root logger. Prefer log() at call sites so request context rides along. */
export const logger = createLogger()

// The destination log() resolves against. Defaults to the root logger; a test
// may rebind it to a capturable sink so a line emitted by code reaching the
// module-global log() (e.g. a route handler over real HTTP) is observable —
// the same createLogger(stream) precedent redaction.test.ts uses, lifted to the
// process-global call site that production transports actually use.
let rootLogger: Logger = logger

/**
 * Test-only seam: route every subsequent log() through `destination`. Pass
 * undefined to restore the production root logger. Never call this in
 * production code — it exists so a transport test can assert the structured
 * line a handler emits via log() without a DB-backed integration harness.
 */
export function setLogDestination(destination?: DestinationStream): void {
  rootLogger = destination === undefined ? logger : createLogger(destination)
}

/**
 * The call-site API: a child logger carrying the current AsyncLocalStorage
 * request context (request_id, surface, user_id hash, tool_name, ...).
 * Outside a request scope it falls back to the bare root logger.
 */
export function log(): Logger {
  const ctx = getContext()
  return ctx === undefined ? rootLogger : rootLogger.child(contextBindings(ctx))
}
