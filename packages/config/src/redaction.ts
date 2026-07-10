// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { loadEnv } from './env.js'

/**
 * Memory-content field names that must never reach logs, traces, or metrics
 * (docs/concepts/observability.mdx §1 red line; AGENTS.md hard rule 6). Both snake_case
 * (Drizzle rows) and camelCase (DTOs) spellings.
 */
export const REDACTED_FIELDS = [
  'answer',
  'body',
  'chunkContent',
  'chunk_content',
  'content',
  'embedding',
  'query',
  'queryText',
  'query_text',
  'summary',
  'text',
  'topic',
] as const

const REDACTED_FIELD_SET: ReadonlySet<string> = new Set(REDACTED_FIELDS)

export const REDACTED = '[redacted]'

/**
 * Raw memory content in logs is allowed only in local dev with the explicit
 * opt-in flag. The env schema already refuses the flag outside development at
 * boot; this re-check makes the redaction layer safe even if env parsing is
 * bypassed.
 */
export function debugContentEnabled(): boolean {
  const env = loadEnv()
  return env.LOG_DEBUG_CONTENT && env.NODE_ENV === 'development'
}

/** sha256(salt + id) → `u_` + 16 hex chars: correlation without identification (§1). */
export function hashUserId(userId: string): string {
  const env = loadEnv()
  const digest = createHash('sha256')
    .update(env.LOG_HASH_SALT + userId)
    .digest('hex')
  return `u_${digest.slice(0, 16)}`
}

/** 8-hex content fingerprint: correlation/dedup without disclosure. */
export function contentDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Redaction-by-construction for the whole log object: recursively strip every
 * known content field at any depth — including inside arrays under arbitrary
 * keys (`{ results: rows }`) — synthesizing `<key>_len` (and `<key>_sha256_8`
 * for strings) so dedup debugging stays possible without disclosure.
 * Non-plain objects (Error, Date, Buffer) pass through untouched; pino's own
 * serializers have already flattened errors by the time this runs.
 */
export function redactDeep(input: unknown): unknown {
  if (debugContentEnabled()) return input
  return walk(input)
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!REDACTED_FIELD_SET.has(key)) {
      out[key] = walk(entry)
      continue
    }
    if (typeof entry === 'string') {
      out[`${key}_len`] = entry.length
      out[`${key}_sha256_8`] = contentDigest(entry)
    } else if (Array.isArray(entry)) {
      out[`${key}_len`] = entry.length
    }
    // other shapes: dropped entirely
  }
  return out
}
