// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest'
import {
  isAllowedMcpOrigin,
  loadMcpAllowedOrigins,
  loadSmtpConfig,
  parseEnv,
  resetEnvCache,
} from '../src/env.js'

// A minimal valid RS256 private JWK array — production requires OAUTH_JWKS, so
// the LOG_HASH_SALT acceptance case must carry a structurally valid key set.
const PROD_OAUTH_JWKS = '[{"kty":"RSA","alg":"RS256","kid":"k1","n":"x","e":"AQAB","d":"y"}]'

/** A complete, valid production environment (every prod-required var set). */
const PROD_ENV = {
  NODE_ENV: 'production',
  LOG_HASH_SALT: 's3cret',
  BASE_URL: 'https://api.3ngram.test',
  OAUTH_JWKS: PROD_OAUTH_JWKS,
  // A strong, non-placeholder app_user password — production rejects empty /
  // change-me-* / too-short DB passwords, so the prod fixture must
  // carry a realistic one to isolate the var under test in each case.
  DATABASE_URL: 'postgresql://app_user:s3cret-prod-pw-32chars@db.3ngram.test/neondb',
  REDIS_URL: 'redis://default:pw@redis.railway.internal:6379',
} as const

describe('env schema (docs/concepts/observability.mdx gates)', () => {
  it('applies defaults on an empty environment', () => {
    const env = parseEnv({})
    expect(env.NODE_ENV).toBe('development')
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.LOG_DEBUG_CONTENT).toBe(false)
    expect(env.SENTRY_DSN).toBe('')
    expect(env.SENTRY_ENVIRONMENT).toBe('')
    expect(env.RAILWAY_ENVIRONMENT_NAME).toBe('')
    expect(env.LOG_HASH_SALT).toBe('')
  })

  it('accepts an explicit SENTRY_ENVIRONMENT and Railway environment name', () => {
    const env = parseEnv({ SENTRY_ENVIRONMENT: 'staging', RAILWAY_ENVIRONMENT_NAME: 'production' })
    expect(env.SENTRY_ENVIRONMENT).toBe('staging')
    expect(env.RAILWAY_ENVIRONMENT_NAME).toBe('production')
  })

  it('accepts LOG_DEBUG_CONTENT=true in development only', () => {
    const env = parseEnv({ NODE_ENV: 'development', LOG_DEBUG_CONTENT: 'true' })
    expect(env.LOG_DEBUG_CONTENT).toBe(true)
  })

  it('refuses LOG_DEBUG_CONTENT=true in production (boot failure, not log-time)', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        LOG_DEBUG_CONTENT: 'true',
        LOG_HASH_SALT: 'salt',
      }),
    ).toThrow(/LOG_DEBUG_CONTENT/)
  })

  it('refuses LOG_DEBUG_CONTENT=true in test env', () => {
    expect(() => parseEnv({ NODE_ENV: 'test', LOG_DEBUG_CONTENT: 'true' })).toThrow(
      /LOG_DEBUG_CONTENT/,
    )
  })

  it('requires LOG_HASH_SALT in production', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/LOG_HASH_SALT/)
    // A complete production env also needs the OAuth config (BASE_URL + OAUTH_JWKS) + REDIS_URL; supply them so this isolates LOG_HASH_SALT.
    const env = parseEnv(PROD_ENV)
    expect(env.LOG_HASH_SALT).toBe('s3cret')
  })

  it('rejects the public self-host LOG_HASH_SALT placeholder in production', () => {
    expect(() => parseEnv({ ...PROD_ENV, LOG_HASH_SALT: 'change-me-random-salt' })).toThrow(
      /LOG_HASH_SALT.*placeholder/,
    )
  })

  it('requires REDIS_URL in production (cross-instance rate limiting)', () => {
    const { REDIS_URL: _omit, ...withoutRedis } = PROD_ENV
    expect(() => parseEnv(withoutRedis)).toThrow(/REDIS_URL/)
  })

  it('requires DATABASE_URL in production', () => {
    const { DATABASE_URL: _omit, ...withoutDb } = PROD_ENV
    expect(() => parseEnv(withoutDb)).toThrow(/DATABASE_URL/)
  })

  it('accepts postgres runtime URLs and rejects non-postgres URLs', () => {
    expect(parseEnv(PROD_ENV).DATABASE_URL).toBe(PROD_ENV.DATABASE_URL)
    expect(
      parseEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://custom_app:p@host/db',
      }).DATABASE_URL,
    ).toBe('postgres://custom_app:p@host/db')
    expect(() => parseEnv({ ...PROD_ENV, DATABASE_URL: 'https://db.example.test' })).toThrow(
      /DATABASE_URL/,
    )
  })

  it('refuses owner-like users in DATABASE_URL and requires app_user in production', () => {
    expect(() =>
      parseEnv({ ...PROD_ENV, DATABASE_URL: 'postgresql://neondb_owner:pw@host/db' }),
    ).toThrow(/DATABASE_URL/)
    expect(() =>
      parseEnv({ ...PROD_ENV, DATABASE_URL: 'postgresql://postgres:pw@host/db' }),
    ).toThrow(/DATABASE_URL/)
    expect(() =>
      parseEnv({ ...PROD_ENV, DATABASE_URL: 'postgresql://migration_runner:pw@host/db' }),
    ).toThrow(/DATABASE_URL/)
    expect(() =>
      parseEnv({ ...PROD_ENV, DATABASE_URL: 'postgresql://custom_app:pw@host/db' }),
    ).toThrow(/DATABASE_URL/)
  })

  it('rejects placeholder / weak DATABASE_URL passwords in production (issue #452)', () => {
    // The .env.selfhost.example placeholders must fail closed: a self-host
    // operator who copies the example and sets NODE_ENV=production cannot boot
    // with a known credential. The compose `:?` guards only catch MISSING vars.
    // A change-me-* value NOT in the explicit public-defaults denylist, so it
    // exercises the placeholder-prefix rule specifically.
    expect(() =>
      parseEnv({
        ...PROD_ENV,
        DATABASE_URL: 'postgresql://app_user:change-me-now-please@postgres:5432/ngram',
      }),
    ).toThrow(/DATABASE_URL password .*placeholder/)
    // Empty password.
    expect(() =>
      parseEnv({ ...PROD_ENV, DATABASE_URL: 'postgresql://app_user:@postgres:5432/ngram' }),
    ).toThrow(/DATABASE_URL password is empty/)
    // Too short (< 12 chars).
    expect(() =>
      parseEnv({ ...PROD_ENV, DATABASE_URL: 'postgresql://app_user:short@postgres:5432/ngram' }),
    ).toThrow(/DATABASE_URL password is too short/)
  })

  it('accepts a strong app_user DATABASE_URL password in production (issue #452)', () => {
    expect(parseEnv(PROD_ENV).DATABASE_URL).toBe(PROD_ENV.DATABASE_URL)
  })

  it('rejects known public dev defaults in production (issue #452 round-2)', () => {
    // app-user-dev is exactly 12 chars and is not a change-me-* value, so the
    // length + placeholder rules alone would let this public default through.
    // The explicit denylist must still reject it (and 3ngram-dev) in production.
    const re = /DATABASE_URL password is a known public dev\/example default/
    expect(() =>
      parseEnv({
        ...PROD_ENV,
        DATABASE_URL: 'postgresql://app_user:app-user-dev@postgres:5432/ngram',
      }),
    ).toThrow(re)
    expect(() =>
      parseEnv({
        ...PROD_ENV,
        DATABASE_URL: 'postgresql://app_user:3ngram-dev@postgres:5432/ngram',
      }),
    ).toThrow(re)
    // Case-insensitive.
    expect(() =>
      parseEnv({
        ...PROD_ENV,
        DATABASE_URL: 'postgresql://app_user:APP-USER-DEV@postgres:5432/ngram',
      }),
    ).toThrow(re)
  })

  it('does NOT reject local dev DATABASE_URL passwords (dev defaults keep working)', () => {
    // docker-compose.yml ships app-user-dev with NODE_ENV=development; the guard
    // is production-gated so local dev (and the documented dev default) still boots.
    expect(
      parseEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://app_user:app-user-dev@postgres:5432/ngram',
      }).DATABASE_URL,
    ).toBe('postgresql://app_user:app-user-dev@postgres:5432/ngram')
    // The other public dev default (3ngram-dev) is likewise accepted in dev.
    expect(() =>
      parseEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://app_user:3ngram-dev@postgres:5432/ngram',
      }),
    ).not.toThrow()
    // Even a change-me-* / short password is allowed outside production.
    expect(() =>
      parseEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://app_user:change-me-app-user@postgres:5432/ngram',
      }),
    ).not.toThrow()
  })

  it('validates DATABASE_URL_UNPOOLED when present but refuses it in production app env', () => {
    expect(
      parseEnv({
        NODE_ENV: 'development',
        DATABASE_URL_UNPOOLED: 'postgresql://owner:pw@db.3ngram.test/neondb',
      }).DATABASE_URL_UNPOOLED,
    ).toBe('postgresql://owner:pw@db.3ngram.test/neondb')
    expect(() =>
      parseEnv({
        ...PROD_ENV,
        DATABASE_URL_UNPOOLED: 'postgresql://owner:pw@db.3ngram.test/neondb',
      }),
    ).toThrow(/DATABASE_URL_UNPOOLED/)
  })

  it('accepts a redis(s):// REDIS_URL and rejects a non-redis scheme as unset', () => {
    expect(parseEnv(PROD_ENV).REDIS_URL).toBe(PROD_ENV.REDIS_URL)
    expect(parseEnv({ ...PROD_ENV, REDIS_URL: 'rediss://h:6379' }).REDIS_URL).toBe(
      'rediss://h:6379',
    )
    // A non-redis URL (or '') reads as "not configured" — in production the
    // required-check then fires rather than the process booting with a bad value.
    const { REDIS_URL: _omit, ...base } = PROD_ENV
    expect(() => parseEnv({ ...base, REDIS_URL: 'https://nope' })).toThrow(/REDIS_URL/)
    expect(() => parseEnv({ ...base, REDIS_URL: '' })).toThrow(/REDIS_URL/)
  })

  it('treats REDIS_URL as optional outside production (in-memory limiter fallback)', () => {
    expect(parseEnv({}).REDIS_URL).toBeUndefined()
    expect(parseEnv({ NODE_ENV: 'development', REDIS_URL: '' }).REDIS_URL).toBeUndefined()
  })

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => parseEnv({ LOG_LEVEL: 'verbose' })).toThrow()
  })

  it('ignores unrelated process.env keys', () => {
    const env = parseEnv({ PATH: '/usr/bin', HOME: '/home/x' })
    expect(env.NODE_ENV).toBe('development')
  })
})

describe('WEB_APP_URL (issue #267: reset link uses the dashboard origin)', () => {
  it('accepts an absolute http(s) origin', () => {
    expect(parseEnv({ WEB_APP_URL: 'https://app.3ngram.test' }).WEB_APP_URL).toBe(
      'https://app.3ngram.test',
    )
    expect(parseEnv({ WEB_APP_URL: 'http://localhost:3000' }).WEB_APP_URL).toBe(
      'http://localhost:3000',
    )
  })

  it('coerces unset / empty / non-http values to undefined (skip the emailed link)', () => {
    // Mirrors the BASE_URL contract: only an absolute http(s) URL counts as set;
    // '' (CI surfaces unset secrets as empty) and a Vite base path read as unset.
    expect(parseEnv({}).WEB_APP_URL).toBeUndefined()
    expect(parseEnv({ WEB_APP_URL: '' }).WEB_APP_URL).toBeUndefined()
    expect(parseEnv({ WEB_APP_URL: '/' }).WEB_APP_URL).toBeUndefined()
  })

  it('is NOT required in production (split deploy may not send reset emails)', () => {
    // Unlike BASE_URL, WEB_APP_URL has no prod required-check: a deploy with no
    // mail server never builds a link, so its absence must not fail boot.
    expect(parseEnv(PROD_ENV).WEB_APP_URL).toBeUndefined()
  })
})

describe('SMTP + WEB_APP_URL cross-validation (issue #267: silent no-email guard)', () => {
  it('THROWS when SMTP is enabled (HOST + FROM) but WEB_APP_URL is unset', () => {
    // Mail-enabled deploy with no web origin: buildResetLink() would return
    // undefined, so the route mints a token, returns 200, and never sends. Fail
    // fast at boot instead of silently dropping reset emails.
    expect(() =>
      parseEnv({ SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'noreply@example.test' }),
    ).toThrow(/WEB_APP_URL/)
  })

  it('accepts SMTP enabled when WEB_APP_URL is also set', () => {
    const env = parseEnv({
      SMTP_HOST: 'smtp.example.test',
      SMTP_FROM: 'noreply@example.test',
      WEB_APP_URL: 'https://app.3ngram.test',
    })
    expect(env.WEB_APP_URL).toBe('https://app.3ngram.test')
  })

  it('keeps WEB_APP_URL optional when SMTP is NOT configured (degraded path)', () => {
    // No mail server: the route degrades to the documented owner/dev path, so a
    // missing web origin must not fail boot.
    expect(() => parseEnv({})).not.toThrow()
    expect(parseEnv({}).WEB_APP_URL).toBeUndefined()
    // SMTP_HOST alone (no SMTP_FROM) is not "delivery enabled": still optional.
    expect(() => parseEnv({ SMTP_HOST: 'smtp.example.test' })).not.toThrow()
    // SMTP_FROM alone (no SMTP_HOST) is likewise not enabled.
    expect(() => parseEnv({ SMTP_FROM: 'noreply@example.test' })).not.toThrow()
  })
})

describe('AUTH_SIGNUP_ENABLED (issue #349: public signup gate)', () => {
  it('defaults public signup off and applies a 24-hour email verification TTL', () => {
    const env = parseEnv({})
    expect(env.AUTH_SIGNUP_ENABLED).toBe(false)
    expect(env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES).toBe(1440)
  })

  it('requires SMTP delivery when public signup is enabled', () => {
    expect(() =>
      parseEnv({
        AUTH_SIGNUP_ENABLED: 'true',
        WEB_APP_URL: 'https://app.3ngram.test',
      }),
    ).toThrow(/AUTH_SIGNUP_ENABLED/)
  })

  it('requires WEB_APP_URL when public signup is enabled', () => {
    expect(() =>
      parseEnv({
        AUTH_SIGNUP_ENABLED: 'true',
        SMTP_HOST: 'smtp.example.test',
        SMTP_FROM: 'noreply@example.test',
      }),
    ).toThrow(/WEB_APP_URL/)
  })

  it('accepts public signup when SMTP and WEB_APP_URL are configured', () => {
    const env = parseEnv({
      AUTH_SIGNUP_ENABLED: 'true',
      EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: '60',
      SMTP_HOST: 'smtp.example.test',
      SMTP_FROM: 'noreply@example.test',
      WEB_APP_URL: 'https://app.3ngram.test',
    })

    expect(env.AUTH_SIGNUP_ENABLED).toBe(true)
    expect(env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES).toBe(60)
  })
})

describe('SMTP port (issue #267 part B: empty-string-is-unset)', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    resetEnvCache()
  })

  it('treats an empty SMTP_PORT as unset and applies the 587 default', () => {
    // The regression: z.coerce.number() maps '' -> 0, which fails .min(1) and
    // THROWS at env load — breaking the no-SMTP boot path. Empty must read as
    // unset so the default applies, mirroring SMTP_HOST.
    expect(() => parseEnv({ SMTP_PORT: '' })).not.toThrow()
    expect(parseEnv({ SMTP_PORT: '' }).SMTP_PORT).toBe(587)
    expect(parseEnv({ SMTP_PORT: '   ' }).SMTP_PORT).toBe(587)
  })

  it('defaults SMTP_PORT to 587 when absent', () => {
    expect(parseEnv({}).SMTP_PORT).toBe(587)
  })

  it('parses a valid explicit SMTP_PORT', () => {
    expect(parseEnv({ SMTP_PORT: '2525' }).SMTP_PORT).toBe(2525)
  })

  it('still rejects an out-of-range SMTP_PORT', () => {
    expect(() => parseEnv({ SMTP_PORT: '0' })).toThrow()
    expect(() => parseEnv({ SMTP_PORT: '70000' })).toThrow()
  })

  it('disables SMTP (loadSmtpConfig undefined) with empty port and no host/from', () => {
    process.env = { SMTP_PORT: '' }
    resetEnvCache()
    expect(loadSmtpConfig()).toBeUndefined()
  })

  it('enables SMTP with host+from and a valid explicit port', () => {
    process.env = {
      SMTP_HOST: 'smtp.example.test',
      SMTP_FROM: 'noreply@example.test',
      SMTP_PORT: '2525',
      // SMTP delivery requires a web origin for the reset link.
      WEB_APP_URL: 'https://app.3ngram.test',
    }
    resetEnvCache()
    const config = loadSmtpConfig()
    expect(config).toBeDefined()
    expect(config?.port).toBe(2525)
  })
})

describe('MCP origin allowlist (issue #101: Streamable HTTP Origin MUST)', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    resetEnvCache()
  })

  it('treats an empty MCP_ALLOWED_ORIGINS as unset', () => {
    // Empty-string-is-unset, the BASE_URL / WEB_APP_URL convention: CI surfaces
    // unset secrets as ''. A '' that survived to the splitter would add the
    // useless entry '' to the allowlist.
    expect(parseEnv({ MCP_ALLOWED_ORIGINS: '' }).MCP_ALLOWED_ORIGINS).toBeUndefined()
    expect(parseEnv({}).MCP_ALLOWED_ORIGINS).toBeUndefined()
  })

  it('is EMPTY with neither var set, so any present Origin is rejected', () => {
    // The fail-closed default. Non-browser clients send no Origin and are
    // untouched; a browser caller requires explicit configuration.
    process.env = {}
    resetEnvCache()
    expect(loadMcpAllowedOrigins().size).toBe(0)
    expect(isAllowedMcpOrigin('https://app.3ngram.test')).toBe(false)
  })

  it('admits WEB_APP_URL without any MCP_ALLOWED_ORIGINS', () => {
    // The dashboard is the one first-party browser caller, so it is allowlisted
    // by virtue of already being configured — no second var to remember.
    process.env = { WEB_APP_URL: 'https://app.3ngram.test' }
    resetEnvCache()
    expect(isAllowedMcpOrigin('https://app.3ngram.test')).toBe(true)
  })

  it('unions WEB_APP_URL with a comma-separated MCP_ALLOWED_ORIGINS', () => {
    process.env = {
      WEB_APP_URL: 'https://app.3ngram.test',
      MCP_ALLOWED_ORIGINS: 'http://localhost:6274, https://inspector.test',
    }
    resetEnvCache()
    expect(loadMcpAllowedOrigins().size).toBe(3)
    expect(isAllowedMcpOrigin('https://app.3ngram.test')).toBe(true)
    // Surrounding whitespace is trimmed — a human-edited env var will have it.
    expect(isAllowedMcpOrigin('http://localhost:6274')).toBe(true)
    expect(isAllowedMcpOrigin('https://inspector.test')).toBe(true)
  })

  it('normalizes case, default ports, trailing slashes, and paths', () => {
    // An Origin header is a SERIALIZED ORIGIN (lowercase host, no default port,
    // no path). Configured values are human-written URLs and are not, so both
    // sides must be normalized or the same origin misses itself.
    process.env = { MCP_ALLOWED_ORIGINS: 'https://App.Example.test:443/dashboard/' }
    resetEnvCache()
    expect(loadMcpAllowedOrigins()).toEqual(new Set(['https://app.example.test']))
    expect(isAllowedMcpOrigin('https://app.example.test')).toBe(true)
    expect(isAllowedMcpOrigin('HTTPS://APP.EXAMPLE.TEST')).toBe(true)
  })

  it('does not treat a non-default port or a scheme change as the same origin', () => {
    process.env = { MCP_ALLOWED_ORIGINS: 'https://app.example.test' }
    resetEnvCache()
    expect(isAllowedMcpOrigin('https://app.example.test:8443')).toBe(false)
    expect(isAllowedMcpOrigin('http://app.example.test')).toBe(false)
    expect(isAllowedMcpOrigin('https://evil.example')).toBe(false)
    // Prefix/suffix confusion must not pass.
    expect(isAllowedMcpOrigin('https://app.example.test.evil.example')).toBe(false)
  })

  it('skips unparseable entries instead of throwing at boot', () => {
    // A typo in a deployment's env must narrow the allowlist, never take the
    // server down — and skipping fails closed.
    process.env = { MCP_ALLOWED_ORIGINS: 'not a url,https://good.test,,   ' }
    resetEnvCache()
    expect(loadMcpAllowedOrigins()).toEqual(new Set(['https://good.test']))
  })

  it('rejects an opaque or literal-null Origin even so', () => {
    // `new URL('data:...').origin` serializes to the STRING "null", and a
    // sandboxed iframe sends the literal header `Origin: null`. Admitting
    // either would allowlist every sandboxed browsing context.
    process.env = { MCP_ALLOWED_ORIGINS: 'data:text/html,x' }
    resetEnvCache()
    expect(loadMcpAllowedOrigins().size).toBe(0)
    expect(isAllowedMcpOrigin('null')).toBe(false)
    expect(isAllowedMcpOrigin('')).toBe(false)
  })
})
