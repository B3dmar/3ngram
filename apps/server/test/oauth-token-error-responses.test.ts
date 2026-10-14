// SPDX-License-Identifier: Apache-2.0
// POST /oauth/token error-response PIN: every RFC 6749 §5.2 failure the route
// can produce, asserted byte-for-byte — HTTP status, the exact serialized JSON
// body (key order included), the response headers, and the per-request outcome
// line. The transport-boundary paths need no seam; the provider-thrown paths
// (OAuthGrantError codes, the active-client limit, a generic fault) mock the
// core client-auth and grant provider at the established '@3ngram/core/auth'
// seam (cf. oauth-token-outcome-log.test.ts), so no DB is involved (hard rule 5).
// Header values that vary per request (Date, Connection, Keep-Alive) are
// dropped and the per-request X-Request-Id is pinned by shape; everything else,
// including ETag and Content-Length, is pinned by value.
import type { Server } from 'node:http'
import { setLogDestination } from '@3ngram/config'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let authenticatedClient: unknown
let exchangeError: unknown

vi.mock('@3ngram/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/config')>()
  return {
    ...actual,
    loadOAuthConfig: () => ({
      issuer: 'https://as.test/',
      resource: 'https://as.test/mcp',
      keys: [],
    }),
  }
})

vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  const exchange = async () => {
    throw exchangeError
  }
  return {
    ...actual,
    authenticateClientCredentials: vi.fn(async () => authenticatedClient),
    createOAuthServerProvider: () => ({
      exchangeAuthorizationCode: exchange,
      exchangeRefreshToken: exchange,
    }),
    insertAuditLog: vi.fn(async () => undefined),
  }
})

const { createTestApp } = await import('./test-app.js')
const { _exchangeFailures, toOAuthError } = await import('../src/routes/oauth-token.js')
const { OAuthGrantError, ResourceLimitExceededError } = await import('@3ngram/core/auth')

const CLIENT = {
  client_id: 'cl_pin_client',
  redirect_uris: ['https://client.example/cb'],
  grant_types: ['authorization_code', 'refresh_token'],
}

const FORM = 'application/x-www-form-urlencoded'
const BASIC = `Basic ${Buffer.from('cl_pin_client:pin-secret').toString('base64')}`

const CODE_GRANT = {
  grant_type: 'authorization_code',
  code: 'a-secret-authorization-code',
  code_verifier: 'a'.repeat(43),
  redirect_uri: 'https://client.example/cb',
  client_id: 'cl_pin_client',
  client_secret: 'pin-secret',
}

const VOLATILE_HEADERS = new Set(['date', 'connection', 'keep-alive'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface LogLine {
  msg?: string
  level?: number
  [key: string]: unknown
}
const logLines: LogLine[] = []

let server: Server
let baseUrl: string

beforeAll(async () => {
  setLogDestination({
    write(chunk: string) {
      logLines.push(JSON.parse(chunk) as LogLine)
    },
  })
  server = createTestApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(() => {
  authenticatedClient = undefined
  exchangeError = undefined
  logLines.length = 0
  // Each case starts below the progressive-delay threshold (no-Redis Map fallback).
  _exchangeFailures.clear()
})

afterAll(async () => {
  setLogDestination()
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
})

interface PinnedResponse {
  status: number
  body: string
  headers: Record<string, string>
}

async function post(headers: Record<string, string>, body?: string): Promise<PinnedResponse> {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body }),
  })
  const pinned: Record<string, string> = {}
  for (const [name, value] of response.headers) {
    if (VOLATILE_HEADERS.has(name)) continue
    pinned[name] = name === 'x-request-id' && UUID.test(value) ? '<uuid>' : value
  }
  return { status: response.status, body: await response.text(), headers: pinned }
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

/** The exact bytes the route serialized before the SDK swap: `error` then `error_description`. */
function errorBody(error: string, description: string): string {
  return JSON.stringify({ error, error_description: description })
}

function outcomeLines(): LogLine[] {
  return logLines.filter((line) => line.msg === 'oauth: token endpoint')
}

function failureLines(): LogLine[] {
  return logLines.filter((line) => line.msg === 'oauth: token endpoint failure')
}

/** Assert the full pinned response plus its single outcome line. */
function expectPinned(
  actual: PinnedResponse,
  expected: { status: number; body: string; headers: Record<string, string>; outcome: string },
): void {
  expect(actual.status).toBe(expected.status)
  expect(actual.body).toBe(expected.body)
  expect(actual.headers).toEqual(expected.headers)
  expect(outcomeLines().map((line) => line.outcome)).toEqual([expected.outcome])
  expect(failureLines()).toHaveLength(expected.outcome === 'server_error' ? 1 : 0)
}

/** Response headers every handler-reached error carries, keyed on the body bytes. */
function baseHeaders(etag: string, length: number): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-length': String(length),
    'content-type': 'application/json; charset=utf-8',
    etag,
    pragma: 'no-cache',
    'x-request-id': '<uuid>',
  }
}

// ETags captured from the server-legacy error classes before the swap to the
// SDK's single OAuthError: express derives them from the body bytes.
const MALFORMED = errorBody('invalid_request', 'Malformed token request')
const MALFORMED_ETAG = 'W/"49-+eALx0pyG4QjXPxvUM0bsNzFu6k"'
const CLIENT_AUTH = errorBody('invalid_client', 'Client authentication failed')
const CLIENT_AUTH_ETAG = 'W/"4d-XJYiiXjEzaYOwmYfMIUYXAiwMjc"'
const INVALID_GRANT = errorBody(
  'invalid_grant',
  'The provided grant is invalid, expired, or revoked',
)
const INVALID_GRANT_ETAG = 'W/"62-l+oQV0snr8iK6mQkiDOxcvh1OLU"'

describe('POST /oauth/token — transport-boundary error responses (pinned)', () => {
  it('pins invalid_request for a non-form Content-Type', async () => {
    const res = await post(
      { 'content-type': 'application/json' },
      JSON.stringify({ grant_type: 'authorization_code' }),
    )
    const body = errorBody(
      'invalid_request',
      'The token endpoint requires application/x-www-form-urlencoded',
    )
    expectPinned(res, {
      status: 400,
      body,
      headers: baseHeaders('W/"6f-t5h3nmNP0ZcdFO+17K4028RM9KI"', body.length),
      outcome: 'invalid_request',
    })
  })

  it('pins invalid_request for an absent grant_type (empty POST)', async () => {
    const res = await post({})
    expectPinned(res, {
      status: 400,
      body: MALFORMED,
      headers: baseHeaders(MALFORMED_ETAG, MALFORMED.length),
      outcome: 'invalid_request',
    })
  })

  it('pins invalid_request for a schema-invalid grant (authorization_code without code)', async () => {
    const res = await post(
      { 'content-type': FORM },
      form({ grant_type: 'authorization_code', client_id: 'cl_pin_client' }),
    )
    expectPinned(res, {
      status: 400,
      body: MALFORMED,
      headers: baseHeaders(MALFORMED_ETAG, MALFORMED.length),
      outcome: 'invalid_request',
    })
  })

  it('pins unsupported_grant_type for a present, unrecognized grant_type', async () => {
    const res = await post({ 'content-type': FORM }, form({ grant_type: 'password' }))
    const body = errorBody(
      'unsupported_grant_type',
      'The grant type is not supported by this server',
    )
    expectPinned(res, {
      status: 400,
      body,
      headers: baseHeaders('W/"67-NAKLLvgyTH6eLj2rLA2lls2FE9E"', body.length),
      outcome: 'unsupported_grant_type',
    })
  })

  it('pins invalid_client + the Basic challenge for a malformed Basic header', async () => {
    const res = await post(
      {
        'content-type': FORM,
        authorization: `Basic ${Buffer.from('no-colon').toString('base64')}`,
      },
      form({ grant_type: 'authorization_code' }),
    )
    expectPinned(res, {
      status: 401,
      body: CLIENT_AUTH,
      headers: {
        ...baseHeaders(CLIENT_AUTH_ETAG, CLIENT_AUTH.length),
        'www-authenticate': 'Basic realm="oauth"',
      },
      outcome: 'invalid_client',
    })
  })
})

describe('POST /oauth/token — client-authentication failures (pinned)', () => {
  it('pins invalid_client with NO challenge when client_secret_post fails', async () => {
    authenticatedClient = undefined
    const res = await post({ 'content-type': FORM }, form(CODE_GRANT))
    expectPinned(res, {
      status: 401,
      body: CLIENT_AUTH,
      headers: baseHeaders(CLIENT_AUTH_ETAG, CLIENT_AUTH.length),
      outcome: 'invalid_client',
    })
  })

  it('pins invalid_client + the Basic challenge when client_secret_basic fails', async () => {
    authenticatedClient = undefined
    const { client_secret: _secret, ...grant } = CODE_GRANT
    const res = await post({ 'content-type': FORM, authorization: BASIC }, form(grant))
    expectPinned(res, {
      status: 401,
      body: CLIENT_AUTH,
      headers: {
        ...baseHeaders(CLIENT_AUTH_ETAG, CLIENT_AUTH.length),
        'www-authenticate': 'Basic realm="oauth"',
      },
      outcome: 'invalid_client',
    })
  })

  it('pins invalid_client when the client is not registered for the grant type', async () => {
    authenticatedClient = { ...CLIENT, grant_types: ['refresh_token'] }
    const res = await post({ 'content-type': FORM }, form(CODE_GRANT))
    expectPinned(res, {
      status: 401,
      body: CLIENT_AUTH,
      headers: baseHeaders(CLIENT_AUTH_ETAG, CLIENT_AUTH.length),
      outcome: 'invalid_client',
    })
  })
})

describe('POST /oauth/token — provider-thrown error responses (pinned)', () => {
  const cases = [
    {
      name: 'OAuthGrantError(invalid_grant)',
      error: () => new OAuthGrantError('invalid_grant'),
      status: 400,
      body: INVALID_GRANT,
      etag: INVALID_GRANT_ETAG,
      outcome: 'invalid_grant',
    },
    {
      name: 'OAuthGrantError(invalid_client)',
      error: () => new OAuthGrantError('invalid_client'),
      status: 401,
      body: CLIENT_AUTH,
      etag: CLIENT_AUTH_ETAG,
      outcome: 'invalid_client',
    },
    {
      name: 'OAuthGrantError(invalid_target)',
      error: () => new OAuthGrantError('invalid_target'),
      status: 400,
      body: errorBody('invalid_target', 'The requested resource is not served by this server'),
      etag: 'W/"64-ywZcys0oBA0LLGn9ngBMNJtHQr0"',
      outcome: 'invalid_target',
    },
    {
      name: 'OAuthGrantError(invalid_token)',
      error: () => new OAuthGrantError('invalid_token'),
      status: 400,
      body: errorBody('invalid_token', 'The access token is invalid'),
      etag: 'W/"4b-BRJbllGQlvr9AsgKHgPZKSngeEs"',
      outcome: 'invalid_token',
    },
    {
      name: 'ResourceLimitExceededError(active_mcp_clients)',
      error: () => new ResourceLimitExceededError('active_mcp_clients'),
      status: 400,
      body: errorBody('invalid_grant', 'Active MCP client limit reached'),
      etag: 'W/"4f-d+xY35Q4bnc7dtYwuWQEoSVCvVo"',
      outcome: 'invalid_grant',
    },
    {
      name: 'a generic Error (opaque server_error)',
      error: () => new Error('boom: an unexpected internal fault'),
      status: 500,
      body: errorBody('server_error', 'Internal Server Error'),
      etag: 'W/"44-2yP8VlaMZgSuVmz5ftI1EXXGelA"',
      outcome: 'server_error',
    },
  ]

  for (const c of cases) {
    it(`pins ${c.outcome} (HTTP ${c.status}) for ${c.name}`, async () => {
      authenticatedClient = CLIENT
      exchangeError = c.error()
      const res = await post({ 'content-type': FORM }, form(CODE_GRANT))
      expectPinned(res, {
        status: c.status,
        body: c.body,
        headers: baseHeaders(c.etag, c.body.length),
        outcome: c.outcome,
      })
    })
  }

  it('pins the Basic challenge on a provider-thrown invalid_client for a Basic client', async () => {
    authenticatedClient = CLIENT
    exchangeError = new OAuthGrantError('invalid_client')
    const { client_secret: _secret, ...grant } = CODE_GRANT
    const res = await post({ 'content-type': FORM, authorization: BASIC }, form(grant))
    expectPinned(res, {
      status: 401,
      body: CLIENT_AUTH,
      headers: {
        ...baseHeaders(CLIENT_AUTH_ETAG, CLIENT_AUTH.length),
        'www-authenticate': 'Basic realm="oauth"',
      },
      outcome: 'invalid_client',
    })
  })

  it('pins the refresh_token grant to the same mapping', async () => {
    authenticatedClient = CLIENT
    exchangeError = new OAuthGrantError('invalid_grant')
    const res = await post(
      { 'content-type': FORM },
      form({
        grant_type: 'refresh_token',
        refresh_token: 'a-secret-refresh-token',
        client_id: 'cl_pin_client',
        client_secret: 'pin-secret',
      }),
    )
    expectPinned(res, {
      status: 400,
      body: INVALID_GRANT,
      headers: baseHeaders(INVALID_GRANT_ETAG, INVALID_GRANT.length),
      outcome: 'invalid_grant',
    })
  })
})

describe('toOAuthError', () => {
  it('passes an already-mapped OAuth error through unchanged', () => {
    const mapped = toOAuthError(new Error('boom'))
    expect(toOAuthError(mapped)).toBe(mapped)
    expect(mapped.toResponseObject()).toEqual({
      error: 'server_error',
      error_description: 'Internal Server Error',
    })
  })
})
