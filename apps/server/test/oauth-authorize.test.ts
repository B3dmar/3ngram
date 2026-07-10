// SPDX-License-Identifier: Apache-2.0
// POST /oauth/authorize CSRF mismatch — negative test.
// Verifies that a double-submit CSRF token mismatch is rejected with
// 403 { error: 'invalid_request' } BEFORE credential or provider work runs.
//
// Test strategy:
//   1. Mock oauthClientsStore.getClient to return a fixed test client so no DB
//      is needed (hard rule 5 — apps/server has no @3ngram/db dependency).
//   2. GET /oauth/authorize with valid params to obtain the 'oauth_csrf' cookie.
//   3. POST /oauth/authorize with all required form fields but a DIFFERENT
//      csrf_token value (deliberate mismatch with the cookie).
//   4. Assert: 403, body { error: 'invalid_request' }.
//
// The cookie name is the constant CSRF_COOKIE = 'oauth_csrf' in oauth-authorize.ts.
// The 403 path is: csrfMatches(readCsrfCookie(...), parsed.data.csrf_token) → false.
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Mock the @3ngram/core/auth module at the seam (mirrors oauth-register.test.ts).
// We need oauthClientsStore.getClient to return a test client without hitting the DB.
const mockGetClient = vi.fn<(clientId: string) => Promise<object | undefined>>()

vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  return {
    ...actual,
    oauthClientsStore: {
      getClient: mockGetClient,
    },
  }
})

const { createTestApp } = await import('./test-app.js')

const TEST_CLIENT_ID = 'test-client-csrf-001'
const TEST_REDIRECT_URI = 'https://app.example.test/callback'

let server: Server
let baseUrl: string

beforeAll(async () => {
  // Return a minimal valid OAuthClientInformation for any getClient call.
  mockGetClient.mockResolvedValue({
    client_id: TEST_CLIENT_ID,
    client_id_issued_at: 1765000000,
    client_name: 'CSRF Test Client',
    redirect_uris: [TEST_REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  })

  server = createTestApp().listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
})

/** Build a valid GET /oauth/authorize query string. */
function authorizeQuery(): string {
  return new URLSearchParams({
    client_id: TEST_CLIENT_ID,
    redirect_uri: TEST_REDIRECT_URI,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'test-state-value',
  }).toString()
}

/**
 * Extract the 'oauth_csrf' cookie value from a Set-Cookie header string.
 * The header may contain multiple Set-Cookie entries joined by ', ' or a
 * single cookie string of the form 'oauth_csrf=<value>; Path=...; ...'.
 */
function extractCsrfCookie(setCookieHeader: string | null): string | undefined {
  if (setCookieHeader === null) return undefined
  // Set-Cookie values may be comma-joined by fetch in Node.js when the server
  // sends multiple Set-Cookie headers. Search for the csrf cookie among them.
  const parts = setCookieHeader.split(/,\s*(?=[A-Za-z0-9_-]+=)/)
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name === 'oauth_csrf') {
      // The value ends at the first ';'.
      const valueEnd = part.indexOf(';', eq + 1)
      return valueEnd > eq ? part.slice(eq + 1, valueEnd).trim() : part.slice(eq + 1).trim()
    }
  }
  return undefined
}

describe('POST /oauth/authorize — CSRF mismatch', () => {
  it('returns 403 { error: "invalid_request" } when csrf_token does not match the cookie', async () => {
    // Step 1: GET the consent form to receive the double-submit CSRF pair.
    const getResponse = await fetch(`${baseUrl}/oauth/authorize?${authorizeQuery()}`)
    expect(getResponse.status).toBe(200)

    const csrfCookieValue = extractCsrfCookie(getResponse.headers.get('set-cookie'))
    expect(csrfCookieValue).toBeDefined()

    // Step 2: POST with a deliberately DIFFERENT csrf_token — mismatches the cookie.
    // The form includes all required fields from the GET so the schema validates;
    // only the csrf_token value is wrong (not the same as the issued cookie value).
    const tampered = 'TAMPERED_TOKEN_DOES_NOT_MATCH_COOKIE'
    expect(tampered).not.toBe(csrfCookieValue)

    const formBody = new URLSearchParams({
      client_id: TEST_CLIENT_ID,
      redirect_uri: TEST_REDIRECT_URI,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'test-state-value',
      email: 'user@example.test',
      password: 'any-password',
      csrf_token: tampered,
    })

    const postResponse = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Present the REAL cookie so the mismatch is token vs cookie, not absent cookie.
        cookie: `oauth_csrf=${csrfCookieValue}`,
      },
      body: formBody.toString(),
    })

    expect(postResponse.status).toBe(403)
    const json = (await postResponse.json()) as Record<string, unknown>
    expect(json).toEqual({ error: 'invalid_request' })
  })
})
