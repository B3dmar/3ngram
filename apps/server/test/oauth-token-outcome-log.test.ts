// SPDX-License-Identifier: Apache-2.0
// POST /oauth/token per-request structured outcome line — the SUCCESS(200)
// and SERVER_ERROR(500) classes, which are unreachable in the pure-transport
// oauth-token.test.ts (it fails at the request boundary before any provider call).
// Here the core grant provider is mocked so a fully-authenticated request reaches
// either a minted token set (success) or a generic throw (the opaque ServerError
// 500), letting us assert the exact line the production log() serializes WITHOUT a
// DB-backed harness. The capture seam is setLogDestination() — the same
// createLogger(stream) precedent from packages/config/test/redaction.test.ts.
import type { Server } from 'node:http'
import { setLogDestination } from '@3ngram/config'
import type { OAuthServerProvider } from '@modelcontextprotocol/server-legacy/auth'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const TOKENS = {
  access_token: 'minted-access-token-secret',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'minted-refresh-token-secret',
  scope: 'memory:read',
}

let exchangeShouldThrow = false

// authenticateClientCredentials returns a non-undefined client so the request
// passes auth and reaches the provider; createOAuthServerProvider yields a stub
// whose authorization_code exchange either mints TOKENS or throws a GENERIC error
// (the ServerError 500 path). insertAuditLog is a no-op so the success path takes
// no DB. Everything else from the module stays REAL (layering unchanged).
// loadOAuthConfig() fails fast without BASE_URL/OAUTH_JWKS (a generic throw that
// would itself be a 500), so stub it to a minimal config — the mocked provider
// ignores it anyway. Everything else (setLogDestination, log) stays REAL.
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
  return {
    ...actual,
    authenticateClientCredentials: vi.fn(async () => ({
      client_id: 'cl_logtest_client',
      redirect_uris: ['https://client.example/cb'],
    })),
    createOAuthServerProvider: () =>
      ({
        async exchangeAuthorizationCode() {
          if (exchangeShouldThrow) throw new Error('boom: an unexpected internal fault')
          return TOKENS
        },
      }) as unknown as OAuthServerProvider,
    insertAuditLog: vi.fn(async () => undefined),
  }
})

const { createTestApp } = await import('./test-app.js')

let server: Server
let baseUrl: string

interface LogLine {
  msg?: string
  [key: string]: unknown
}
const logLines: LogLine[] = []

function lastOutcomeLine(): LogLine | undefined {
  return logLines.filter((line) => line.msg === 'oauth: token endpoint').at(-1)
}

async function tokenRequest(body: Record<string, string>): Promise<number> {
  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  await res.json()
  return res.status
}

const VALID_CODE_BODY = {
  grant_type: 'authorization_code',
  code: 'a-secret-authorization-code',
  code_verifier: 'a'.repeat(43),
  redirect_uri: 'https://client.example/cb',
  client_id: 'cl_logtest_client',
  client_secret: 'super-secret-client-credential',
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

afterEach(() => {
  exchangeShouldThrow = false
  logLines.length = 0
})

afterAll(async () => {
  setLogDestination()
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
})

describe('POST /oauth/token — success(200) outcome line (#242)', () => {
  it('emits outcome=success with the client_id prefix and no token/secret', async () => {
    exchangeShouldThrow = false
    expect(await tokenRequest(VALID_CODE_BODY)).toBe(200)

    const line = lastOutcomeLine()
    expect(line?.outcome).toBe('success')
    expect(line?.grant_type).toBe('authorization_code')
    expect(line?.client_id_prefix).toBe('cl_logte')

    const serialized = JSON.stringify(line)
    expect(serialized).not.toContain('minted-access-token-secret')
    expect(serialized).not.toContain('minted-refresh-token-secret')
    expect(serialized).not.toContain('super-secret-client-credential')
    expect(serialized).not.toContain('a-secret-authorization-code')
    expect(serialized).not.toContain('cl_logtest_client')
  })
})

describe('POST /oauth/token — server_error(500) outcome line (#242)', () => {
  it('emits outcome=server_error when the provider throws a generic error', async () => {
    exchangeShouldThrow = true
    expect(await tokenRequest(VALID_CODE_BODY)).toBe(500)

    const line = lastOutcomeLine()
    expect(line?.outcome).toBe('server_error')
    expect(line?.grant_type).toBe('authorization_code')
    expect(line?.client_id_prefix).toBe('cl_logte')

    const serialized = JSON.stringify(line)
    expect(serialized).not.toContain('super-secret-client-credential')
    expect(serialized).not.toContain('a-secret-authorization-code')
  })
})
