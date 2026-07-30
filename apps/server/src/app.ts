// SPDX-License-Identifier: Apache-2.0
import {
  budgetGateLookupFailure,
  loadBudgetConfig,
  loadLlmGatewayConfig,
  log,
} from '@3ngram/config'
import { crashSafeError } from '@3ngram/config/otel'
import { allowAllAccess, type BudgetEnforcement, SELFHOST_LIMITS } from '@3ngram/core'
import { ClientMetadataResolver } from '@3ngram/core/auth'
import { createOpenAIGateway, type Gateway } from '@3ngram/llm'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Redis } from 'ioredis'
import { baseCapabilities, type Extension, noOpExtension } from './composition/extension.js'
import {
  apiKeyIdKey,
  createRateLimiter,
  ipKey,
  type RateLimiterMiddleware,
  userIdKey,
} from './middleware/rate-limit.js'
import { requestContext } from './middleware/request-context.js'
import { resolveRedis } from './redis.js'
import { restRouter } from './rest/router.js'
import { apiKeysRouter } from './routes/api-keys.js'
import { authRouter } from './routes/auth.js'
import { capabilitiesRouter } from './routes/capabilities.js'
import { healthRouter } from './routes/health.js'
import { mcpRouter } from './routes/mcp.js'
import { oauthAuthorizeRouter } from './routes/oauth-authorize.js'
import { oauthClientsRouter } from './routes/oauth-clients.js'
import { oauthRegisterRouter } from './routes/oauth-register.js'
import { oauthTokenRouter } from './routes/oauth-token.js'
import { onboardingRouter } from './routes/onboarding.js'
import { profileRouter } from './routes/profile.js'
import { wellKnownRouter } from './routes/well-known.js'

// Re-export the composition seam type via the side-effect-free `./app`
// subpath so the private repo can type its extension against the
// Apache contract without importing a server internal path.
export type { Extension } from './composition/extension.js'

/**
 * Public composition compatibility sentinel. A downstream extension may require
 * this literal before booting to ensure its resource-limit fields are enforced.
 * This declares runtime capability only; it encodes no plans or limit values.
 */
export const RESOURCE_LIMITS_ENFORCED = true as const

/** App-factory options. The gateway seam lets tests inject a fake; boot derives it from env. */
export interface AppOptions {
  /**
   * Embedding gateway for the MCP tools. When omitted, it is derived from env
   * (env-gated): a real OpenAI-compatible client iff LLM_GATEWAY_URL +
   * LLM_GATEWAY_API_KEY are set, else undefined (search returns a typed
   * "not configured" error and remember runs with embedding off).
   */
  gateway?: Gateway
  /**
   * Rate-limiter seam. When omitted, boot builds Redis-backed limiters
   * iff REDIS_URL is set (else in-memory). Tests inject limiters directly so NO
   * real Redis is required in CI:
   * - `mcpLimiter`  — per-user bucket on /mcp (req.userId, set by oauthBearerAuth).
   * - `authLimiter` — per-IP bucket on /auth/login (req.ip is the
   *   real client because trust proxy is set).
   * Provide `redis` instead to let boot construct the default limiters over an
   * explicit client (or omit both for the env-derived client).
   */
  mcpLimiter?: RateLimiterMiddleware
  authLimiter?: RateLimiterMiddleware
  /**
   * Coarse per-IP bucket for every non-health HTTP surface. This bounds database
   * work on session-authenticated management routes and adds defense in depth
   * around the narrower auth/OAuth/MCP/API-key buckets below. Defaults to
   * 600 requests / 60s and shares the resolved Redis client across replicas.
   */
  edgeLimiter?: RateLimiterMiddleware
  /**
   * Per-IP buckets for the five public self-serve auth endpoints. Each
   * carries its own threshold (signup 5/min, resend-verification 3/min,
   * verify-email 10/min, forgot-password 3/min, reset-password 5/min) keyed on
   * req.ip; the shared `authLimiter` still guards /auth/login + change-password.
   * Tests inject these directly (no Redis); when omitted boot builds the defaults.
   */
  signupLimiter?: RateLimiterMiddleware
  resendVerificationLimiter?: RateLimiterMiddleware
  verifyEmailLimiter?: RateLimiterMiddleware
  forgotPasswordLimiter?: RateLimiterMiddleware
  resetPasswordLimiter?: RateLimiterMiddleware
  /**
   * Per-IP limiter for POST /oauth/register. Defaults to a
   * conservative per-IP bucket built like the two above — /oauth/register is
   * unauthenticated, so it must never ship unlimited. Tuning it is an
   * injection-only change.
   */
  registerLimiter?: RateLimiterMiddleware
  /**
   * Per-IP limiter shared by GET/POST /oauth/authorize and POST /oauth/token
   * (both are unauthenticated surfaces, so a real conservative
   * bucket is the default, mirroring registerLimiter). Tuning it is an
   * injection-only change (incl. failed-exchange progressive delay).
   */
  oauthLimiter?: RateLimiterMiddleware
  /**
   * Shared CIMD resolver/cache. Tests inject a networkless resolver; production
   * gets one bounded SSRF-safe instance per app process.
   */
  clientMetadataResolver?: ClientMetadataResolver
  /**
   * Per-API-key limiter on /api/v1. Keyed on req.apiKeyId (the prefix
   * segment set by apiKeyAuth after a successful key lookup). Mounted before
   * apiOrSessionAuth so the cheap bucket runs as the first gate; requests that
   * carry no X-API-Key (and thus have no req.apiKeyId) skip the limiter.
   * Default: 300 req / 60s per key.
   */
  apiKeyLimiter?: RateLimiterMiddleware
  redis?: Redis | undefined
  /**
   * Composition seam. When omitted, resolves to `noOpExtension` — the self-host
   * default: zero hosted-only capabilities, no extra routes. The real extension is
   * injected ONLY from the private repo's entrypoint; no Apache package imports it.
   * The boundary is package absence, never a flag.
   */
  extension?: Extension
}

/**
 * Per-user bucket on /mcp: 120 requests / 60s. Per-IP on /auth/login: 10 / 60s.
 * Per-IP on /oauth/register: 10 / 60s — registration is a rare, one-time-per-
 * client operation, so a tight bucket bounds the unauthenticated insert path
 * (~33KB/request worst case) without blocking legitimate DCR retries.
 * Per-API-key on /api/v1: 300 req / 60s — a generous ceiling for normal programmatic
 * use while bounding runaway agents or credential-stuffing.
 */
const MCP_USER_POINTS = 120
const AUTH_IP_POINTS = 10
const EDGE_IP_POINTS = 600
// Per-endpoint thresholds (per source IP, per RATE_WINDOW_SECONDS). The
// public self-serve surface is more abuse-prone than login, so each endpoint
// gets its own tight bucket instead of the shared 10/min login bucket.
const SIGNUP_IP_POINTS = 5
const RESEND_VERIFICATION_IP_POINTS = 3
const VERIFY_EMAIL_IP_POINTS = 10
const FORGOT_PASSWORD_IP_POINTS = 3
const RESET_PASSWORD_IP_POINTS = 5
const REGISTER_IP_POINTS = 10
// /oauth/authorize + /oauth/token share one per-IP bucket: a full code flow is
// ~3 requests (form GET, consent POST, exchange) plus periodic refreshes, so
// 30/60s bounds abuse without throttling a legitimate multi-client login burst.
const OAUTH_IP_POINTS = 30
const API_KEY_POINTS = 300
const RATE_WINDOW_SECONDS = 60

/** Resolve the embedding gateway: an explicit override, else the env-gated client. */
function resolveGateway(override: Gateway | undefined): Gateway | undefined {
  if (override !== undefined) return override
  const config = loadLlmGatewayConfig()
  return config === undefined ? undefined : createOpenAIGateway(config)
}

/**
 * Resolve the rate limiters: explicit overrides win (the test seam), else build
 * the defaults over the injected/env Redis client. Mirrors resolveGateway: a
 * missing Redis client makes createRateLimiter fall back to RateLimiterMemory.
 */
function resolveLimiters(
  options: AppOptions,
  redis: Redis | undefined,
): {
  mcpLimiter: RateLimiterMiddleware
  authLimiter: RateLimiterMiddleware
  edgeLimiter: RateLimiterMiddleware
  signupLimiter: RateLimiterMiddleware
  resendVerificationLimiter: RateLimiterMiddleware
  verifyEmailLimiter: RateLimiterMiddleware
  forgotPasswordLimiter: RateLimiterMiddleware
  resetPasswordLimiter: RateLimiterMiddleware
  registerLimiter: RateLimiterMiddleware
  oauthLimiter: RateLimiterMiddleware
  apiKeyLimiter: RateLimiterMiddleware
} {
  return {
    edgeLimiter:
      options.edgeLimiter ??
      createRateLimiter({
        points: EDGE_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'edge:ip',
        keyResolver: ipKey,
        redis,
      }),
    mcpLimiter:
      options.mcpLimiter ??
      createRateLimiter({
        points: MCP_USER_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'mcp:user',
        keyResolver: userIdKey,
        redis,
      }),
    authLimiter:
      options.authLimiter ??
      createRateLimiter({
        points: AUTH_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'auth:ip',
        keyResolver: ipKey,
        redis,
      }),
    signupLimiter:
      options.signupLimiter ??
      createRateLimiter({
        points: SIGNUP_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'auth:signup:ip',
        keyResolver: ipKey,
        redis,
      }),
    resendVerificationLimiter:
      options.resendVerificationLimiter ??
      createRateLimiter({
        points: RESEND_VERIFICATION_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'auth:resend-verification:ip',
        keyResolver: ipKey,
        redis,
      }),
    verifyEmailLimiter:
      options.verifyEmailLimiter ??
      createRateLimiter({
        points: VERIFY_EMAIL_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'auth:verify-email:ip',
        keyResolver: ipKey,
        redis,
      }),
    forgotPasswordLimiter:
      options.forgotPasswordLimiter ??
      createRateLimiter({
        points: FORGOT_PASSWORD_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'auth:forgot-password:ip',
        keyResolver: ipKey,
        redis,
      }),
    resetPasswordLimiter:
      options.resetPasswordLimiter ??
      createRateLimiter({
        points: RESET_PASSWORD_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'auth:reset-password:ip',
        keyResolver: ipKey,
        redis,
      }),
    registerLimiter:
      options.registerLimiter ??
      createRateLimiter({
        points: REGISTER_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'oauth:register:ip',
        keyResolver: ipKey,
        redis,
      }),
    oauthLimiter:
      options.oauthLimiter ??
      createRateLimiter({
        points: OAUTH_IP_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'oauth:as:ip',
        keyResolver: ipKey,
        redis,
      }),
    apiKeyLimiter:
      options.apiKeyLimiter ??
      createRateLimiter({
        points: API_KEY_POINTS,
        duration: RATE_WINDOW_SECONDS,
        keyPrefix: 'api:key',
        keyResolver: apiKeyIdKey,
        redis,
      }),
  }
}

/** A body-parser parse failure (malformed JSON body) — a 400, not a 500. */
function isBodyParseError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    'type' in err &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  )
}

/** App factory — tests drive it in-process; index.ts is the only listener. */
export function createApp(options: AppOptions = {}): Express {
  const app = express()
  const gateway = resolveGateway(options.gateway)
  // Composition seam: resolve the injected extension or the Apache no-op default.
  // Package absence ⇒ no-op ⇒ self-host runs with the public primitives only (access
  // port, budget caps). The capability document advertises base Apache surfaces ∪
  // the extension's hosted-only capabilities; extension.register attaches its routes
  // below.
  const extension = options.extension ?? noOpExtension
  const limits = extension.resolveLimits ?? (async () => SELFHOST_LIMITS)
  // Resolve policy ONCE; the same function drives validated resource admission
  // and budget enforcement so transports cannot drift.
  // Budget enforcement, constructed ONCE and threaded into BOTH
  // metered transports (REST + MCP) — the two enforcement points.
  // The private repo injects a real limits resolver via the extension seam;
  // self-host (no extension) resolves empty limits, so the budget falls through to
  // the config default cap. The OTel fail-open alert is wired via onLookupFailure
  // so core stays config-free. Self-host runs exactly this wiring and still gets
  // cost caps.
  const budget: BudgetEnforcement = {
    resolveLimits: limits,
    config: loadBudgetConfig(),
    onLookupFailure: (operation) => budgetGateLookupFailure.add(1, { operation }),
    logger: { warn: (obj, msg) => log().warn(obj, msg) },
  }
  // Access gate, threaded into BOTH metered transports alongside the budget. The
  // private repo injects a real access policy; self-host keeps allowAllAccess.
  const access = extension.access ?? allowAllAccess
  // Resolve the shared ioredis client ONCE: the rate limiters and the
  // progressive-delay failure tracker both ride it, so dialing twice
  // would open a redundant connection. An explicit override wins (the test
  // seam); else the env-derived client (undefined ⇒ in-memory fallbacks).
  const redis = options.redis ?? resolveRedis()
  const clientMetadataResolver = options.clientMetadataResolver ?? new ClientMetadataResolver()
  const {
    edgeLimiter,
    mcpLimiter,
    authLimiter,
    signupLimiter,
    resendVerificationLimiter,
    verifyEmailLimiter,
    forgotPasswordLimiter,
    resetPasswordLimiter,
    registerLimiter,
    oauthLimiter,
    apiKeyLimiter,
  } = resolveLimiters(options, redis)
  // Railway terminates TLS at a proxy; without this, req.ip (and the SDK auth
  // router's rate limiter) see the proxy address.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(requestContext)
  app.use(healthRouter)
  // Keep health probes outside throttling so the platform can always distinguish
  // an overloaded API from a dead process. Every other surface gets a coarse
  // per-IP cap before body parsing or any handler work.
  app.use(edgeLimiter)
  // Capture the exact raw bytes alongside JSON parsing so a private webhook
  // (mounted by the extension below) can verify the signature over the
  // unmodified payload — re-serializing a parsed body would change the bytes and
  // break verification. Self-host attaches no webhook, so the
  // captured buffer is simply unused there.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        ;(req as Request & { rawBody?: Buffer }).rawBody = buf
      },
    }),
  )
  app.use(wellKnownRouter)
  // Capability discovery: base Apache surfaces ∪ injected hosted-only
  // capabilities. On self-host (no-op extension) only base capabilities appear.
  app.use(capabilitiesRouter([...baseCapabilities, ...extension.capabilities]))
  app.use(
    authRouter({
      limiter: authLimiter,
      signupLimiter,
      resendVerificationLimiter,
      verifyEmailLimiter,
      forgotPasswordLimiter,
      resetPasswordLimiter,
      limits,
    }),
  )
  app.use(apiKeysRouter)
  app.use(oauthClientsRouter)
  // Onboarding connection-status read (GET /auth/onboarding) —
  // session-authed like the api-keys / oauth-clients management surfaces; the
  // dashboard polls it to flip the connect step to "Connected ✓".
  app.use(onboardingRouter(limits))
  app.use(profileRouter)
  app.use(mcpRouter({ gateway, limiter: mcpLimiter, budget, access, limits }))
  // REST /api/v1 mirror (docs/concepts/architecture.mdx) — behind the
  // apiKeyAuth chain the router applies itself, so it mounts independent of the
  // MCP Bearer mount. APPEND-ONLY after the existing routers, before the error
  // handler. The same env-gated gateway threaded into mcpRouter is threaded here.
  // The per-key limiter is mounted before apiOrSessionAuth in the router.
  app.use(
    restRouter({
      gateway,
      rateLimiter: apiKeyLimiter,
      budget,
      access,
      limits,
      // Account-deletion hook: the private repo injects platform-specific cleanup;
      // self-host (no-op extension) runs no extra work.
      onAccountDeletion: extension.onAccountDeletion,
      // GDPR-export enricher: the private repo adds extra user-owned rows to the
      // archive; self-host omits them.
      exportEnricher: extension.exportEnricher,
    }),
  )
  // RFC 7591 dynamic client registration —
  // APPEND-ONLY after the existing routers, before the error handler. Gated by
  // the injected per-IP limiter seam (real bucket by default).
  app.use(oauthRegisterRouter({ limiter: registerLimiter }))
  // OAuth authorize/consent + token endpoints —
  // APPEND-ONLY after the existing routers, before the error handler. Both are
  // unauthenticated and sit behind the shared injected per-IP limiter seam
  // (real bucket by default).
  app.use(oauthAuthorizeRouter({ limiter: oauthLimiter, clientMetadataResolver }))
  // The same shared ioredis client backs the progressive-delay failure counter
  // so the budget is shared across Railway replicas; a missing client
  // makes the tracker fall back to a per-process Map.
  app.use(oauthTokenRouter({ limiter: oauthLimiter, redis, limits, clientMetadataResolver }))

  // Composition seam: the injected extension attaches its hosted-only
  // routes/handlers here, at the composition root, AFTER every Apache router and
  // BEFORE the error handler. On self-host this is the no-op default (attaches
  // nothing). No Apache package imports the extension — it arrives only via
  // options.extension from the private repo.
  extension.register(app)

  // The 4-arg signature is how express recognizes an error handler. Errors are
  // logged via the crash-safe projection: an Error message built from memory
  // content must not reach stdout raw.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // A malformed JSON body is a client error: express.json() throws a
    // body-parser SyntaxError (status 400, type 'entity.parse.failed') before
    // any route runs. Surface it as the documented 400 invalid_request contract
    // rather than the generic 500.
    if (isBodyParseError(err)) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    log().error(crashSafeError(err), 'server: unhandled error')
    res.status(500).json({ error: 'internal_error' })
  })
  return app
}
