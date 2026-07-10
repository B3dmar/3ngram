// SPDX-License-Identifier: Apache-2.0
// API-key authentication (auth C3). Reads `X-API-Key: 3ng_<prefix>_<secret>`,
// resolves it through the core api-key service, and binds the identity for the
// rest of the request — the SAME req.userId + log-context shape the Bearer
// `authenticate` middleware uses, so the two coexist transparently downstream.
//
// STATUS CONTRACT (for the capture-hook verify path):
//   200  valid key  -> identity bound, next() runs the route
//   401  missing / malformed / unknown / revoked key (UNIFORM, no enumeration)
//   503  resolver-or-DB failure
// The middleware MUST catch resolver/DB errors LOCALLY and emit 503 itself: the
// app.ts generic handler maps any uncaught error to 500, which would silently
// break this contract. So errors are handled here, not forwarded to next().
//
// The raw user id is attached to req.userId; only its HASH enters the log
// context (hard rule 6). The key, its hash, and the secret are never logged.
import { bindContext, hashUserId, log } from '@3ngram/config'
import { authenticateApiKey, touchApiKeyLastUsed } from '@3ngram/core/auth'
import type { NextFunction, Request, Response } from 'express'

const API_KEY_HEADER = 'x-api-key'

/**
 * Parse the prefix segment from a `3ng_<prefix>_<secret>` key string, or
 * return undefined when the format does not match (fewer than 3 underscore-
 * delimited segments). The raw key and secret are never logged; only the
 * parse failure event is recorded (hard rule 6).
 */
function parseApiKeyPrefix(key: string): string | undefined {
  const segments = key.split('_')
  // Expected: ['3ng', '<prefix>', '<secret...>'] — at least 3 segments.
  if (segments.length < 3) return undefined
  return segments[1]
}

/**
 * Authenticate the request via X-API-Key. On success binds req.userId + the
 * hashed id into the log context, fires a best-effort last_used_at stamp (never
 * blocking), and continues. A missing/garbage/unknown/revoked key is a uniform
 * 401; any resolver/DB failure is a 503 emitted here (never a leaked 500).
 *
 * Also sets req.apiKeyId to the key prefix segment (`3ng_<PREFIX>_<secret>`)
 * for use by the per-key rate-limiter bucket on /api/*. A malformed key
 * format is logged (redacted — no key material) but does NOT block the request;
 * req.userId is already bound and the route continues without a rate-limit key.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.header(API_KEY_HEADER)?.trim()
  if (key === undefined || key.length === 0) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  authenticateApiKey(key)
    .then((userId) => {
      if (userId === undefined) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      req.userId = userId
      bindContext({ userIdHash: hashUserId(userId) })
      // Bind the key prefix for the per-key rate-limiter bucket. A
      // malformed format is logged (no key material) and skipped;
      // userId is already bound so the route continues without a limiter key.
      const prefix = parseApiKeyPrefix(key)
      if (prefix !== undefined) {
        req.apiKeyId = prefix
      } else {
        log().warn({ keyHeader: API_KEY_HEADER }, 'api-key: malformed key format, no prefix bound')
      }
      // Fire-and-forget: the last_used_at write must not block the request, and
      // its failure must not surface to the client. Log a redacted warning only
      // (no key material — hard rule 6).
      touchApiKeyLastUsed(userId, key).catch((err: unknown) => {
        log().warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'api-key: last_used update failed',
        )
      })
      next()
    })
    .catch((err: unknown) => {
      // Resolver or DB failure: emit the 503 contract HERE. Forwarding to next()
      // would hit the generic 500 handler and break the capture-hook contract.
      log().error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'api-key: resolver unavailable',
      )
      res.status(503).json({ error: 'service_unavailable' })
    })
}
