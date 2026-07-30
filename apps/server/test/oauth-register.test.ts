// SPDX-License-Identifier: Apache-2.0
// POST /oauth/register CONTRACT tests, driven
// through createTestApp() with core's registration policy mocked at the
// established '@3ngram/core/auth' seam (cf. oauth-bearer.test.ts) — the SCHEMA
// runs for real, so every 400 here exercises the one validation boundary
// (hard rule 2). Covers: 201 public (no secret) / confidential (secret echoed
// once, Cache-Control: no-store), the RFC 7591 §2 auth-method default, the
// redirect-URI policy rejections (http non-loopback, fragment, relative,
// empty array), unknown token_endpoint_auth_method, and byte-exact
// redirect_uris pass-through. The hash-at-rest + NULL/NOT-NULL invariants of
// the 0005 CHECKs are proven against the REAL core policy in
// packages/core/test/oauth-clients.test.ts (the db-helper mock seam lives
// there — apps/server has no @3ngram/db dependency by layering, hard rule 5).
import type { Server } from 'node:http'
import type { ClientRegistrationInput } from '@3ngram/schema'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/server-legacy/auth'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeClientInformation {
  client_id: string
  client_id_issued_at: number
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: string
  client_secret?: string
  client_secret_expires_at?: number
}

const registerOAuthClient =
  vi.fn<(input: ClientRegistrationInput) => Promise<FakeClientInformation>>()

vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  return { ...actual, registerOAuthClient }
})

const { createTestApp } = await import('./test-app.js')
const { oauthClientsStore } = await import('@3ngram/core/auth')

// COMPILE-TIME contract: the core store must satisfy the retained legacy
// OAuthRegisteredClientsStore interface while DCR compatibility remains.
const sdkStore: OAuthRegisteredClientsStore = oauthClientsStore

let server: Server
let baseUrl: string

beforeAll(async () => {
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

beforeEach(() => {
  vi.clearAllMocks()
  // Echo the validated input back the way core does; mint a secret iff confidential.
  registerOAuthClient.mockImplementation(async (input) => ({
    client_id: 'client-1111',
    client_id_issued_at: 1765000000,
    client_name: input.client_name ?? 'fallback',
    redirect_uris: input.redirect_uris,
    token_endpoint_auth_method: input.token_endpoint_auth_method,
    ...(input.token_endpoint_auth_method === 'none'
      ? {}
      : { client_secret: 'one-time-secret', client_secret_expires_at: 0 }),
  }))
})

async function register(
  body: unknown,
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    headers: response.headers,
    json: (await response.json()) as Record<string, unknown>,
  }
}

describe('POST /oauth/register — 201 contract', () => {
  it('registers a public client with client_id only (no client_secret member)', async () => {
    const { status, json } = await register({
      redirect_uris: ['https://app.example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'Example',
    })
    expect(status).toBe(201)
    expect(json.client_id).toBe('client-1111')
    expect(json).not.toHaveProperty('client_secret')
    expect(json).not.toHaveProperty('client_secret_expires_at')
    expect(json.token_endpoint_auth_method).toBe('none')
    expect(json.redirect_uris).toEqual(['https://app.example.com/callback'])
    expect(registerOAuthClient).toHaveBeenCalledExactlyOnceWith({
      redirect_uris: ['https://app.example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'Example',
    })
  })

  it('registers a confidential client, echoing the one-time secret under no-store', async () => {
    const { status, headers, json } = await register({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'Claude',
    })
    expect(status).toBe(201)
    expect(json.client_secret).toBe('one-time-secret')
    // RFC 7591 §3.2.1: REQUIRED alongside client_secret; 0 = never expires.
    expect(json.client_secret_expires_at).toBe(0)
    expect(typeof json.client_id_issued_at).toBe('number')
    expect(headers.get('cache-control')).toBe('no-store')
  })

  it('defaults an omitted token_endpoint_auth_method to client_secret_basic (RFC 7591 §2)', async () => {
    const { status, json } = await register({ redirect_uris: ['https://app.example.com/cb'] })
    expect(status).toBe(201)
    expect(json.token_endpoint_auth_method).toBe('client_secret_basic')
    expect(json.client_secret).toBe('one-time-secret')
    expect(registerOAuthClient).toHaveBeenCalledExactlyOnceWith({
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    })
  })

  it('allows http loopback redirect URIs on any port', async () => {
    const uris = ['http://localhost:33418/cb', 'http://127.0.0.1:8976/cb']
    const { status, json } = await register({
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
    })
    expect(status).toBe(201)
    expect(json.redirect_uris).toEqual(uris)
  })

  it('passes path/query redirect_uri variants through byte-exact (no normalization)', async () => {
    const uris = ['https://app.example.com/cb?env=prod', 'https://app.example.com/cb']
    const { status } = await register({ redirect_uris: uris, token_endpoint_auth_method: 'none' })
    expect(status).toBe(201)
    expect(registerOAuthClient.mock.calls[0]?.[0]?.redirect_uris).toEqual(uris)
  })
})

describe('POST /oauth/register — 400 contract (schema is the one boundary)', () => {
  it.each([
    ['http outside the loopback hosts', ['http://app.example.com/callback']],
    ['a fragment', ['https://app.example.com/cb#fragment']],
    ['a relative (non-absolute) URI', ['/relative/callback']],
    ['an empty redirect_uris array', []],
  ])('400s invalid_redirect_uri for %s without reaching core', async (_label, uris) => {
    const { status, json } = await register({
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
    })
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid_redirect_uri' })
    expect(registerOAuthClient).not.toHaveBeenCalled()
  })

  it('400s an unknown token_endpoint_auth_method with invalid_client_metadata', async () => {
    const { status, json } = await register({
      redirect_uris: ['https://app.example.com/cb'],
      token_endpoint_auth_method: 'private_key_jwt',
    })
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid_client_metadata' })
    expect(registerOAuthClient).not.toHaveBeenCalled()
  })
})

describe('oauthClientsStore (the A2 contract)', () => {
  it('exposes the SDK-shaped getClient (assignability pinned at compile time above)', () => {
    expect(typeof sdkStore.getClient).toBe('function')
    // registerClient is DELIBERATELY absent: DCR is served only by this route,
    // so the SDK router never mounts its own permissive /register handler.
    expect(sdkStore.registerClient).toBeUndefined()
  })
})
