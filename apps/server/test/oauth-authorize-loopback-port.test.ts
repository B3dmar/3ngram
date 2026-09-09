// SPDX-License-Identifier: Apache-2.0
// GET /oauth/authorize with an RFC 8252 §7.3 loopback redirect_uri — route-level
// proof of the Claude Code case.
//
// Claude Code authenticates via a CIMD document whose redirect_uris carry NO
// port (http://localhost/callback, http://127.0.0.1/callback) and then presents
// redirect_uri=http://localhost:<ephemeral>/callback, because a native client
// binds its loopback port at run time. Byte-exact matching answered that with
// 400 invalid_client (reason=redirect_uri_mismatch).
//
// Asserted here: the consent form renders, and its hidden redirect_uri field
// carries the REQUESTED (ported) URI — that field is what the consent POST
// re-resolves and what the issued code is bound to, so the ephemeral port has
// to survive the round trip. Path/host relaxation stays rejected.
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mockResolveClient = vi.fn<(clientId: string) => Promise<object | undefined>>()

vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  return { ...actual, resolveOAuthClient: mockResolveClient }
})

const { createTestApp } = await import('./test-app.js')

/** The live Claude Code client metadata document, verbatim. */
const CLAUDE_CODE_CLIENT = {
  client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
  client_id_issued_at: 1765000000,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

let server: Server
let baseUrl: string

beforeAll(async () => {
  mockResolveClient.mockResolvedValue(CLAUDE_CODE_CLIENT)
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

async function authorize(redirectUri: string): Promise<Response> {
  const query = new URLSearchParams({
    client_id: CLAUDE_CODE_CLIENT.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'test-state-value',
  })
  return fetch(`${baseUrl}/oauth/authorize?${query.toString()}`)
}

describe('GET /oauth/authorize — RFC 8252 loopback port', () => {
  it.each([
    ['localhost', 'http://localhost:53421/callback'],
    ['127.0.0.1', 'http://127.0.0.1:8129/callback'],
  ])('renders consent for an ephemeral %s port and echoes the ported URI', async (_h, uri) => {
    const response = await authorize(uri)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain(`<input type="hidden" name="redirect_uri" value="${uri}">`)
    // The form shows the host the code will redirect to, port included.
    expect(body).toContain(new URL(uri).host)
  })

  it.each([
    ['a different path', 'http://localhost:53421/evil'],
    ['a non-loopback host', 'http://app.example:53421/callback'],
    ['an added query', 'http://localhost:53421/callback?x=1'],
  ])('still rejects %s with 400 invalid_client', async (_label, uri) => {
    const response = await authorize(uri)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_client' })
  })
})
