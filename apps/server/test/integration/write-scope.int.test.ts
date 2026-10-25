// SPDX-License-Identifier: Apache-2.0
// Write-scope policy (issue #235) end to end THROUGH the real transports: the
// MCP Streamable HTTP endpoint (OAuth Bearer) and REST /api/v1 (X-API-Key), the
// real runtime role, and the real user_write_scope_policy row.
//
//   - never configured: describe_environment reports { off, null } next to the
//     retrieval policy; an unscoped remember lands in 'personal'
//   - set_write_default default:'work': an unscoped remember lands in 'work' on
//     both transports and the echo reports the scope that was WRITTEN
//   - require: an unscoped remember is a typed invalid-input error on both
//     transports and writes NO memory row; an explicit scope still writes
//   - an alias or unregistered name cannot become the default
//   - tenant A's policy never changes where tenant B's writes land
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
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

const PASSWORD = 'write-scope-int-password'
const gateway = createFakeGateway()

let server: Server
let baseUrl: string
let clientId: string
const emails: string[] = []

interface Tenant {
  id: string
  key: string
  mcp: McpClient
}
let a: Tenant
let b: Tenant

async function issueKey(token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'write-scope' }),
  })
  if (res.status !== 201) throw new Error(`issueKey failed: ${res.status}`)
  return ((await res.json()) as { key: string }).key
}

async function tenant(label: string): Promise<Tenant> {
  const email = `write-scope-${label}-${crypto.randomUUID()}@test.local`
  emails.push(email)
  const user = await createUser(email, PASSWORD)
  const grant = await login(email, PASSWORD, 1)
  if (!grant) throw new Error('login failed in setup')
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: { authorization: `Bearer ${await mintAccessToken(ownerPool, clientId, user.id)}` },
    },
  })
  const mcp = new McpClient({ name: 'int-test', version: '0.0.0' })
  await mcp.connect(transport)
  return { id: user.id, key: await issueKey(grant.token), mcp }
}

async function configure(t: Tenant, args: Record<string, unknown>) {
  return t.mcp.callTool({ name: 'configure_scope', arguments: args })
}

async function setWriteDefault(t: Tenant, mode: string, scope: string | null) {
  const result = await configure(t, { action: 'set_write_default', scope, mode })
  expect(result.isError).toBeFalsy()
  expect(result.structuredContent).toEqual({ action: 'write_default_set', policy: { mode, scope } })
}

async function describeEnv(t: Tenant) {
  const result = await t.mcp.callTool({ name: 'describe_environment', arguments: {} })
  expect(result.isError).toBeFalsy()
  return result.structuredContent as {
    retrievalScopePolicy: { mode: string; scope: string | null }
    writeScopePolicy: { mode: string; scope: string | null }
  }
}

async function mcpRemember(t: Tenant, content: string, extra: Record<string, unknown> = {}) {
  return t.mcp.callTool({
    name: 'remember',
    arguments: { memoryType: 'note', topic: 'write-scope', content, ...extra },
  })
}

async function restRemember(t: Tenant, content: string, extra: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': t.key },
    body: JSON.stringify({ memoryType: 'note', topic: 'write-scope', content, ...extra }),
  })
}

async function storedScope(userId: string, content: string): Promise<string[]> {
  const r = await ownerPool.query(
    'SELECT scope FROM memories WHERE user_id = $1 AND content = $2',
    [userId, content],
  )
  return r.rows.map((row: { scope: string }) => row.scope)
}

const unique = (label: string) => `${label}-${crypto.randomUUID()}`

beforeAll(async () => {
  process.env.BASE_URL = TEST_BASE_URL
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()
  clientId = await ensureTestClient(ownerPool)
  server = createTestApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  a = await tenant('a')
  b = await tenant('b')
  for (const name of ['work', 'personal']) {
    expect((await configure(a, { action: 'create', name, aliases: [] })).isError).toBeFalsy()
  }
  const aliased = await configure(a, { action: 'set_aliases', name: 'work', aliases: ['job'] })
  expect(aliased.isError).toBeFalsy()
})

afterAll(async () => {
  await a?.mcp.close()
  await b?.mcp.close()
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [emails])
  await closePools()
})

describe('write-scope policy end to end (issue #235)', () => {
  it("never configured: reports off next to the retrieval policy; unscoped writes land in 'personal'", async () => {
    const env = await describeEnv(a)
    expect(env.writeScopePolicy).toEqual({ mode: 'off', scope: null })
    expect(env.retrievalScopePolicy).toEqual({ mode: 'off', scope: null })

    const content = unique('off-mcp')
    const result = await mcpRemember(a, content)
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { memory: { scope: string } }).memory.scope).toBe(
      'personal',
    )
    expect(await storedScope(a.id, content)).toEqual(['personal'])
  })

  it('default: an unscoped remember lands in the configured scope on MCP and REST, echoed', async () => {
    await setWriteDefault(a, 'default', 'work')
    expect((await describeEnv(a)).writeScopePolicy).toEqual({ mode: 'default', scope: 'work' })

    const viaMcp = unique('default-mcp')
    const mcpResult = await mcpRemember(a, viaMcp)
    expect(mcpResult.isError).toBeFalsy()
    expect((mcpResult.structuredContent as { memory: { scope: string } }).memory.scope).toBe('work')
    expect(await storedScope(a.id, viaMcp)).toEqual(['work'])

    const viaRest = unique('default-rest')
    const res = await restRemember(a, viaRest)
    expect(res.status).toBe(201)
    expect(((await res.json()) as { memory: { scope: string } }).memory.scope).toBe('work')
    expect(await storedScope(a.id, viaRest)).toEqual(['work'])

    // Explicit input wins, including an explicit 'personal'.
    const explicit = unique('default-explicit')
    expect((await restRemember(a, explicit, { scope: 'personal' })).status).toBe(201)
    expect(await storedScope(a.id, explicit)).toEqual(['personal'])
  })

  it('tenant A’s default never changes where tenant B’s unscoped writes land', async () => {
    const content = unique('b-under-a-default')
    const res = await restRemember(b, content)
    expect(res.status).toBe(201)
    expect(((await res.json()) as { memory: { scope: string } }).memory.scope).toBe('personal')
    expect(await storedScope(b.id, content)).toEqual(['personal'])
    expect((await describeEnv(b)).writeScopePolicy).toEqual({ mode: 'off', scope: null })
  })

  it('an alias or an unregistered scope cannot become the default (not_found, policy unchanged)', async () => {
    for (const scope of ['job', 'never-registered']) {
      const result = await configure(a, { action: 'set_write_default', scope, mode: 'default' })
      expect(result.isError).toBe(true)
      expect((result.content as { text: string }[])[0]?.text).toContain('not_found')
    }
    // B cannot point its default at a scope only A registered.
    const cross = await configure(b, {
      action: 'set_write_default',
      scope: 'work',
      mode: 'default',
    })
    expect(cross.isError).toBe(true)
    expect((await describeEnv(a)).writeScopePolicy).toEqual({ mode: 'default', scope: 'work' })
    expect((await describeEnv(b)).writeScopePolicy).toEqual({ mode: 'off', scope: null })
  })

  it('require: an unscoped remember is rejected on MCP and REST and writes nothing', async () => {
    await setWriteDefault(a, 'require', null)

    const viaMcp = unique('require-mcp')
    const mcpResult = await mcpRemember(a, viaMcp)
    expect(mcpResult.isError).toBe(true)
    const text = (mcpResult.content as { text: string }[])[0]?.text ?? ''
    expect(text).toMatch(/^invalid input: .*pass scope/)
    expect(text).not.toContain(viaMcp)

    const viaRest = unique('require-rest')
    const res = await restRemember(a, viaRest)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; detail?: string }
    expect(body.error).toBe('invalid_input')
    expect(body.detail).toMatch(/pass scope/)

    expect(await storedScope(a.id, viaMcp)).toEqual([])
    expect(await storedScope(a.id, viaRest)).toEqual([])
    // No embed or budget work for the rejected calls is pinned deterministically
    // in packages/core (write-scope-policy.int.test.ts); background embeds from
    // the earlier writes make a gateway-call count racy here.

    // An explicit scope still writes under require.
    const explicit = unique('require-explicit')
    const ok = await mcpRemember(a, explicit, { scope: 'work' })
    expect(ok.isError).toBeFalsy()
    expect(await storedScope(a.id, explicit)).toEqual(['work'])
  })

  it('tenant A’s require never blocks tenant B’s unscoped writes', async () => {
    const content = unique('b-under-a-require')
    const result = await mcpRemember(b, content)
    expect(result.isError).toBeFalsy()
    expect(await storedScope(b.id, content)).toEqual(['personal'])
  })

  it('back to off restores the personal literal', async () => {
    await setWriteDefault(a, 'off', null)
    const content = unique('off-again')
    expect((await restRemember(a, content)).status).toBe(201)
    expect(await storedScope(a.id, content)).toEqual(['personal'])
  })
})
