// SPDX-License-Identifier: Apache-2.0
// POST /oauth/token CONTRACT tests, driven
// through createTestApp(). These cases cover the EMPTY / malformed token
// request: an empty POST (no body) and an unsupported Content-Type both leave
// req.body undefined. The route now defaults the body to {} before the
// Basic-auth shim and the handler read from it, so a missing required
// parameter surfaces as the SDK's typed invalid_request (RFC 6749 §5.2, HTTP
// 400) — NOT a dereference crash that the generic handler reports as a 500.
//
// No core seam is mocked: an absent grant_type fails at the request boundary
// BEFORE any client-auth or provider (DB) call, so these stay pure transport
// tests with no @3ngram/db dependency (hard rule 5).
import type { Server } from 'node:http'
import { setLogDestination } from '@3ngram/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { createTestApp } = await import('./test-app.js')

let server: Server
let baseUrl: string

// Log-capture seam: the route emits its per-request outcome line via the
// module-global log(), so we rebind that destination to a sink and assert on the
// JSON the production config actually serializes — the createLogger(stream)
// precedent from packages/config/test/redaction.test.ts, lifted to the process
// call site a real-HTTP transport test reaches. Success(200)/500 lines are
// asserted in the DB-backed integration suite (oauth-refresh.int.test.ts).
interface LogLine {
  msg?: string
  [key: string]: unknown
}
const logLines: LogLine[] = []

/** The single 'oauth: token endpoint' outcome line, or undefined if none was emitted. */
function lastOutcomeLine(): LogLine | undefined {
  return logLines.filter((line) => line.msg === 'oauth: token endpoint').at(-1)
}

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

afterAll(async () => {
  setLogDestination()
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
})

async function tokenRequest(
  init: RequestInit,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${baseUrl}/oauth/token`, { method: 'POST', ...init })
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
    headers: response.headers,
  }
}

describe('POST /oauth/token — empty / malformed request', () => {
  it('returns 400 invalid_request (not a 500 crash) for an empty POST with no body', async () => {
    const { status, json } = await tokenRequest({})
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_request')
    expect(json.access_token).toBeUndefined()
  })

  it('returns 400 invalid_request (not a 500 crash) for an unsupported Content-Type', async () => {
    const { status, json } = await tokenRequest({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
    })
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_request')
    expect(json.access_token).toBeUndefined()
  })

  it('rejects a malformed Basic header (no colon) with 401 invalid_client before any provider call', async () => {
    // RFC 6749 §2.3.1: a Basic header that does not decode to id:secret is a
    // failed client authentication — invalid_client, NOT a fall-through to
    // another method. Decided in transport before the (unmocked) DB seam runs.
    const { status, json } = await tokenRequest({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('no-colon-here').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'c',
        code_verifier: 'a'.repeat(43),
      }).toString(),
    })
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
    expect(json.access_token).toBeUndefined()
  })

  it('rejects a Basic header with invalid percent-encoding with 401 invalid_client, never a 500', async () => {
    // RFC 6749 §2.3.1: the fields are form-encoded, but a client may present a
    // bare `%` (invalid percent-encoding) that makes decodeURIComponent throw a
    // URIError. That must surface as the uniform invalid_client transport error,
    // NOT a generic ServerError (500) — same path as any other malformed Basic.
    const { status, json } = await tokenRequest({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('client:%').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'c',
        code_verifier: 'a'.repeat(43),
      }).toString(),
    })
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
    expect(json.access_token).toBeUndefined()
  })

  it('rejects Basic + a CONFLICTING posted client_id with 401 invalid_client before any provider call', async () => {
    // RFC 6749 §2.3/§3.2.1: a posted client_id that does not match the Basic
    // username is conflicting identities — invalid_client, decided in transport.
    const basic = Buffer.from('basic-client:basic-secret').toString('base64')
    const { status, json } = await tokenRequest({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'c',
        code_verifier: 'a'.repeat(43),
        client_id: 'a-different-client-id',
      }).toString(),
    })
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')
    expect(json.access_token).toBeUndefined()
  })

  it('rejects an otherwise-valid JSON authorization_code body with 400 invalid_request, never minting', async () => {
    // RFC 6749 §3.2/§4.1.3: the token endpoint is form-urlencoded only. A global
    // express.json() parses this JSON body before the route runs; the handler's
    // content-type guard must reject it BEFORE any client-auth / provider call —
    // so a fully populated JSON grant never reaches a token mint.
    const { status, json } = await tokenRequest({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'a-real-looking-code',
        client_id: 'cl_test',
        redirect_uri: 'https://example.test/cb',
        code_verifier: 'a'.repeat(43),
      }),
    })
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_request')
    expect(json.access_token).toBeUndefined()
  })

  it('sets BOTH Cache-Control: no-store and Pragma: no-cache on the token endpoint response (RFC 6749 §5.1)', async () => {
    // The token endpoint may mint access/refresh tokens, so RFC 6749 §5.1 requires
    // BOTH no-store caching headers on every response the handler produces. Asserted
    // here on a handler-reached response (no DB/provider seam in these transport tests).
    const { headers } = await tokenRequest({})
    expect(headers.get('cache-control')).toBe('no-store')
    expect(headers.get('pragma')).toBe('no-cache')
  })
})

describe('POST /oauth/token — per-request structured outcome line (#242)', () => {
  it('emits outcome=unsupported_grant_type and sanitizes grant_type to (invalid) on an RFC 400', async () => {
    logLines.length = 0
    const { status, json } = await tokenRequest({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'cl_abcdefghijklmnop',
      }).toString(),
    })
    expect(status).toBe(400)
    expect(json.error).toBe('unsupported_grant_type')

    const line = lastOutcomeLine()
    expect(line?.outcome).toBe('unsupported_grant_type')
    // The error path reads grant_type raw off req.body before the schema runs, so
    // anything outside the supported RFC tokens collapses to (invalid) — an
    // unbounded client-controlled value must never reach a log line (hard rule 6).
    expect(line?.grant_type).toBe('(invalid)')
    // The load-bearing safeguard: first 8 chars only, never the full client_id.
    expect(line?.client_id_prefix).toBe('cl_abcde')
    expect(JSON.stringify(line)).not.toContain('cl_abcdefghijklmnop')
  })

  it('fingerprints a SHORT client_id instead of logging it verbatim (never the raw value)', async () => {
    logLines.length = 0
    // The prefix safeguard truncates to 8 chars, but a SHORT (<= 8 char) value
    // read raw off req.body would be echoed in full — a malformed request could
    // smuggle short secret/token material there. The helper must emit a
    // non-reversible sha8: fingerprint instead, never the raw input (hard rule 6).
    const shortClientId = 'sekret'
    const { status, json } = await tokenRequest({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: shortClientId,
      }).toString(),
    })
    expect(status).toBe(400)
    expect(json.error).toBe('unsupported_grant_type')

    const line = lastOutcomeLine()
    expect(line?.outcome).toBe('unsupported_grant_type')
    // The logged value is a non-reversible fingerprint, NOT the raw short id.
    expect(line?.client_id_prefix).toMatch(/^sha8:[0-9a-f]{8}$/)
    expect(line?.client_id_prefix).not.toBe(shortClientId)
    expect(JSON.stringify(line)).not.toContain(shortClientId)
  })

  it('emits outcome=invalid_request when grant_type is absent (empty body)', async () => {
    logLines.length = 0
    const { status } = await tokenRequest({})
    expect(status).toBe(400)

    const line = lastOutcomeLine()
    expect(line?.outcome).toBe('invalid_request')
    expect(line?.grant_type).toBe('(none)')
    expect(line?.client_id_prefix).toBe('(none)')
  })

  it('emits outcome=invalid_client on a 401, carrying only the client_id prefix', async () => {
    logLines.length = 0
    // A posted client_id conflicting with the Basic username is invalid_client
    // (RFC 6749 §2.3/§3.2.1). The shim leaves the body client_id in place, so the
    // outcome line previews it — never the secret, never the full id.
    const basic = Buffer.from('basic-client:basic-secret').toString('base64')
    const { status, json } = await tokenRequest({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'a-secret-authorization-code',
        code_verifier: 'a'.repeat(43),
        client_id: 'conflicting-client-id',
      }).toString(),
    })
    expect(status).toBe(401)
    expect(json.error).toBe('invalid_client')

    const line = lastOutcomeLine()
    expect(line?.outcome).toBe('invalid_client')
    expect(line?.client_id_prefix).toBe('conflict')
    // No secret material (code, secret) ever enters the line.
    const serialized = JSON.stringify(line)
    expect(serialized).not.toContain('a-secret-authorization-code')
    expect(serialized).not.toContain('basic-secret')
    expect(serialized).not.toContain('conflicting-client-id')
  })
})
