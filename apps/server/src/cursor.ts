// SPDX-License-Identifier: Apache-2.0
// Node-side opaque encode/decode for the search frozen-ordering cursor,
// SHARED by the REST dashboard route (rest/router.ts) and the MCP search tool.
// The payload SHAPE (cursorPayloadSchema) is the shared contract in
// @3ngram/schema; the base64url serialization lives here so the schema package
// stays dependency-light (zod only — no @types/node for Buffer). Clients treat
// the token as opaque and never decode it (see lib/search/api.ts).
import { createHash } from 'node:crypto'
import { type CursorPayload, cursorPayloadSchema, legacyCursorPayloadSchema } from '@3ngram/schema'

/** Serialize a cursor payload to an opaque base64url token. */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode + validate an opaque cursor token back to its v2 payload.
 *
 * Returns `undefined` for a legacy v1 keyset cursor (`{ s, id }`) minted before
 * the v2 deploy — the caller restarts at page 1 rather than erroring
 * mid-session across the deploy boundary. A genuinely malformed token (bad
 * base64/JSON, or a shape that is neither v2 nor v1) throws a ZodError, which
 * the transport maps to a validation failure (mapRestError -> 400 on REST) — a
 * forged or garbled cursor is client input, never a server crash.
 */
export function decodeCursor(token: string): CursorPayload | undefined {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    json = undefined
  }
  const v2 = cursorPayloadSchema.safeParse(json)
  if (v2.success) return v2.data
  if (legacyCursorPayloadSchema.safeParse(json).success) return undefined
  // Neither v2 nor a recognized legacy cursor → malformed client input (400).
  return cursorPayloadSchema.parse(json)
}

/**
 * A continuation cursor replayed against a DIFFERENT query/filter set than the
 * one that issued it. Typed invalid-input (client mistake): mapped to 400 on
 * REST (mapRestError) / invalid_input on MCP — NEVER silently paging the
 * frozen ids of the old search under the new query. The message carries no
 * query text (hard rule 6).
 */
export class CursorQueryMismatchError extends Error {
  constructor() {
    super('cursor was issued for a different query — omit the cursor to start a new search')
    this.name = 'CursorQueryMismatchError'
  }
}

/**
 * Canonicalize a filter value for hashing: Dates → ISO strings, object keys
 * sorted, `undefined` entries dropped (an absent filter and an omitted one are
 * the same filter set), and primitive arrays sorted (the only array-valued
 * filter, `memoryTypes`, is an OR-SET — order is not semantic).
 */
function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    const items = value.map(canonicalize)
    return items.every((item) => typeof item === 'string') ? [...(items as string[])].sort() : items
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

/**
 * Short stable fingerprint of a search: sha256 over the POST-PARSE query text
 * EXACTLY as given plus the canonicalized filter set, truncated to 16 hex
 * chars (64 bits — collision-safe for a mismatch GUARD, not an identifier).
 *
 * NO normalization of the query happens here — deliberately. Both transports
 * call this with the schema-PARSED query, and both query schemas `.trim()` at
 * the one validation boundary (searchQueryV3Schema via searchInputSchema for
 * the MCP tool; dashboardSearchQuerySchema for the REST route), so edge
 * whitespace is already gone by the time the text reaches core OR this hash.
 * Core then embeds that same post-parse text verbatim: the fingerprint hashes
 * EXACTLY what retrieval sees, and a second trim here could only ever DIVERGE
 * from embedding semantics, never align them. Inner whitespace and case
 * change the embedding — "find\nme" and "find me" are DIFFERENT searches and
 * must not fingerprint-collide (collapsing would let a changed query silently
 * reuse the old frozen ordering).
 *
 * Issuance freezes it into the cursor (`fp`); continuation recomputes it from
 * the CURRENT request and verifies via {@link decodeSearchCursor}. The query
 * text itself never leaves this function (hard rule 6: hash only).
 */
export function searchFingerprint(query: string, filters: Record<string, unknown>): string {
  const canonicalFilters = JSON.stringify(canonicalize(filters))
  return createHash('sha256').update(`${query}\n${canonicalFilters}`).digest('hex').slice(0, 16)
}

/**
 * Decode a search continuation token AND bind it to the current search:
 * {@link decodeCursor} semantics, plus — when the payload carries a
 * fingerprint — verification against the fingerprint of the CURRENT
 * query/filters, throwing {@link CursorQueryMismatchError} on mismatch.
 *
 * COMPATIBILITY (verify-when-present): a fingerprint-less v2 cursor minted
 * before `fp` existed decodes fine and is NOT rejected — verification applies
 * only to cursors that carry the binding. Both transports (REST dashboard
 * route and the MCP search tool) parse continuations through THIS entry point
 * so the binding cannot drift per transport.
 */
export function decodeSearchCursor(token: string, fingerprint: string): CursorPayload | undefined {
  const payload = decodeCursor(token)
  if (payload?.fp !== undefined && payload.fp !== fingerprint) {
    throw new CursorQueryMismatchError()
  }
  return payload
}
