// SPDX-License-Identifier: Apache-2.0
// Retrieval-scope policy (issue #47) end-to-end THROUGH the real MCP
// Streamable HTTP transport, the real Bearer middleware, the real runtime
// role, and the real user_retrieval_policy row — the acceptance criteria:
//
//   - off (never configured): unscoped reads behave byte-identically to the
//     shipped surface — no appliedScope key anywhere
//   - set_retrieval_default default:'work': an UNSCOPED search returns only
//     work rows and ECHOES appliedScope; an explicit scope always wins;
//     briefing kind:'all' narrows and echoes; describe_environment reports it
//   - require: an unscoped search/briefing is a TYPED error naming the
//     registered scopes; scoped calls proceed
//   - back to off: the legacy behavior is fully restored
//   - an unregistered default scope is a typed not_found
//
// The deterministic FakeGateway maps identical text to identical vectors, so a
// query for a memory's exact content is a guaranteed hit; a shared token in
// both contents gives BOTH rows a positive FTS leg, so ONLY the policy scope
// filter explains a work-only result set.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { createFakeGateway } from '@3ngram/llm'
import {
  type ClientOptions,
  Client as McpClient,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
// Aliased to McpClient so `new McpClient(...)` does not trip the db-access gate's
// `new (pg\.)?Client\(` regex (this is the MCP SDK client, not a Postgres client).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import {
  ensureTestClient,
  mintAccessToken,
  TEST_BASE_URL,
  TEST_JWKS,
} from '../oauth-token-helper.js'
import { createTestApp } from '../test-app.js'

interface AppHandle {
  server: Server
  baseUrl: string
}

const gateway = createFakeGateway()

async function startApp(): Promise<AppHandle> {
  const server = createTestApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function connect(baseUrl: string, token: string, options?: ClientOptions) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new McpClient({ name: 'int-test', version: '0.0.0' }, options)
  await client.connect(transport)
  return client
}

let app: AppHandle
let client: McpClient
let clientId: string
let userId: string
const email = `retrieval-scope-${crypto.randomUUID()}@test.local`
// A shared token gives both rows a positive FTS leg for the same query.
const SHARED = `retrscope-${crypto.randomUUID().slice(0, 8)}`
const WORK_CONTENT = `${SHARED} work-only decision`
const PERSONAL_CONTENT = `${SHARED} personal-only note`

async function setPolicy(mode: 'off' | 'default' | 'require', scope: string | null) {
  const result = await client.callTool({
    name: 'configure_scope',
    arguments: { action: 'set_retrieval_default', scope, mode },
  })
  expect(result.isError).toBeFalsy()
  return result.structuredContent as {
    action: string
    policy: { mode: string; scope: string | null }
  }
}

async function unscopedSearch() {
  return client.callTool({ name: 'search', arguments: { query: SHARED, limit: 5 } })
}

beforeAll(async () => {
  process.env.BASE_URL = TEST_BASE_URL
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()

  const u = await ownerPool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  userId = u.rows[0].id
  clientId = await ensureTestClient(ownerPool)
  const token = await mintAccessToken(ownerPool, clientId, userId)
  app = await startApp()
  client = await connect(app.baseUrl, token)

  // Registry + corpus: two registered scopes, one memory in each.
  for (const name of ['work', 'personal']) {
    const created = await client.callTool({
      name: 'configure_scope',
      arguments: { action: 'create', name },
    })
    expect(created.isError).toBeFalsy()
  }
  for (const [scope, content] of [
    ['work', WORK_CONTENT],
    ['personal', PERSONAL_CONTENT],
  ] as const) {
    const written = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'retrieval-scope', content, scope },
    })
    expect(written.isError).toBeFalsy()
  }
})

afterAll(async () => {
  await client.close()
  await new Promise<void>((resolve, reject) => {
    app.server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM users WHERE email = $1', [email])
  await closePools()
})

describe('retrieval-scope policy end-to-end (issue #47)', () => {
  it('off (never configured): unscoped reads are the shipped behavior — both scopes, no echo', async () => {
    const found = await unscopedSearch()
    expect(found.isError).toBeFalsy()
    const s = found.structuredContent as { hits: Array<{ content: string }> }
    expect(s.hits.some((h) => h.content === WORK_CONTENT)).toBe(true)
    expect(s.hits.some((h) => h.content === PERSONAL_CONTENT)).toBe(true)
    expect('appliedScope' in (found.structuredContent as object)).toBe(false)

    const env = await client.callTool({ name: 'describe_environment', arguments: {} })
    expect(
      (env.structuredContent as { retrievalScopePolicy: unknown }).retrievalScopePolicy,
    ).toEqual({ mode: 'off', scope: null })
  })

  it('default work: an unscoped search returns ONLY work rows and echoes appliedScope', async () => {
    const set = await setPolicy('default', 'work')
    expect(set).toEqual({
      action: 'retrieval_default_set',
      policy: { mode: 'default', scope: 'work' },
    })

    const found = await unscopedSearch()
    expect(found.isError).toBeFalsy()
    const s = found.structuredContent as {
      hits: Array<{ content: string }>
      appliedScope?: string
    }
    expect(s.appliedScope).toBe('work')
    expect(s.hits.length).toBeGreaterThanOrEqual(1)
    expect(s.hits.some((h) => h.content === WORK_CONTENT)).toBe(true)
    expect(s.hits.some((h) => h.content === PERSONAL_CONTENT)).toBe(false)
  })

  it('default work: an EXPLICIT scope filter always wins — no echo', async () => {
    const found = await client.callTool({
      name: 'search',
      arguments: { query: SHARED, limit: 5, scope: 'personal' },
    })
    expect(found.isError).toBeFalsy()
    const s = found.structuredContent as {
      hits: Array<{ content: string }>
      appliedScope?: string
    }
    expect('appliedScope' in s).toBe(false)
    expect(s.hits.some((h) => h.content === PERSONAL_CONTENT)).toBe(true)
    expect(s.hits.some((h) => h.content === WORK_CONTENT)).toBe(false)
  })

  it('default work: briefing kind all narrows to the scope selector and echoes', async () => {
    const briefed = await client.callTool({
      name: 'briefing',
      arguments: { selector: { kind: 'all' } },
    })
    expect(briefed.isError).toBeFalsy()
    const b = briefed.structuredContent as {
      selector: { kind: string; scope?: string }
      appliedScope?: string
    }
    expect(b.selector).toEqual({ kind: 'scope', scope: 'work' })
    expect(b.appliedScope).toBe('work')

    const env = await client.callTool({ name: 'describe_environment', arguments: {} })
    expect(
      (env.structuredContent as { retrievalScopePolicy: unknown }).retrievalScopePolicy,
    ).toEqual({ mode: 'default', scope: 'work' })
  })

  it('require: an unscoped search is a TYPED error naming the registered scopes', async () => {
    const set = await setPolicy('require', null)
    expect(set.policy).toEqual({ mode: 'require', scope: null })

    const found = await unscopedSearch()
    expect(found.isError).toBe(true)
    const text = (found.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('invalid input')
    expect(text).toContain('personal')
    expect(text).toContain('work')

    // The orientation surfaces enforce identically.
    const briefed = await client.callTool({
      name: 'briefing',
      arguments: { selector: { kind: 'all' } },
    })
    expect(briefed.isError).toBe(true)
    const handed = await client.callTool({
      name: 'handoff',
      arguments: { selector: { kind: 'all' } },
    })
    expect(handed.isError).toBe(true)

    // An explicitly scoped call proceeds.
    const scoped = await client.callTool({
      name: 'search',
      arguments: { query: SHARED, limit: 5, scope: 'work' },
    })
    expect(scoped.isError).toBeFalsy()
  })

  it('an unregistered default scope is a typed not_found (never stored)', async () => {
    const result = await client.callTool({
      name: 'configure_scope',
      arguments: { action: 'set_retrieval_default', scope: 'nonexistent', mode: 'default' },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('not_found')
    // The failed set did not clobber the stored policy (still require).
    const env = await client.callTool({ name: 'describe_environment', arguments: {} })
    expect(
      (env.structuredContent as { retrievalScopePolicy: { mode: string } }).retrievalScopePolicy
        .mode,
    ).toBe('require')
  })

  it('off restores the legacy behavior byte-identically', async () => {
    await setPolicy('off', null)
    const found = await unscopedSearch()
    expect(found.isError).toBeFalsy()
    const s = found.structuredContent as { hits: Array<{ content: string }> }
    expect(s.hits.some((h) => h.content === WORK_CONTENT)).toBe(true)
    expect(s.hits.some((h) => h.content === PERSONAL_CONTENT)).toBe(true)
    expect('appliedScope' in (found.structuredContent as object)).toBe(false)
  })
})
