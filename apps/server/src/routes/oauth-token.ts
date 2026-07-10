// SPDX-License-Identifier: Apache-2.0
// POST /oauth/token transport. Thin by
// contract: validate at the one boundary (tokenRequestSchema),
// authenticate the client, delegate the grant exchange to the core provider,
// shape the RFC 6749 response.
//
// CLIENT AUTH IS CUSTOM (by design): the SDK's authenticateClient
// middleware compares a PLAINTEXT secret against what the clients store
// returns — but our store never returns secret material (only the SHA-256 hash
// is at rest), so the SDK default cannot work. authenticateClientCredentials
// (core) hashes the presented secret and compares against the stored hash.
// SDK 1.29 reads client credentials from req.body ONLY, so a Basic-auth
// shim decodes `Authorization: Basic` into the body first (RFC 6749 §2.3.1) —
// that is how client_secret_basic (the RFC 7591 default) is honored.
//
// ERRORS ARE THE SDK'S TYPED ERRORS ONLY: every failure maps to
// an OAuthError subclass and its RFC 6749 response object — a generic Error
// becomes the opaque ServerError 500 and is logged crash-safe. Token, code,
// and secret material never enter a log line or an error body.
import { contentDigest, loadOAuthConfig, log } from '@3ngram/config'
import { crashSafeError } from '@3ngram/config/otel'
import type { LimitsResolver } from '@3ngram/core'
import {
  authenticateClientCredentials,
  createOAuthServerProvider,
  insertAuditLog,
  OAuthGrantError,
  ResourceLimitExceededError,
  touchClientLastUsed,
} from '@3ngram/core/auth'
import { type TokenEndpointAuthMethod, tokenRequestSchema } from '@3ngram/schema'
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
  OAuthError,
  ServerError,
  UnsupportedGrantTypeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import { type NextFunction, type Request, type Response, Router, urlencoded } from 'express'
import type { Redis } from 'ioredis'
import type { RateLimiterMiddleware } from '../middleware/rate-limit.js'

/**
 * Options the boot wiring injects:
 * - `limiter` — the per-IP rate limiter seam.
 * - `redis`  — the shared ioredis client. When present the
 *   progressive-delay failure counter lives in Redis so the budget is shared
 *   across Railway replicas; when absent it falls back to a per-process Map
 *   (single-instance / CI parity, mirroring the rate-limiter's memory fallback).
 */
export interface OAuthTokenRouterOptions {
  limiter: RateLimiterMiddleware
  redis?: Redis | undefined
  /** Billing-neutral active-client limit resolver. */
  limits?: LimitsResolver | undefined
}

/** Which channel carried the client credentials — used to enforce the registered method. */
const PRESENTED_AUTH_METHOD = Symbol('presentedAuthMethod')

/**
 * Set by the shim when the presented client authentication is itself
 * malformed (an unparseable Basic header, or a Basic identity that conflicts
 * with a posted client_id). The handler turns this into a uniform
 * invalid_client BEFORE any schema/provider work so the failure is no oracle.
 */
const CLIENT_AUTH_INVALID = Symbol('clientAuthInvalid')

type TaggedRequest = Request & {
  [PRESENTED_AUTH_METHOD]?: TokenEndpointAuthMethod
  [CLIENT_AUTH_INVALID]?: true
}

/** Read the channel the shim attributed the credentials to (undefined = public/none). */
function presentedAuthMethod(req: Request): TokenEndpointAuthMethod | undefined {
  return (req as TaggedRequest)[PRESENTED_AUTH_METHOD]
}

/** True when the shim already determined the presented client auth is invalid. */
function clientAuthIsInvalid(req: Request): boolean {
  return (req as TaggedRequest)[CLIENT_AUTH_INVALID] === true
}

/** Decode an `Authorization: Basic` header into client_id/client_secret, or undefined when malformed. */
function decodeBasicCredentials(
  header: string,
): { clientId: string; clientSecret: string } | undefined {
  let decoded: string
  try {
    decoded = Buffer.from(header.slice('basic '.length).trim(), 'base64').toString('utf8')
  } catch {
    return undefined
  }
  const sep = decoded.indexOf(':')
  // RFC 6749 §2.3.1: both fields are present and the separator is a colon, so a
  // non-empty client_id (username) before the first colon is required.
  if (sep <= 0) return undefined
  // RFC 6749 §2.3.1 form-encodes both fields, but a client may present invalid
  // percent-encoding (e.g. a bare `%` or `%ZZ`); decodeURIComponent throws a
  // URIError on those. Treat them as a malformed Basic header (invalid_client),
  // not a generic 500, so the failure stays a uniform OAuth error / no oracle.
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, sep)),
      clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
    }
  } catch {
    return undefined
  }
}

/**
 * RFC 6749 §2.3.1 / §3.2.1 client-authentication shim (S4). The SDK reads
 * credentials from req.body only, so this normalizes every accepted channel
 * into the body the schema validates AND attributes the presented method so the
 * auth step can enforce the registered token_endpoint_auth_method:
 *
 *   - `Authorization: Basic` present → ALWAYS decode it; the username is
 *     client_id, the password is client_secret, method = client_secret_basic.
 *     RFC 6749 §3.2.1 lets a client ALSO post client_id, so a posted client_id
 *     that MATCHES the Basic username is accepted; a CONFLICTING one is rejected
 *     (§2.3: a client MUST NOT use more than one authentication method).
 *   - No Basic header, body carries client_secret → client_secret_post.
 *   - No Basic header, body carries only client_id → the public / client_id-as
 *     -parameter path (§3.2.1): no secret presented, method left undefined; the
 *     auth step admits this ONLY for clients registered 'none' (PKCE enforced
 *     upstream).
 *   - A malformed Basic header (not base64 / no colon) → marked invalid_client;
 *     it never silently falls through to a different method.
 */
function shimBasicAuth(req: Request, _res: Response, next: NextFunction): void {
  const tagged = req as TaggedRequest
  const header = req.header('authorization')
  // An empty POST or an unsupported Content-Type leaves req.body undefined;
  // default to {} so the schema (not a dereference crash) reports the failure
  // as invalid_request (400) rather than a generic ServerError (500).
  const body = (req.body ?? {}) as Record<string, unknown>
  const hasBasic = header?.toLowerCase().startsWith('basic ') === true

  if (!hasBasic) {
    // No Authorization: Basic — a body-carried secret is client_secret_post;
    // a body with only client_id is the public / §3.2.1 parameter path.
    if (typeof body.client_secret === 'string') tagged[PRESENTED_AUTH_METHOD] = 'client_secret_post'
    next()
    return
  }

  const credentials = decodeBasicCredentials(header)
  if (credentials === undefined) {
    // Malformed Basic header: do NOT fall through to another method.
    tagged[CLIENT_AUTH_INVALID] = true
    next()
    return
  }
  // RFC 6749 §3.2.1 + §2.3: a posted client_id may accompany Basic, but it MUST
  // identify the same client — a conflicting identity is invalid_client.
  if (typeof body.client_id === 'string' && body.client_id !== credentials.clientId) {
    tagged[CLIENT_AUTH_INVALID] = true
    next()
    return
  }
  body.client_id = credentials.clientId
  body.client_secret = credentials.clientSecret
  tagged[PRESENTED_AUTH_METHOD] = 'client_secret_basic'
  next()
}

// ---------------------------------------------------------------------------
// Progressive delay on repeated failed token exchanges (Redis-backed).
//
// The failure counter is keyed `oauth:exchange-failure:{client_id}` and lives in
// Redis (INCR + EXPIRE) so the budget is SHARED across Railway replicas — the
// per-process Map gave each replica its own budget, defeatable by
// rotating exchanges across replicas. When no Redis client is injected
// (single-instance / CI) the tracker falls back to an in-process Map, mirroring
// the rate-limiter's RateLimiterMemory fallback.
//
// FAIL-OPEN on Redis-down (DECISION, mirrors rate-limit.ts): the progressive
// delay is a protective control, not correctness — a Redis outage must NOT take
// down the token endpoint. recordExchangeFailure swallows store errors (the
// counter simply does not advance) and applyProgressiveDelay treats a store
// failure as "no recorded failures" (count 0, no delay). The connection string
// is a credential and client_id is identifying material — neither enters a log
// line; only the redacted error name is logged.
//
// RESET TTL (DECISION): every recordExchangeFailure (re)sets a 900s (15-minute)
// sliding EXPIRE on the counter. This auto-forgives a client that stops failing
// for 15 minutes (a legitimate client whose config is fixed recovers without a
// successful exchange) while keeping the delay ramped across a sustained attack
// burst. A successful exchange clears the counter immediately. On the Redis
// path the INCR + EXPIRE run in ONE MULTI/EXEC, so the EXPIRE always lands with
// the INCR (a crash between them can never leave a TTL-less key) and growth stays
// bounded: Redis reclaims idle keys on expiry, so attacker-enumerated client_ids
// cannot accumulate unbounded. The no-Redis Map
// fallback has no TTL, so it retains the 10k-entry FIFO eviction cap
// (EXCHANGE_FAILURES_MAX) to keep the same DoS bound on single-instance deploys.
// ---------------------------------------------------------------------------

const DELAY_THRESHOLD = 3
const MAX_DELAY_MS = 8000
// Sliding reset window: a counter with no new failure for this many seconds
// expires, forgiving the client. Refreshed on every recorded failure.
const FAILURE_RESET_TTL_SECONDS = 900
const EXCHANGE_FAILURE_KEY_PREFIX = 'oauth:exchange-failure:'
// Hard cap on tracked client_ids in the in-process Map fallback (no-Redis
// path). The Redis path is bounded by the sliding EXPIRE, but the Map has no
// TTL, so an attacker enumerating schema-valid client_ids could otherwise drive
// unbounded heap growth. Evict the oldest insertion at the cap (Map
// preserves insertion order). The Redis path keeps the EXPIRE-based bound.
const EXCHANGE_FAILURES_MAX = 10_000

/** Redis key for a client_id's failure counter (client_id is never logged). */
function exchangeFailureKey(clientId: string): string {
  return `${EXCHANGE_FAILURE_KEY_PREFIX}${clientId}`
}

/**
 * The per-process fallback counter used when no Redis client is injected
 * (single-instance / CI). Exported for test inspection of the fallback path
 * only — the Redis path is exercised via an injected ioredis-mock client.
 */
export const _exchangeFailures = new Map<string, number>()

/**
 * The injected failure-tracker Redis client, or undefined for the in-process
 * fallback. Set once by oauthTokenRouter at boot; the tracker functions read it
 * so the wiring stays a single injection seam (testable with ioredis-mock).
 */
let exchangeFailureRedis: Redis | undefined

/** Wire the failure-tracker Redis client (or clear it for the Map fallback). */
export function setExchangeFailureRedis(redis: Redis | undefined): void {
  exchangeFailureRedis = redis
}

/** Increment the failure counter for a client_id and refresh its reset TTL. */
export async function recordExchangeFailure(clientId: string): Promise<void> {
  if (exchangeFailureRedis === undefined) {
    // Enforce the cap before inserting a NEW key: drop the oldest insertion so
    // attacker-enumerated client_ids cannot grow the Map without bound. An
    // existing key just increments (no size change).
    if (!_exchangeFailures.has(clientId) && _exchangeFailures.size >= EXCHANGE_FAILURES_MAX) {
      const oldest = _exchangeFailures.keys().next().value
      if (oldest !== undefined) _exchangeFailures.delete(oldest)
    }
    _exchangeFailures.set(clientId, (_exchangeFailures.get(clientId) ?? 0) + 1)
    return
  }
  try {
    const key = exchangeFailureKey(clientId)
    // INCR then EXPIRE in ONE MULTI/EXEC: MULTI queues both commands and EXEC
    // runs them atomically server-side, so the key ALWAYS gets its TTL even if
    // the connection drops mid-sequence. This preserves the bounded-growth
    // guarantee — a crash between INCR and EXPIRE can no longer leave a key with
    // no TTL (otherwise an attacker enumerating client_ids grows the keyspace
    // unbounded). The EXPIRE is re-set on every failure so the window slides.
    const results = await exchangeFailureRedis
      .multi()
      .incr(key)
      .expire(key, FAILURE_RESET_TTL_SECONDS)
      .exec()
    // exec() resolves to null only when the transaction was discarded (e.g. a
    // WATCH conflict — none here), and otherwise an array of [err, reply] tuples.
    // Surface a per-command error so the catch swallows it as a record failure
    // (fail-open) rather than silently advancing without the TTL.
    const commandError = results?.find(([err]) => err !== null)?.[0]
    if (commandError) throw commandError
  } catch (err: unknown) {
    log().warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'oauth: exchange-failure record failed',
    )
  }
}

/** Clear the failure counter for a client_id (a successful exchange forgives it). */
export async function clearExchangeFailures(clientId: string): Promise<void> {
  if (exchangeFailureRedis === undefined) {
    _exchangeFailures.delete(clientId)
    return
  }
  try {
    await exchangeFailureRedis.del(exchangeFailureKey(clientId))
  } catch (err: unknown) {
    log().warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'oauth: exchange-failure clear failed',
    )
  }
}

/** Read the current failure count for a client_id (0 on store failure — fail-open). */
async function readExchangeFailureCount(clientId: string): Promise<number> {
  if (exchangeFailureRedis === undefined) {
    return _exchangeFailures.get(clientId) ?? 0
  }
  try {
    const raw = await exchangeFailureRedis.get(exchangeFailureKey(clientId))
    if (raw === null) return 0
    const count = Number.parseInt(raw, 10)
    return Number.isNaN(count) ? 0 : count
  } catch (err: unknown) {
    log().warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'oauth: exchange-failure read failed',
    )
    return 0
  }
}

export async function applyProgressiveDelay(clientId: string): Promise<void> {
  const count = await readExchangeFailureCount(clientId)
  if (count < DELAY_THRESHOLD) return
  const ms = Math.min(1000 * 2 ** (count - DELAY_THRESHOLD), MAX_DELAY_MS)
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// First N chars of a client_id we are willing to log. redaction.ts does NOT
// cover client_id, so the truncation is the load-bearing secret safeguard: a
// client_secret_basic credential can carry a long opaque id, and we never want
// the full value (or any code/secret/refresh_token) in a log line (hard rule 6).
const CLIENT_ID_PREFIX_LEN = 8

/**
 * A non-throwing, content-free preview of the presented client_id for the audit
 * line. Legitimate ids are long (`cl_` + uuid), so the first 8 chars are a safe,
 * human-readable strict prefix. But the value is read raw off req.body on the
 * error path: a SHORT (<= 8 char) client-controlled value would be echoed in
 * full, leaking short secret/token material a malformed request could smuggle
 * in. For those, emit a non-reversible `sha8:` fingerprint (the redaction.ts
 * sha256-8 convention) that can NEVER equal the raw input. '(none)' when absent.
 */
function clientIdPrefix(clientId: unknown): string {
  if (typeof clientId !== 'string' || clientId.length === 0) return '(none)'
  if (clientId.length <= CLIENT_ID_PREFIX_LEN) return `sha8:${contentDigest(clientId)}`
  return clientId.slice(0, CLIENT_ID_PREFIX_LEN)
}

// The only grant_type values RFC 6749 §4.1.3/§6 lets this server log verbatim.
// On the error path grant_type is raw, client-controlled body data that could
// carry a code/refresh_token/secret, so anything else collapses to '(invalid)'
// (or '(none)' when absent) before it reaches a log line (hard rule 6).
const LOGGABLE_GRANT_TYPES = new Set(['authorization_code', 'refresh_token'])

/**
 * A non-throwing, whitelisted preview of the presented grant_type for the audit
 * line: a known RFC token verbatim, '(none)' when absent, '(invalid)' for any
 * other client-controlled value. NEVER echoes unbounded body data (hard rule 6).
 */
function grantTypeLabel(grantType: unknown): string {
  if (grantType === undefined) return '(none)'
  return typeof grantType === 'string' && LOGGABLE_GRANT_TYPES.has(grantType)
    ? grantType
    : '(invalid)'
}

/**
 * ONE structured, content-free line per /oauth/token request. grant_type
 * is whitelisted to an RFC token (not secret); client_id is truncated to a
 * prefix here; outcome is 'success' or the RFC error code. No token/code/secret/
 * full client_id ever enters this line (hard rule 6). Rides the request-context
 * bindings via log().
 */
function logTokenOutcome(grantType: unknown, clientId: unknown, outcome: string): void {
  log().info(
    {
      grant_type: grantTypeLabel(grantType),
      client_id_prefix: clientIdPrefix(clientId),
      outcome,
    },
    'oauth: token endpoint',
  )
}

/** Map a thrown failure to the SDK's typed OAuthError (generic -> ServerError 500). */
export function toOAuthError(err: unknown): OAuthError {
  if (err instanceof OAuthError) return err
  if (err instanceof ResourceLimitExceededError) {
    return new InvalidGrantError('Active MCP client limit reached')
  }
  if (err instanceof OAuthGrantError) {
    switch (err.code) {
      case 'invalid_grant':
        return new InvalidGrantError('The provided grant is invalid, expired, or revoked')
      case 'invalid_client':
        return new InvalidClientError('Client authentication failed')
      case 'invalid_target':
        return new InvalidTargetError('The requested resource is not served by this server')
      case 'invalid_token':
        return new InvalidTokenError('The access token is invalid')
    }
  }
  return new ServerError('Internal Server Error')
}

/**
 * RFC 6749 §3.2/§4.1.3: the token endpoint accepts ONLY a
 * application/x-www-form-urlencoded body. A global express.json() parses a JSON
 * body before this router runs, so a presented Content-Type other than form
 * (notably application/json) must be rejected here — otherwise the route's own
 * urlencoded() middleware is a no-op and a pre-parsed JSON object would be
 * validated as a token request. An ABSENT Content-Type (an empty POST) is left
 * to the missing-grant_type path so it stays the documented invalid_request.
 */
function rejectsNonFormContentType(req: Request): boolean {
  const contentType = req.headers['content-type']
  if (contentType === undefined) return false
  return req.is('application/x-www-form-urlencoded') !== 'application/x-www-form-urlencoded'
}

/** Dispatch a validated, client-authenticated grant to the core provider. */
async function handleTokenRequest(
  req: Request,
  res: Response,
  limits: LimitsResolver | undefined,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store')
  // RFC 6749 §5.1 also mandates Pragma: no-cache on token-bearing responses.
  res.setHeader('Pragma', 'no-cache')
  if (rejectsNonFormContentType(req)) {
    throw new InvalidRequestError('The token endpoint requires application/x-www-form-urlencoded')
  }
  // A malformed Basic header or a Basic identity conflicting with a posted
  // client_id is a failed client authentication (RFC 6749 §2.3/§3.2.1) — a
  // uniform invalid_client with no oracle, decided before any schema/provider work.
  if (clientAuthIsInvalid(req)) throw new InvalidClientError('Client authentication failed')
  const body = (req.body ?? {}) as Record<string, unknown>
  // RFC 6749 §5.2: a request missing required parameters is invalid_request.
  // An absent grant_type (e.g. an empty body) is a malformed request, distinct
  // from a PRESENT-but-unrecognized grant_type (unsupported_grant_type).
  if (body.grant_type === undefined) throw new InvalidRequestError('Malformed token request')
  if (body.grant_type !== 'authorization_code' && body.grant_type !== 'refresh_token') {
    throw new UnsupportedGrantTypeError('The grant type is not supported by this server')
  }
  const parsed = tokenRequestSchema.safeParse(body)
  if (!parsed.success) throw new InvalidRequestError('Malformed token request')
  const input = parsed.data
  // Apply progressive delay before the grant exchange. The delay is keyed on
  // client_id (never logged) and ramps after DELAY_THRESHOLD
  // repeated failures tracked in Redis, so the budget is shared across replicas.
  await applyProgressiveDelay(input.client_id)
  const client = await authenticateClientCredentials(
    input.client_id,
    input.client_secret,
    presentedAuthMethod(req),
  )
  if (client === undefined) {
    await recordExchangeFailure(input.client_id)
    throw new InvalidClientError('Client authentication failed')
  }
  // COMPILE PIN: the core provider must remain assignable to the SDK 1.29
  // OAuthServerProvider (the A2 contract the structural mirror promises).
  const provider: OAuthServerProvider = createOAuthServerProvider(loadOAuthConfig(), limits)
  const resource = input.resource === undefined ? undefined : new URL(input.resource)
  let tokens: Awaited<ReturnType<typeof provider.exchangeAuthorizationCode>>
  try {
    tokens =
      input.grant_type === 'authorization_code'
        ? await provider.exchangeAuthorizationCode(
            client,
            input.code,
            input.code_verifier,
            input.redirect_uri,
            resource,
          )
        : await provider.exchangeRefreshToken(
            client,
            input.refresh_token,
            input.scope?.split(' '),
            resource,
          )
  } catch (exchangeErr) {
    if (!(exchangeErr instanceof ResourceLimitExceededError)) {
      await recordExchangeFailure(input.client_id)
    }
    throw exchangeErr
  }
  await clearExchangeFailures(input.client_id)
  // Fire-and-forget: stamp last_used_at so the client escapes the 30-day idle GC.
  // Must never block the exchange; its rejection is logged redacted.
  touchClientLastUsed(input.client_id).catch((err: unknown) => {
    log().warn({ err: err instanceof Error ? err.name : 'unknown' }, 'oauth: client touch failed')
  })
  // Fire-and-forget: audit the successful token issuance. NEVER include the raw
  // token, code, client_secret, or refresh_token — only the client_id.
  insertAuditLog({
    actorKind: 'system',
    action: 'token.issue',
    resource: input.client_id,
    ...(req.ip !== undefined ? { ip: req.ip } : {}),
  }).catch((err: unknown) => {
    log().warn({ err: err instanceof Error ? err.name : 'unknown' }, 'audit: token.issue failed')
  })
  logTokenOutcome(input.grant_type, input.client_id, 'success')
  res.status(200).json(tokens)
}

/** Build the /oauth/token router behind the injected per-IP limiter. */
export function oauthTokenRouter(options: OAuthTokenRouterOptions): Router {
  // Wire the failure-tracker store: the shared ioredis client (cross-replica
  // budget) when injected, else the in-process Map fallback.
  setExchangeFailureRedis(options.redis)
  const router = Router()
  router.post(
    '/oauth/token',
    options.limiter,
    urlencoded({ extended: false }),
    shimBasicAuth,
    (req, res) => {
      handleTokenRequest(req, res, options.limits).catch((err: unknown) => {
        const oauthError = toOAuthError(err)
        const body = (req.body ?? {}) as Record<string, unknown>
        // outcome IS the mapped RFC error code (invalid_grant|invalid_client|
        // invalid_request|unsupported_grant_type|server_error) — docs/concepts/observability.mdx
        // wants the same vocabulary the client sees in the response body.
        logTokenOutcome(body.grant_type, body.client_id, oauthError.errorCode)
        if (oauthError instanceof ServerError) {
          log().error(crashSafeError(err), 'oauth: token endpoint failure')
        }
        // RFC 6749 §5.2: a failed client authentication is 401, not 400; and
        // when the client authenticated via the Authorization header, the
        // response MUST carry a matching WWW-Authenticate challenge.
        if (oauthError instanceof InvalidClientError) {
          if (req.header('authorization')?.toLowerCase().startsWith('basic ') === true) {
            res.setHeader('WWW-Authenticate', 'Basic realm="oauth"')
          }
          res.status(401).json(oauthError.toResponseObject())
          return
        }
        res
          .status(oauthError instanceof ServerError ? 500 : 400)
          .json(oauthError.toResponseObject())
      })
    },
  )
  return router
}
