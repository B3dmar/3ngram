// SPDX-License-Identifier: Apache-2.0
// Node-side opaque encode/decode for the search frozen-ordering cursor,
// SHARED by the REST dashboard route (rest/router.ts) and the MCP search tool.
// The payload SHAPE (cursorPayloadSchema) is the shared contract in
// @3ngram/schema; the base64url serialization lives here so the schema package
// stays dependency-light (zod only — no @types/node for Buffer). Clients treat
// the token as opaque and never decode it (see lib/search/api.ts).
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
