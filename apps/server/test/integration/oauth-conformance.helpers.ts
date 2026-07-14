// SPDX-License-Identifier: Apache-2.0
// Shared scaffolding for the OAuth AS conformance suites.
// The 14-case OAuth AS conformance matrix is split across several
// *.int.test.ts files (DCR, code exchange, client auth, redirect_uri, refresh,
// JWKS rotation, discovery, consent guards). This module — deliberately NOT named
// *.int.test.ts so vitest's default glob never double-runs it — owns the in-process
// app lifecycle, the REAL runtime role + REAL oauthBearerAuth stack, and the DCR /
// PKCE / token-request / full-flow helpers every suite shares.
import { createHash, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { createUser } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
// Aliased to McpClient so `new McpClient(...)` does not trip the db-access gate's
// `new (pg\.)?Client\(` regex (this is the MCP SDK client, not a Postgres client).
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { TEST_BASE_URL, TEST_JWKS } from '../oauth-token-helper.js'
import { createTestApp } from '../test-app.js'

// Re-exported so the lifecycle suites (RS-fails-closed token insert) reach the
// owner pool without a second deep relative import into packages/db.
export { ownerPool }

export const PASSWORD = 'oauth-conformance-password'
export const REDIRECT_URI = 'https://client.example/cb'

interface AppHandle {
  server: Server
  baseUrl: string
}

export interface RegisteredClient {
  client_id: string
  client_secret?: string
}

export interface ConsentPage {
  status: number
  csrfCookie: string | undefined
  csrfToken: string | undefined
  /** Every hidden <input> the server rendered — the faithful browser POST body. */
  hiddenFields: Record<string, string>
}

export interface TokenResponse {
  status: number
  json: Record<string, unknown>
  headers: Headers
}

export interface TokenSet {
  access_token: string
  refresh_token: string
  scope: string
  token_type: string
  expires_in: number
}

export const sha256hex = (value: string): string => createHash('sha256').update(value).digest('hex')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Parse every hidden <input> the consent page rendered into a body map — what a
 * real browser re-submits. Faithfulness matters: the server
 * always embeds the RESOLVED redirect_uri (even when the client omitted it), so
 * the POST always carries redirect_uri; supplied-ness rides the distinct
 * redirect_uri_was_supplied field minted at GET time, which only appears here
 * when the client actually supplied redirect_uri.
 */
function parseHiddenFields(html: string): Record<string, string> {
  const decode = (v: string): string =>
    v
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  const fields: Record<string, string> = {}
  const re = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    fields[decode(m[1] as string)] = decode(m[2] as string)
  }
  return fields
}

/**
 * Per-suite conformance harness: a started in-process app, the test user, the
 * registered-client cleanup ledger, and every flow helper bound to that app.
 * Each *.int.test.ts file owns one of these via beforeAll/afterAll — vitest runs
 * integration files with `--fileParallelism=false`, so a file's mutations to its
 * own context (e.g. the JWKS-rotation restart) never leak across files.
 */
export interface OAuthConformanceContext {
  readonly email: string
  readonly baseUrl: string
  registerClient(
    authMethod: 'none' | 'client_secret_post' | 'client_secret_basic',
  ): Promise<RegisteredClient & Record<string, unknown>>
  getConsentPage(query: Record<string, string>): Promise<ConsentPage>
  submitConsent(fields: Record<string, string>, csrfCookie: string): Promise<Response>
  obtainCode(
    clientId: string,
    challenge: string,
    extras?: Record<string, string>,
    options?: { omitRedirectUri?: boolean },
  ): Promise<{ code: string; state: string | null }>
  tokenRequest(
    fields: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<TokenResponse>
  fullFlow(scope?: string): Promise<TokenSet & { client: RegisteredClient }>
  connectMcp(token: string): Promise<McpClient>
  mcpStatus(token: string): Promise<number>
  /** Restart the app after mutating process.env (JWKS rotation). Updates baseUrl. */
  restartApp(): Promise<void>
}

const gateway = createFakeGateway()

async function startApp(): Promise<AppHandle> {
  const server = createTestApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function stopApp(handle: AppHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    handle.server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
}

/**
 * Boot a conformance harness: set BASE_URL + OAUTH_JWKS, create the test user, and
 * start the app. Call the returned `teardown()` in afterAll — it stops the app,
 * resets env, deletes the registered clients (oauth_codes/oauth_tokens cascade)
 * and the user, and closes the pools.
 */
export async function setupConformance(): Promise<{
  ctx: OAuthConformanceContext
  teardown: () => Promise<void>
}> {
  process.env.BASE_URL = TEST_BASE_URL
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()
  const email = `oauth-conf-${crypto.randomUUID()}@test.local`
  await createUser(email, PASSWORD)
  let app = await startApp()
  const registeredClientIds: string[] = []

  const registerClient: OAuthConformanceContext['registerClient'] = async (authMethod) => {
    const res = await fetch(`${app.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: authMethod,
        client_name: 'Conformance Client',
      }),
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as RegisteredClient & Record<string, unknown>
    registeredClientIds.push(json.client_id)
    return json
  }

  const getConsentPage: OAuthConformanceContext['getConsentPage'] = async (query) => {
    const res = await fetch(`${app.baseUrl}/oauth/authorize?${new URLSearchParams(query)}`, {
      redirect: 'manual',
    })
    const html = await res.text()
    const cookie = res.headers.get('set-cookie') ?? ''
    const hiddenFields = parseHiddenFields(html)
    return {
      status: res.status,
      csrfCookie: /oauth_csrf=([^;]+)/.exec(cookie)?.[1],
      csrfToken: hiddenFields.csrf_token,
      hiddenFields,
    }
  }

  const submitConsent: OAuthConformanceContext['submitConsent'] = (fields, csrfCookie) =>
    fetch(`${app.baseUrl}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `oauth_csrf=${csrfCookie}`,
      },
      body: new URLSearchParams(fields).toString(),
    })

  /** Full GET form -> POST credentials+consent -> extract code from the 302. */
  const obtainCode: OAuthConformanceContext['obtainCode'] = async (
    clientId,
    challenge,
    extras = {},
    options = {},
  ) => {
    // RFC 6749 §4.1.3: a single-registered-URI client MAY omit redirect_uri at
    // /authorize — omitRedirectUri exercises the "resolved, not supplied" branch.
    const query = {
      client_id: clientId,
      ...(options.omitRedirectUri ? {} : { redirect_uri: REDIRECT_URI }),
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-123',
      ...extras,
    }
    const page = await getConsentPage(query)
    expect(page.status).toBe(200)
    if (page.csrfCookie === undefined || page.csrfToken === undefined) {
      throw new Error('consent page did not issue a CSRF pair')
    }
    // Submit the form's ACTUAL rendered hidden fields — a faithful browser POST.
    // This carries the server-resolved redirect_uri AND, only when the client
    // supplied it at /authorize, the redirect_uri_was_supplied marker.
    // Reconstructing the body from `query` would silently drop that marker
    // and mask the supplied-vs-resolved distinction at the token endpoint.
    const res = await submitConsent(
      { ...page.hiddenFields, email, password: PASSWORD },
      page.csrfCookie,
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') as string)
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI)
    const code = location.searchParams.get('code')
    if (code === null) throw new Error('redirect carried no code')
    return { code, state: location.searchParams.get('state') }
  }

  const tokenRequest: OAuthConformanceContext['tokenRequest'] = async (fields, headers = {}) => {
    const res = await fetch(`${app.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    })
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
      headers: res.headers,
    }
  }

  /** Register (confidential), authorize, exchange — the full Claude-shaped flow. */
  const fullFlow: OAuthConformanceContext['fullFlow'] = async (scope) => {
    const client = await registerClient('client_secret_post')
    const { verifier, challenge } = pkcePair()
    const { code } = await obtainCode(client.client_id, challenge, scope ? { scope } : {})
    const { status, json } = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: client.client_secret as string,
    })
    expect(status).toBe(200)
    return { ...(json as unknown as TokenSet), client }
  }

  const connectMcp: OAuthConformanceContext['connectMcp'] = async (token) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    const client = new McpClient({ name: 'conformance', version: '0.0.0' })
    await client.connect(transport)
    return client
  }

  /** The /mcp auth verdict for a Bearer value: 401 = rejected, anything else = admitted. */
  const mcpStatus: OAuthConformanceContext['mcpStatus'] = async (token) => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    await res.text()
    return res.status
  }

  const restartApp: OAuthConformanceContext['restartApp'] = async () => {
    await stopApp(app)
    // Pick up any process.env mutation made by the caller (e.g. OAUTH_JWKS rotation).
    resetEnvCache()
    app = await startApp()
  }

  const ctx: OAuthConformanceContext = {
    email,
    get baseUrl() {
      return app.baseUrl
    },
    registerClient,
    getConsentPage,
    submitConsent,
    obtainCode,
    tokenRequest,
    fullFlow,
    connectMcp,
    mcpStatus,
    restartApp,
  }

  const teardown = async (): Promise<void> => {
    await stopApp(app)
    resetEnvCache()
    delete process.env.BASE_URL
    delete process.env.OAUTH_JWKS
    if (registeredClientIds.length > 0) {
      // oauth_codes/oauth_tokens cascade from oauth_clients (FK ON DELETE CASCADE).
      await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [
        registeredClientIds,
      ])
    }
    await ownerPool.query('DELETE FROM users WHERE email = $1', [email])
    await closePools()
  }

  return { ctx, teardown }
}
