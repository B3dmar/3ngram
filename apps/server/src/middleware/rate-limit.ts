// SPDX-License-Identifier: Apache-2.0
// Redis-backed rate limiting (per-IP on the OAuth/login endpoints).
//
// REUSABLE FACTORY: createRateLimiter({ points, duration, keyPrefix, ... })
// returns Express middleware backed by rate-limiter-flexible — RateLimiterRedis
// when an ioredis client is injected (cross-instance: Railway runs N replicas,
// so the bucket MUST live in Redis, not per-process), else RateLimiterMemory
// (local/CI parity, and the test seam — NO real Redis in CI).
//
// KEYING DIMENSIONS (docs/concepts/mcp-design.mdx "per-user + per-key"):
//   - /mcp  -> per-AUTHENTICATED-USER (req.userId, bound by oauthBearerAuth).
//   - /auth/login + future /oauth/* -> per-IP (req.ip — correct because app.ts
//     sets `trust proxy`, so this is the client address, not the Railway proxy).
//   - per-KEY (API-key id): the factory ACCEPTS an optional keyResolver so a
//     caller can compose a second bucket, but D4 wires NO per-key limiter:
//     /mcp is Bearer-ONLY (API keys never reach it) and apiKeyAuth sets only
//     req.userId (no req.apiKeyId reaches a limited route this slice). Per-key
//     limiting lands when A2's /api/* is limited (the documented follow-up that
//     also plumbs req.apiKeyId through api-key.ts). Building the seam now keeps
//     that follow-up additive.
//
// FAIL-OPEN on Redis-down (DECISION): rate limiting is protective, not
// correctness — a Redis outage must NOT take down the API. On a store error
// (distinct from a real over-limit rejection, which carries msBeforeNext) we log
// a REDACTED warning (never REDIS_URL, never a key) and call next(). The tradeoff
// is documented in the changeset; flip `failOpen: false` per-limiter if a future
// endpoint needs fail-closed.
//
// On limit exceeded: 429 with Retry-After (seconds) + a structured body
// { error: 'rate_limited' } and no further content (hard rule 5: thin transport).
import { log, rateLimitStoreFailure } from '@3ngram/config'
import type { NextFunction, Request, Response } from 'express'
import type { Redis } from 'ioredis'
import {
  type IRateLimiterOptions,
  type RateLimiterAbstract,
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterRes,
} from 'rate-limiter-flexible'

/** Resolve the bucket key for a request, or undefined to SKIP limiting it. */
export type KeyResolver = (req: Request) => string | undefined

/** The Express middleware shape the factory returns; the wiring seam injects it. */
export type RateLimiterMiddleware = (req: Request, res: Response, next: NextFunction) => void

/** Per-IP key: req.ip is the real client address because app.ts sets trust proxy. */
export const ipKey: KeyResolver = (req) => req.ip

/** Per-user key: the authenticated principal bound by the auth middleware. */
export const userIdKey: KeyResolver = (req) => req.userId

/**
 * Composite IP+prefix key for the /api/v1 pre-auth rate-limit bucket.
 * Reads the prefix segment of the `3ng_<prefix>_<secret>` header value so the
 * limiter fires BEFORE apiKeyAuth runs. Keying on IP+prefix (not prefix alone)
 * prevents a targeted-DoS: an attacker who knows the non-secret prefix cannot
 * exhaust the victim's bucket from a different IP — only their own IP:prefix
 * composite bucket is consumed. Returns undefined for Bearer/session paths (no
 * X-API-Key) or malformed keys (< 3 segments) so those requests skip the limiter.
 *
 * TRADE-OFF: a legitimate user that distributes requests across many IPs gets
 * separate buckets per IP (each up to the full limit); the protection is
 * per-source rather than global-per-key. This is the accepted design.
 */
export const apiKeyIdKey: KeyResolver = (req) => {
  // Prefer req.apiKeyId when already bound (post-auth paths); fall back to
  // parsing the raw header so the limiter also works before auth runs.
  const prefix =
    req.apiKeyId !== undefined
      ? req.apiKeyId
      : (() => {
          const raw = req.header('x-api-key')?.trim()
          if (raw === undefined || raw.length === 0) return undefined
          const segments = raw.split('_')
          return segments.length >= 3 ? segments[1] : undefined
        })()
  if (prefix === undefined) return undefined
  // Composite key: IP is the real client address because app.ts sets trust proxy.
  return req.ip !== undefined ? `${req.ip}:${prefix}` : prefix
}

export interface RateLimiterOptions {
  /** Allowed requests per `duration` window. */
  points: number
  /** Window length in seconds. */
  duration: number
  /**
   * Namespace for the Redis keys (e.g. 'mcp:user', 'oauth:ip'). Composes with the
   * resolved key as `<keyPrefix>:<key>` so independent buckets never collide.
   */
  keyPrefix: string
  /**
   * How to derive the bucket key from a request. Defaults to per-user (req.userId).
   * Use `ipKey` for unauthenticated endpoints. When it returns undefined the
   * request is NOT limited (e.g. an endpoint reached before identity is bound).
   */
  keyResolver?: KeyResolver
  /**
   * Redis client for a cross-instance store. When omitted the limiter uses an
   * in-process RateLimiterMemory (local dev + CI; tests inject nothing).
   */
  redis?: Redis | undefined
  /**
   * On a STORE failure (Redis unreachable), allow the request through (true,
   * default) or reject it 503-style via next(err) (false). Default fail-open:
   * availability over protection for a protective control.
   */
  failOpen?: boolean
}

/**
 * A real over-limit rejection carries `msBeforeNext`; a store/infra failure does
 * not look like that. rate-limiter-flexible rejects with a RateLimiterRes on
 * over-limit and with the underlying Error on a store failure — discriminate so
 * we only fail-open on the latter.
 */
function isOverLimit(rejection: unknown): rejection is RateLimiterRes {
  return (
    typeof rejection === 'object' &&
    rejection !== null &&
    'msBeforeNext' in rejection &&
    typeof (rejection as RateLimiterRes).msBeforeNext === 'number'
  )
}

/** Build the underlying limiter: Redis-backed when a client is present, else memory. */
function buildLimiter(options: RateLimiterOptions): RateLimiterAbstract {
  const base: IRateLimiterOptions = {
    points: options.points,
    duration: options.duration,
    keyPrefix: options.keyPrefix,
  }
  if (options.redis !== undefined) {
    return new RateLimiterRedis({ ...base, storeClient: options.redis })
  }
  return new RateLimiterMemory(base)
}

/**
 * Create rate-limiting Express middleware. Consumes one point per request for the
 * resolved key; over-limit yields 429 + Retry-After, a store failure fails open
 * (or closed when `failOpen: false`). Stateless and reusable across endpoints.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiterMiddleware {
  const limiter = buildLimiter(options)
  const resolveKey = options.keyResolver ?? userIdKey
  const failOpen = options.failOpen ?? true

  return (req, res, next): void => {
    const key = resolveKey(req)
    if (key === undefined) {
      // No principal/IP to key on — do not limit (e.g. identity not yet bound).
      next()
      return
    }
    limiter
      .consume(key)
      .then(() => next())
      .catch((rejection: unknown) => {
        if (isOverLimit(rejection)) {
          const retryAfterSeconds = Math.ceil(rejection.msBeforeNext / 1000)
          res.setHeader('Retry-After', String(retryAfterSeconds))
          res.status(429).json({ error: 'rate_limited' })
          return
        }
        // Store failure (Redis-down): the key/IP is identifying material and the
        // connection string is a credential — neither enters the log line or the
        // metric. key_prefix (the limiter/route class) is the only label.
        //
        // TRADEOFF (DECISION, see header): fail-open trades protection for
        // availability — a Redis outage with failOpen:true lets EVERY request
        // through, so brute-force throttling on /auth/login
        // silently lapses with no over-limit 429s to alert on. The counter below
        // is the alert signal that makes the outage observable: an operator can
        // react (or flip a specific limiter to failOpen:false to fail-closed,
        // which locks out that route during the outage — a conscious availability
        // call left to the operator, NOT defaulted here).
        rateLimitStoreFailure.add(1, { key_prefix: options.keyPrefix, fail_open: failOpen })
        log().warn({ keyPrefix: options.keyPrefix, failOpen }, 'rate-limit: store unavailable')
        if (failOpen) {
          next()
          return
        }
        res.status(503).json({ error: 'service_unavailable' })
      })
  }
}
