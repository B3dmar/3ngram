// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

/** The OAuth MCP resource path appended to BASE_URL. */
export const OAUTH_RESOURCE_PATH = '/mcp' as const

/**
 * A single private RS256 signing key in JWK form.
 *
 * OAUTH_JWKS carries an ARRAY of these (as JSON): the FIRST key is the current
 * signing key; the rest are old keys kept until their issued tokens expire
 * (rotation = add new at the front, drop the tail past max token lifetime).
 * Every key MUST carry a `kid` so the resource server can select by header and
 * rotation stays unambiguous. Only RS256 (kty=RSA, alg=RS256) is accepted — the
 * RS validates RS256 exclusively, so any other key is a boot-time config error.
 * The private fields (`d`, `p`, `q`, ...) live here; the JWKS endpoint derives
 * the PUBLIC view and never serves them (impl req: never expose private material).
 */
const oauthJwkSchema = z
  .object({
    kty: z.literal('RSA'),
    kid: z.string().min(1),
    alg: z.literal('RS256'),
    n: z.string().min(1),
    e: z.string().min(1),
    d: z.string().min(1),
  })
  .loose()

export type OAuthJwk = z.infer<typeof oauthJwkSchema>

const oauthJwksSchema = z.array(oauthJwkSchema).min(1)

const postgresUrlSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === '') return undefined

    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        ctx.addIssue({
          code: 'custom',
          message: 'must be a postgres:// or postgresql:// URL',
        })
        return z.NEVER
      }
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a valid URL' })
      return z.NEVER
    }

    return value
  })

const ownerLikeDatabaseUsers = new Set(['postgres', 'neondb_owner', 'migration_runner'])

function databaseUsername(url: string): string {
  const username = new URL(url).username
  try {
    return decodeURIComponent(username)
  } catch {
    return username
  }
}

function databasePassword(url: string): string {
  const password = new URL(url).password
  try {
    return decodeURIComponent(password)
  } catch {
    return password
  }
}

/**
 * Placeholder/weak-password guard for the runtime DATABASE_URL.
 *
 * `.env.selfhost.example` ships `change-me-*` placeholders; the compose `:?`
 * guards only fail-closed on MISSING vars, not on an unchanged placeholder. A
 * self-host operator who copies the example and sets NODE_ENV=production would
 * otherwise boot with a known credential. Reject the placeholder family, empty,
 * and obviously-too-short passwords so the server refuses to start. Returns a
 * human-readable reason (for the boot error) or undefined when acceptable.
 *
 * Production-gated by the caller so local dev defaults (docker-compose.yml ships
 * `app-user-dev`, NODE_ENV=development) keep working untouched.
 */
const PLACEHOLDER_PASSWORD_PREFIX = 'change-me'
const MIN_DB_PASSWORD_LENGTH = 12

// Known PUBLIC credentials shipped in the repo: the docker-compose.yml local-dev
// defaults (`app-user-dev`, `3ngram-dev`) and the .env.selfhost.example
// placeholders (`change-me-*`). They are public knowledge, so a production /
// self-host deploy that reuses one is compromised by default. Rejected
// explicitly and regardless of length — `app-user-dev` is exactly 12 chars and
// would otherwise pass MIN_DB_PASSWORD_LENGTH. Compared lowercased; the shell
// preflight (scripts/check-selfhost-secrets.sh) carries the same denylist.
const PUBLIC_DEV_PASSWORDS = new Set([
  'app-user-dev',
  '3ngram-dev',
  'change-me-postgres-owner',
  'change-me-app-user',
])

// Public placeholder shipped in .env.selfhost.example. A non-empty value is not
// sufficient when every reader of the repository knows it, so production must
// reject it just as it rejects the example database credentials above.
const PUBLIC_LOG_HASH_SALTS = new Set(['change-me-random-salt'])

function weakDatabasePasswordReason(password: string): string | undefined {
  if (password === '') return 'is empty'
  const lower = password.toLowerCase()
  if (PUBLIC_DEV_PASSWORDS.has(lower)) {
    return 'is a known public dev/example default (never use a shipped default in production)'
  }
  if (lower.startsWith(PLACEHOLDER_PASSWORD_PREFIX)) {
    return 'still uses a .env.selfhost.example placeholder (change-me-*)'
  }
  if (password.length < MIN_DB_PASSWORD_LENGTH) {
    return `is too short (minimum ${MIN_DB_PASSWORD_LENGTH} characters)`
  }
  return undefined
}

/**
 * Resolved OAuth resource-server config.
 *
 * One issuer per deployment, both derived from a single BASE_URL so they cannot
 * drift:
 * - `issuer`: the normalized deployment base URL (trailing slash via URL.href,
 *   matching the S4 SDK's `new URL().href` so strict clients do not mismatch).
 * - `resource`: the RFC 8707 resource identifier (= the MCP endpoint URL); the
 *   value every access token's `aud` must equal exactly.
 */
export interface OAuthConfig {
  issuer: string
  resource: string
  keys: OAuthJwk[]
}

/**
 * Observability env contract.
 *
 * Refuse-by-construction gates live here so a misconfigured process fails at
 * boot, not at the first log line:
 * - `LOG_DEBUG_CONTENT=true` outside `NODE_ENV=development` is rejected (§1
 *   red line: memory content never enters logs outside local dev).
 * - `LOG_HASH_SALT` is required in production and the public self-host example
 *   placeholder is rejected (hashed user_id correlation, §1).
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // Session token lifetime. Bounded so a typo cannot
    // mint effectively-immortal sessions; fails the process at boot when out
    // of range. Default 720h = 30 days.
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(720),
    // Forgotten-password reset-token lifetime. Short by design —
    // a reset link is single-use and time-boxed; bounded so a typo cannot mint a
    // long-lived token. Default 60 minutes.
    RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    // Email-verification token lifetime for self-serve signup. Longer than
    // reset links because signup is not a suspected-compromise flow. Default
    // 1440 minutes = 24 hours.
    EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(10080).default(1440),
    // --- Budget (GENERIC + Apache-only). These are the license-safe knobs the
    // self-host build keeps; the whole build is provider-agnostic and the license
    // boundary is package-absence-only.
    // Default per-cycle LLM budget cap (USD) used when a user has no override and
    // no plan_tiers row applies — the self-host fallback, so caps still work with
    // no platform (never "no row → no cap").
    BUDGET_DEFAULT_CAP_USD: z.coerce.number().min(0).default(10),
    // Default rolling budget-window length (days) for the no-platform path: with no
    // explicit period, the budget cycle is the last N days. A platform state
    // machine overrides this with the real plan period when present.
    BUDGET_DEFAULT_WINDOW_DAYS: z.coerce.number().int().min(1).max(366).default(30),
    // Runtime database URL. packages/db is the only layer that opens Postgres
    // connections, but the app process still validates the deployment contract at
    // boot so an invalid/missing DB URL fails before the first request.
    DATABASE_URL: postgresUrlSchema,
    // Owner/migration URL. Validated when present, but not required for the
    // served app. Production app processes must not carry this credential; the
    // release migration step injects it separately from operator/CI storage.
    DATABASE_URL_UNPOOLED: postgresUrlSchema,
    // OAuth resource-server config. BASE_URL derives the
    // single issuer + RFC 8707 resource id; OAUTH_JWKS is the JSON array of
    // RS256 signing keys (first = current). Optional outside production so the
    // skeleton boots locally, but REQUIRED + validated in production (a missing
    // or malformed key must fail at boot, not at the first token verify). When
    // present in any env they are validated; loadOAuthConfig() is the consumer.
    // Only an absolute http(s) URL counts as "set". Vite/vitest inject
    // BASE_URL='/' (their app base path) and some shells surface unset keys as
    // '', neither of which is a deployment issuer — coerce those to undefined so
    // they read as "not configured" (and so production's required-check fires
    // with a clear message) rather than crashing every process at import.
    BASE_URL: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined || !/^https?:\/\//.test(value) ? undefined : value,
      )
      .pipe(z.url().optional()),
    // Public origin of the 3ngram dashboard (the separate app that SERVES the
    // /reset-password page). In the documented deploy (docs/operate.mdx)
    // the server runs on Railway and the dashboard on Vercel — DIFFERENT origins —
    // so a reset link built from BASE_URL (the API/OAuth issuer) points at the
    // backend, which has no GET /reset-password (the form never loads). The reset
    // link is built from this origin instead. OPTIONAL: when unset there is no web
    // origin to link to, so the route skips the emailed link (the dev-echo token
    // path stays intact). Only an absolute http(s) URL counts as "set"; '' (CI
    // surfaces unset secrets as empty) and a Vite/vitest base path coerce to
    // undefined, mirroring the BASE_URL contract.
    WEB_APP_URL: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined || !/^https?:\/\//.test(value) ? undefined : value,
      )
      .pipe(z.url().optional()),
    // Extra browser origins allowed to call /mcp, comma-separated. The MCP
    // Streamable HTTP spec REQUIRES servers to reject a present-but-invalid
    // Origin (DNS-rebinding defense); loadMcpAllowedOrigins() unions this list
    // with WEB_APP_URL to build that allowlist. Empty-string-is-unset (the
    // BASE_URL / WEB_APP_URL convention): CI surfaces unset secrets as ''.
    // Entries are normalized to serialized origins at load, so a trailing
    // slash, a path, or mixed case is accepted here and compared correctly.
    // Local dev against MCP Inspector: MCP_ALLOWED_ORIGINS=http://localhost:6274
    MCP_ALLOWED_ORIGINS: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value)),
    OAUTH_JWKS: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value)),
    // Embedding gateway ("bring your own gateway"). Both optional and
    // env-GATED: when LLM_GATEWAY_URL + LLM_GATEWAY_API_KEY are both set the app
    // constructs a real OpenAI-compatible embedding client and injects it into
    // the MCP tools; when either is absent, search surfaces a typed "not
    // configured" error and remember runs with embedding off. Empty-string-is-
    // unset (the eval convention): CI exports these from optional secrets that
    // surface as '' when missing, so '' must read as "not configured", not as a
    // blank URL/key. Names match eval/src/judge.mjs so one secret pair serves
    // both surfaces.
    LLM_GATEWAY_URL: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined || !/^https?:\/\//.test(value) ? undefined : value,
      )
      .pipe(z.url().optional()),
    LLM_GATEWAY_API_KEY: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value)),
    // Redis connection string for the rate limiter — and
    // the shared store for the BullMQ workers. Optional locally so the
    // skeleton boots with an in-memory limiter (RateLimiterMemory), but REQUIRED
    // in production: rate limiting must be cross-instance there (Railway runs N
    // replicas; an in-memory bucket per instance is no limit at all). Mirrors the
    // OAUTH_JWKS/BASE_URL contract exactly — only a redis(s):// URL counts as
    // "set"; '' (CI surfaces unset secrets as empty) reads as undefined so
    // production's required-check fires with a clear message rather than crashing
    // every process at import. The value is a credential — it MUST NOT enter any
    // log line (hard rule 6).
    REDIS_URL: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined || !/^rediss?:\/\//.test(value) ? undefined : value,
      )
      .pipe(z.url().optional()),
    // Forgotten-password reset: when true, POST /auth/forgot-password
    // surfaces the freshly minted plaintext reset token IN THE 200 RESPONSE BODY
    // so a developer with no email channel can complete the flow. This is a
    // DEV-ONLY convenience — a hard boot guard below refuses it outside
    // NODE_ENV=development (the token is a credential; it must never reach a
    // response body, let alone a log line, in prod — hard rule 6). Default off.
    AUTH_RESET_TOKEN_DEV_ECHO: z.stringbool().default(false),
    // Public account creation. Default off: pre-release/provisioned deployments
    // should not accidentally become open-registration systems. When enabled,
    // SMTP_HOST + SMTP_FROM + WEB_APP_URL are required by the cross-field guard
    // below because signup depends on delivering verification links.
    AUTH_SIGNUP_ENABLED: z.stringbool().default(false),
    // Known-breach password screening (NIST 800-63B, research R3). When true,
    // signup and reset reject passwords found in the HaveIBeenPwned corpus via the
    // k-anonymity range API (only a 5-char SHA-1 prefix leaves the process — never
    // the password). Default off so self-host / restricted-egress deployments are
    // unaffected; the check itself FAILS OPEN on timeout/unreachable (account
    // availability outranks a best-effort screen), so enabling it never blocks
    // account creation when the corpus is down. The toggle and the fail-open
    // behaviour are separate axes (data-model D4).
    PASSWORD_BREACH_CHECK_ENABLED: z.stringbool().default(false),
    // Session closer (docs/concepts/session-continuity.mdx layer 5). When true,
    // the worker registers the lease-expiry sweep and processes closer jobs: a
    // background LLM pass that auto-RESOLVES briefed commitments a closed
    // session completed. Nothing else — it never writes new memories.
    //
    // DEFAULT OFF, and it stays off until measured. The page's validation bar is
    // a positive commitment-recall improvement over the 0% baseline, judged by a
    // dogfood audit rather than by CI, plus a spurious rate near the curated
    // path's zero. Flipping this default is that later decision, not this one.
    // With the flag off the sweep is never scheduled, so no row is implicitly
    // closed and no generation is billed.
    SESSION_CLOSER_ENABLED: z.stringbool().default(false),
    // SMTP delivery for password-reset emails (self-host hardening). ALL OPTIONAL and env-GATED: when SMTP_HOST +
    // SMTP_FROM are both set the app constructs a real nodemailer transport and
    // emails the reset link; when either is absent the forgot-password route
    // falls back to the documented owner-level / dev-token path and NEVER throws
    // (self-host must boot with no mail server). Empty-string-is-unset mirrors
    // the LLM_GATEWAY/REDIS contract: CI surfaces unset secrets as '' which must
    // read as "not configured", not as a blank host. SMTP_PASS is a credential —
    // it MUST NOT enter any log line (hard rule 6); the mailer logs host/port/
    // message-id only. SMTP_USER/SMTP_PASS are optional even when SMTP_HOST is
    // set (an open relay or IP-allowlisted MTA needs no auth).
    SMTP_HOST: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value)),
    // Empty-string-is-unset mirrors SMTP_HOST above: CI/self-host surfaces a
    // missing optional secret as '' (or whitespace), and z.coerce.number()
    // would map '' -> 0 (Number('') === 0), failing .min(1) and THROWING at
    // env load even when SMTP is meant to be disabled. Preprocess '' / blank to
    // undefined BEFORE coercion so the .default(587) applies and the no-SMTP
    // boot path degrades gracefully.
    SMTP_PORT: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.coerce.number().int().min(1).max(65535).default(587),
    ),
    SMTP_USER: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value)),
    SMTP_PASS: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value)),
    SMTP_FROM: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value)),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    LOG_HASH_SALT: z.string().default(''),
    LOG_DEBUG_CONTENT: z.stringbool().default(false),
    SENTRY_DSN: z.string().default(''),
    // Sentry environment tag. Hosted staging and production both run
    // NODE_ENV=production, so the tag must NOT derive from NODE_ENV alone or the
    // two environments are indistinguishable. Set per Railway service
    // (staging|production); resolution + blank-handling live in otel.ts.
    // RAILWAY_ENVIRONMENT_NAME is platform-injected and MUST be declared here —
    // Zod strips undeclared keys, so the fallback tier would never fire.
    SENTRY_ENVIRONMENT: z.string().default(''),
    RAILWAY_ENVIRONMENT_NAME: z.string().default(''),
    GIT_SHA: z.string().default(''),
    RAILWAY_GIT_COMMIT_SHA: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.LOG_DEBUG_CONTENT && env.NODE_ENV !== 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_DEBUG_CONTENT'],
        message:
          'LOG_DEBUG_CONTENT=true is refused outside NODE_ENV=development (docs/concepts/observability.mdx §1)',
      })
    }
    if (env.AUTH_RESET_TOKEN_DEV_ECHO && env.NODE_ENV !== 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_RESET_TOKEN_DEV_ECHO'],
        message:
          'AUTH_RESET_TOKEN_DEV_ECHO=true is refused outside NODE_ENV=development (issue #267: a reset token is a credential and must never reach a response body in prod)',
      })
    }
    if (env.NODE_ENV === 'production' && env.LOG_HASH_SALT === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_HASH_SALT'],
        message:
          'LOG_HASH_SALT is required in production (docs/concepts/observability.mdx §1 hashed user_id)',
      })
    }
    if (
      env.NODE_ENV === 'production' &&
      PUBLIC_LOG_HASH_SALTS.has(env.LOG_HASH_SALT.trim().toLowerCase())
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_HASH_SALT'],
        message:
          'LOG_HASH_SALT still uses a public .env.selfhost.example placeholder; generate a unique secret for production',
      })
    }
    if (env.NODE_ENV === 'production' && env.BASE_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['BASE_URL'],
        message: 'BASE_URL is required in production (derives issuer + resource)',
      })
    }
    if (
      env.NODE_ENV === 'production' &&
      env.BASE_URL !== undefined &&
      new URL(env.BASE_URL).protocol !== 'https:'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['BASE_URL'],
        message: 'BASE_URL must use https in production (OAuth issuer requirement)',
      })
    }
    if (env.NODE_ENV === 'production' && env.OAUTH_JWKS === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OAUTH_JWKS'],
        message: 'OAUTH_JWKS is required in production (RS256 signing keys)',
      })
    }
    if (env.NODE_ENV === 'production' && env.REDIS_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message:
          'REDIS_URL is required in production (cross-instance rate limiting; an in-memory bucket per replica is no limit)',
      })
    }
    if (env.NODE_ENV === 'production' && env.DATABASE_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL is required in production (runtime Postgres app_user URL)',
      })
    }
    if (env.DATABASE_URL !== undefined) {
      const username = databaseUsername(env.DATABASE_URL)
      if (ownerLikeDatabaseUsers.has(username)) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message:
            'DATABASE_URL must use the runtime app_user role, not an owner or migration role',
        })
      }
      // Runtime role name defaults to app_user; a deployment that re-provisions
      // its NOBYPASSRLS runtime role under a different name sets RUNTIME_DB_ROLE
      // (the RLS guard reads the same var).
      const expectedRuntimeRole = process.env.RUNTIME_DB_ROLE ?? 'app_user'
      if (env.NODE_ENV === 'production' && username !== expectedRuntimeRole) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: `DATABASE_URL must use the ${expectedRuntimeRole} runtime role in production`,
        })
      }
      // Fail closed on placeholder/weak DB passwords in production/self-host.
      // Gated to production so local dev defaults (app-user-dev)
      // stay valid; the migrations service has a parallel shell preflight
      // (scripts/check-selfhost-secrets.sh) since it never loads this schema.
      if (env.NODE_ENV === 'production') {
        const reason = weakDatabasePasswordReason(databasePassword(env.DATABASE_URL))
        if (reason) {
          ctx.addIssue({
            code: 'custom',
            path: ['DATABASE_URL'],
            message: `DATABASE_URL password ${reason}; set a strong, URL-safe app_user password (e.g. openssl rand -hex 32) in .env.selfhost (issue #452)`,
          })
        }
      }
    }
    if (env.NODE_ENV === 'production' && env.DATABASE_URL_UNPOOLED !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL_UNPOOLED'],
        message:
          'DATABASE_URL_UNPOOLED must not be present in the production app environment; run owner migrations as a separate release step',
      })
    }
    // SMTP delivery implies a web origin to link to. When SMTP_HOST + SMTP_FROM
    // are both set the forgot-password route SENDS the reset email — but the link
    // is built from WEB_APP_URL (the dashboard origin). With mail enabled and no
    // WEB_APP_URL, buildResetLink() returns undefined: the token is minted, the
    // uniform 200 returns, yet NO email is ever sent — a silent no-delivery path
    // with no boot- or request-time signal. Cross-validate at the boundary so a
    // mail-enabled deploy missing the web origin fails fast at boot instead.
    if (
      env.SMTP_HOST !== undefined &&
      env.SMTP_FROM !== undefined &&
      env.WEB_APP_URL === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_APP_URL'],
        message:
          'WEB_APP_URL is required when SMTP delivery is enabled (SMTP_HOST + SMTP_FROM): the reset link is built from the dashboard origin, so without it reset emails are silently dropped (issue #267)',
      })
    }
    if (env.AUTH_SIGNUP_ENABLED) {
      if (env.SMTP_HOST === undefined || env.SMTP_FROM === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_SIGNUP_ENABLED'],
          message:
            'AUTH_SIGNUP_ENABLED=true requires SMTP_HOST + SMTP_FROM so verification emails can be delivered',
        })
      }
      if (env.WEB_APP_URL === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEB_APP_URL'],
          message:
            'WEB_APP_URL is required when AUTH_SIGNUP_ENABLED=true: verification links are built from the dashboard origin',
        })
      }
    }
    // Validate the key array WHENEVER it is set, in any environment: a malformed
    // OAUTH_JWKS is a boot-time error, never a deferred token-verify failure.
    if (env.OAUTH_JWKS !== undefined) {
      const parsed = parseOAuthJwks(env.OAUTH_JWKS)
      if (!parsed.ok) {
        ctx.addIssue({ code: 'custom', path: ['OAUTH_JWKS'], message: parsed.message })
      }
    }
  })

export type Env = z.infer<typeof envSchema>

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source)
}

let cached: Env | undefined

/** Parse-once accessor; all runtime code reads env through this. */
export function loadEnv(): Env {
  cached ??= parseEnv()
  return cached
}

/** Test seam — drops the memoized env so the next loadEnv() re-parses. */
export function resetEnvCache(): void {
  cached = undefined
  cachedOAuth = undefined
  cachedMcpOrigins = undefined
}

type ParseJwksResult = { ok: true; keys: OAuthJwk[] } | { ok: false; message: string }

/**
 * Parse + validate the OAUTH_JWKS JSON string into the typed key array. Returns
 * a tagged result rather than throwing so the env superRefine can attach a
 * field-scoped issue (boot failure with a clear path) and loadOAuthConfig can
 * surface a precise error.
 */
function parseOAuthJwks(raw: string): ParseJwksResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'OAUTH_JWKS must be a JSON array of RS256 JWKs' }
  }
  const result = oauthJwksSchema.safeParse(json)
  if (!result.success) {
    return {
      ok: false,
      message: 'OAUTH_JWKS must be a non-empty array of RS256 private JWKs, each with a kid',
    }
  }
  return { ok: true, keys: result.data }
}

/** Normalize a base URL the same way the S4 SDK does (`new URL().href`). */
function normalizeIssuer(baseUrl: string): string {
  return new URL(baseUrl).href
}

/**
 * Derive the RFC 8707 resource id from BASE_URL: the MCP endpoint URL. The
 * issuer keeps its trailing slash (normalized), the resource does not — a token
 * `aud` must equal this exact string.
 */
function deriveResource(baseUrl: string): string {
  const issuer = normalizeIssuer(baseUrl)
  return `${issuer.replace(/\/$/, '')}${OAUTH_RESOURCE_PATH}`
}

let cachedOAuth: OAuthConfig | undefined

/**
 * Resolve the OAuth resource-server config (issuer, resource, keys) from env.
 * Fails fast — throws when BASE_URL or OAUTH_JWKS is missing or malformed — so
 * the OAuth surface never serves with a half-configured key set. Memoized; the
 * env-level validation already ran at loadEnv(), this re-derives the typed view.
 */
export function loadOAuthConfig(): OAuthConfig {
  if (cachedOAuth) return cachedOAuth
  const env = loadEnv()
  if (env.BASE_URL === undefined) {
    throw new Error('BASE_URL is not set (required for the OAuth resource server)')
  }
  if (env.OAUTH_JWKS === undefined) {
    throw new Error('OAUTH_JWKS is not set (required for the OAuth resource server)')
  }
  const parsed = parseOAuthJwks(env.OAUTH_JWKS)
  if (!parsed.ok) throw new Error(parsed.message)
  cachedOAuth = {
    issuer: normalizeIssuer(env.BASE_URL),
    resource: deriveResource(env.BASE_URL),
    keys: parsed.keys,
  }
  return cachedOAuth
}

let cachedMcpOrigins: ReadonlySet<string> | undefined

/**
 * Normalize a configured URL to the SERIALIZED ORIGIN form an `Origin` header
 * carries: `new URL().origin` lowercases the host, drops a default port, and
 * strips any path/query, so `https://App.Example.com:443/dashboard` and
 * `https://app.example.com` compare equal. Returns undefined for anything that
 * does not parse — a typo in the allowlist must narrow it, never widen it.
 *
 * Deliberately NOT webOrigin() from apps/server/src/links.ts: that helper only
 * trims a trailing slash, lives in the app layer, and would let two spellings
 * of one origin miss each other.
 */
function normalizeOrigin(value: string): string | undefined {
  try {
    const { origin } = new URL(value.trim())
    // A non-http(s) or opaque input (e.g. "data:…") serializes as "null";
    // admitting it would allowlist every sandboxed browsing context.
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/**
 * The browser origins allowed to reach /mcp: WEB_APP_URL (the dashboard, the
 * one first-party browser caller) ∪ MCP_ALLOWED_ORIGINS. Memoized; every entry
 * is normalized so the middleware compares like with like.
 *
 * FAIL-CLOSED BY DEFAULT: with neither var set this is EMPTY, so any request
 * carrying an Origin is rejected. That is the correct default — the spec's MUST
 * is conditional on the header being present, and non-browser clients (Claude
 * Desktop, the CLI, agent runtimes) send none, so they are untouched. An
 * operator wiring a browser client sets MCP_ALLOWED_ORIGINS (see .env.example).
 *
 * Unparseable entries are SKIPPED rather than thrown: a malformed origin in a
 * deployment's env must not take the whole server down at boot, and skipping
 * fails closed (that origin simply is not allowed).
 */
export function loadMcpAllowedOrigins(): ReadonlySet<string> {
  if (cachedMcpOrigins) return cachedMcpOrigins
  const env = loadEnv()
  const configured = env.MCP_ALLOWED_ORIGINS?.split(',') ?? []
  const origins = new Set<string>()
  for (const candidate of [env.WEB_APP_URL, ...configured]) {
    if (candidate === undefined || candidate.trim() === '') continue
    const normalized = normalizeOrigin(candidate)
    if (normalized !== undefined) origins.add(normalized)
  }
  cachedMcpOrigins = origins
  return cachedMcpOrigins
}

/**
 * Whether a raw `Origin` header value may reach /mcp. THE decision function —
 * the middleware asks this and does no parsing of its own, so the header and
 * the allowlist are always normalized by the same code (hard rule 2's spirit:
 * one place owns the comparison).
 *
 * An unparseable header, or the literal `null` a sandboxed iframe sends, is
 * NOT allowed: it cannot be matched against any configured origin, so treating
 * it as valid would be a hole rather than a convenience.
 */
export function isAllowedMcpOrigin(originHeader: string): boolean {
  const normalized = normalizeOrigin(originHeader)
  return normalized !== undefined && loadMcpAllowedOrigins().has(normalized)
}

/**
 * Resolved embedding-gateway config. Carries the base URL + the
 * bearer credential; the api key NEVER enters a log line (hard rule 6) — only
 * this typed value, passed straight into the LLM client.
 */
export interface LlmGatewayConfig {
  baseUrl: string
  apiKey: string
}

/**
 * Resolve the embedding-gateway config IFF both the URL and the api key are set;
 * otherwise `undefined` ("not configured"). The app uses this to decide whether
 * to construct + inject a real embedding client — embedding is OPTIONAL, so a
 * missing pair is not a boot error (unlike OAuth in production). Re-derived per
 * call from the (memoized) env; no separate cache needed.
 */
export function loadLlmGatewayConfig(): LlmGatewayConfig | undefined {
  const env = loadEnv()
  if (env.LLM_GATEWAY_URL === undefined || env.LLM_GATEWAY_API_KEY === undefined) {
    return undefined
  }
  return { baseUrl: env.LLM_GATEWAY_URL, apiKey: env.LLM_GATEWAY_API_KEY }
}

/** Resolved session-closer config (docs/concepts/session-continuity.mdx layer 5). */
export interface SessionCloserConfig {
  /** Register the lease-expiry sweep and process closer jobs. Default off. */
  enabled: boolean
}

/**
 * Resolve the session-closer config. Always returns a value — the flag has a
 * bounded default (false), so a worker boots with the closer inert unless the
 * deployment opts in. Deliberately NOT folded into the gateway config: "a
 * gateway is configured" and "the closer may run" are different decisions, and
 * a deployment that embeds should not acquire a background LLM pass by
 * side effect.
 */
export function loadSessionCloserConfig(): SessionCloserConfig {
  return { enabled: loadEnv().SESSION_CLOSER_ENABLED }
}

/**
 * Resolved SMTP config for password-reset delivery. Carries
 * the transport coordinates plus the `from` address. `auth` is present only when
 * BOTH SMTP_USER and SMTP_PASS are set (an unauthenticated relay omits it). The
 * password is a credential and lives only in this typed value — it never enters
 * a log line (hard rule 6).
 */
export interface SmtpConfig {
  host: string
  port: number
  from: string
  auth?: { user: string; pass: string }
}

/**
 * Resolve the SMTP config IFF both SMTP_HOST and SMTP_FROM are set; otherwise
 * `undefined` ("not configured"). SMTP is OPTIONAL by design (self-host must
 * boot with no mail server), so a missing pair is not a boot error — the
 * forgot-password route degrades to the documented owner-level / dev-token path.
 * Re-derived per call from the (memoized) env; no separate cache needed.
 */
export function loadSmtpConfig(): SmtpConfig | undefined {
  const env = loadEnv()
  if (env.SMTP_HOST === undefined || env.SMTP_FROM === undefined) {
    return undefined
  }
  const config: SmtpConfig = { host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.SMTP_FROM }
  if (env.SMTP_USER !== undefined && env.SMTP_PASS !== undefined) {
    config.auth = { user: env.SMTP_USER, pass: env.SMTP_PASS }
  }
  return config
}

/**
 * Generic, license-safe budget settings. Apache-only and provider-free by
 * construction — the self-host build keeps these and gets working cost caps under
 * allowAllAccess. `defaultCapUsd` + `defaultWindowDays` are the budget fallback
 * when a user has no override and no plan_tiers row; a platform state machine
 * supplies the real plan period when present.
 */
export interface BudgetConfig {
  defaultCapUsd: number
  defaultWindowDays: number
}

/**
 * Resolve {@link BudgetConfig} from the (memoized) env. Always returns a value
 * (every field has a bounded default) — budget knobs are not optional: self-host
 * must boot with a usable cap and cycle even with nothing configured.
 */
export function loadBudgetConfig(): BudgetConfig {
  const env = loadEnv()
  return {
    defaultCapUsd: env.BUDGET_DEFAULT_CAP_USD,
    defaultWindowDays: env.BUDGET_DEFAULT_WINDOW_DAYS,
  }
}
