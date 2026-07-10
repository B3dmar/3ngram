// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '../src/env.js'
// initObservability() is deliberately NOT exercised here: it registers
// process-global crash handlers and boots the Sentry/OTel SDK. The DSN gate
// itself is a two-line early return; the scrub and crash projection are the
// parts worth pinning.
import {
  crashSafeError,
  resolveSentryEnvironment,
  scrubEvent,
  scrubSentryEvent,
} from '../src/otel.js'
import { REDACTED } from '../src/redaction.js'

describe('resolveSentryEnvironment (FR-009 — staging vs production must be distinguishable)', () => {
  const base = {
    SENTRY_ENVIRONMENT: '',
    RAILWAY_ENVIRONMENT_NAME: '',
    NODE_ENV: 'production',
  } as const

  it('prefers an explicit SENTRY_ENVIRONMENT over everything', () => {
    expect(
      resolveSentryEnvironment({
        ...base,
        SENTRY_ENVIRONMENT: 'staging',
        RAILWAY_ENVIRONMENT_NAME: 'prod',
      }),
    ).toBe('staging')
  })

  it('falls back to the Railway environment name when SENTRY_ENVIRONMENT is unset', () => {
    // Guards the Zod-strip bug: RAILWAY_ENVIRONMENT_NAME must be a declared
    // schema key, or this tier silently never resolves.
    expect(resolveSentryEnvironment({ ...base, RAILWAY_ENVIRONMENT_NAME: 'staging' })).toBe(
      'staging',
    )
  })

  it('falls back to NODE_ENV when neither override is set', () => {
    expect(resolveSentryEnvironment({ ...base, NODE_ENV: 'development' })).toBe('development')
  })

  it('treats a blank/whitespace SENTRY_ENVIRONMENT as unset and falls through', () => {
    // A plain `??` would take '' as authoritative and emit an empty environment.
    expect(resolveSentryEnvironment({ ...base, SENTRY_ENVIRONMENT: '' })).toBe('production')
    expect(
      resolveSentryEnvironment({
        ...base,
        SENTRY_ENVIRONMENT: '   ',
        RAILWAY_ENVIRONMENT_NAME: 'staging',
      }),
    ).toBe('staging')
  })

  it('gives two services sharing one DSN distinct tags (the FR-009 guarantee)', () => {
    const staging = resolveSentryEnvironment({ ...base, SENTRY_ENVIRONMENT: 'staging' })
    const production = resolveSentryEnvironment({ ...base, SENTRY_ENVIRONMENT: 'production' })
    expect(staging).not.toBe(production)
  })
})

describe('Sentry event scrubbing (docs/concepts/observability.mdx §2 — same red line as logs)', () => {
  it('censors memory-content fields anywhere in the event tree', () => {
    const event = {
      message: 'tool failed',
      extra: {
        memory: { id: 'mem-1', content: 'penicillin allergy', topic: 'health' },
        query: 'what allergies?',
      },
      breadcrumbs: [{ data: { content: 'leak' } }],
    }
    const scrubbed = scrubEvent(event)
    expect(scrubbed.extra.memory.content).toBe(REDACTED)
    expect(scrubbed.extra.memory.topic).toBe(REDACTED)
    expect(scrubbed.extra.query).toBe(REDACTED)
    expect(scrubbed.breadcrumbs[0]?.data.content).toBe(REDACTED)
    expect(scrubbed.extra.memory.id).toBe('mem-1')
    expect(JSON.stringify(scrubbed)).not.toContain('penicillin')
  })

  it('passes primitives and non-content fields through untouched', () => {
    const event = { level: 'error', tags: { release: 'abc123' }, count: 3, ok: null }
    expect(scrubEvent(event)).toEqual(event)
  })
})

describe('Sentry error-event gate (exception messages are free text, not fields)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvCache()
  })

  const errorEvent = {
    message: 'memory says penicillin',
    exception: {
      values: [
        {
          type: 'Error',
          value: 'failed storing: allergic to penicillin',
          stacktrace: { frames: [{ function: 'writeMemory', filename: 'core.ts', lineno: 42 }] },
        },
      ],
    },
    breadcrumbs: [{ message: 'about to store penicillin note', category: 'op' }],
    tags: { release: 'abc123' },
  }

  it('sanitizes exception values, message, and breadcrumbs outside dev', () => {
    vi.stubEnv('NODE_ENV', 'test')
    resetEnvCache()
    const scrubbed = scrubSentryEvent(errorEvent)
    const value = scrubbed.exception.values[0]?.value as string
    expect(value).toMatch(/^\[redacted len=\d+ sha256_8=[0-9a-f]{8}\]$/)
    expect(scrubbed.message).toMatch(/^\[redacted /)
    expect(scrubbed.breadcrumbs[0]?.message).toMatch(/^\[redacted /)
    expect(JSON.stringify(scrubbed)).not.toContain('penicillin')
  })

  it('preserves structured stacktrace frames and tags (grouping keeps working)', () => {
    vi.stubEnv('NODE_ENV', 'test')
    resetEnvCache()
    const scrubbed = scrubSentryEvent(errorEvent)
    expect(scrubbed.exception.values[0]?.stacktrace.frames[0]).toEqual({
      function: 'writeMemory',
      filename: 'core.ts',
      lineno: 42,
    })
    expect(scrubbed.tags.release).toBe('abc123')
  })

  it('keeps raw exception text in local dev only', () => {
    vi.stubEnv('NODE_ENV', 'development')
    resetEnvCache()
    const scrubbed = scrubSentryEvent(errorEvent)
    expect(scrubbed.exception.values[0]?.value).toBe('failed storing: allergic to penicillin')
  })
})

describe('crash-path error projection (no memory content on the fatal log line)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvCache()
  })

  it('outside dev, an Error becomes frames + length + digest — never the message', () => {
    vi.stubEnv('NODE_ENV', 'test')
    resetEnvCache()
    const error = new Error('memory says: allergic to penicillin')
    const safe = crashSafeError(error)
    expect(safe.err_type).toBe('Error')
    expect(safe.message_len).toBe(error.message.length)
    expect(safe.message_sha256_8).toMatch(/^[0-9a-f]{8}$/)
    expect(JSON.stringify(safe)).not.toContain('penicillin')
    expect((safe.stack_frames as string[])[0]).toMatch(/at /)
  })

  it('drops non-frame stack lines injected by database drivers', () => {
    vi.stubEnv('NODE_ENV', 'test')
    resetEnvCache()
    const error = new Error('query failed')
    error.stack = [
      'Error: query failed',
      'params: ["client_secret"]',
      'statement: insert into oauth_codes values (private)',
      '    at insertOauthCode (/app/packages/db/dist/auth-oauth-codes.js:26:14)',
    ].join('\n')

    const safe = crashSafeError(error)

    expect(safe.stack_frames).toEqual([
      'at insertOauthCode (/app/packages/db/dist/auth-oauth-codes.js:26:14)',
    ])
    expect(JSON.stringify(safe)).not.toContain('client_secret')
    expect(JSON.stringify(safe)).not.toContain('private')
  })

  it('redacts string rejection reasons the same way', () => {
    vi.stubEnv('NODE_ENV', 'test')
    resetEnvCache()
    const safe = crashSafeError('raw memory content in a rejection')
    expect(safe.err_type).toBe('string')
    expect(JSON.stringify(safe)).not.toContain('memory content')
  })

  it('passes the raw error through in local dev only', () => {
    vi.stubEnv('NODE_ENV', 'development')
    resetEnvCache()
    const error = new Error('boom')
    expect(crashSafeError(error)).toEqual({ err: error })
  })
})
