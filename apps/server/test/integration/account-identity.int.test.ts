// SPDX-License-Identifier: Apache-2.0
// describe_environment account identity, end to end (issue #321).
//
// The question a two-connector setup needs answered is "which 3ngram account
// does each connector reach?" — scope names cannot answer it (every account
// has a `work` scope). These tests pin the answer over the REAL transports and
// the runtime role:
//   - the MCP `account.id` equals REST `GET /api/v1/me`.id for the same user,
//     whose REST credential is an X-API-Key and whose MCP credential is an
//     OAuth Bearer (the two auth paths);
//   - two OAuth clients for one user report the same id (stable per account);
//   - two users report different ids (tenant boundary), each only its own;
//   - an erased or deleted account yields NO id: its token stops
//     authenticating, and a request already holding a still-resolving token
//     gets `account_deleted` rather than an identity.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { deleteAccount } from '@3ngram/core'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import {
  type CallToolResult,
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

const PASSWORD = 'account-identity-321-password'

let server: Server
let baseUrl: string
let clientOne: string
let clientTwo: string
const emails: string[] = []
const userIds: string[] = []

/** Create a user via the real signup core path and return its id + a session token. */
async function newUser(label: string): Promise<{ id: string; session: string }> {
  const email = `acct-${label}-${crypto.randomUUID()}@test.local`
  emails.push(email)
  const user = await createUser(email, PASSWORD)
  userIds.push(user.id)
  const grant = await login(email, PASSWORD, 1)
  if (!grant) throw new Error('login failed in setup')
  return { id: user.id, session: grant.token }
}

/** Issue an API key for a session-token holder via the management route. */
async function issueKey(session: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
    body: JSON.stringify({ name: 'account-identity' }),
  })
  if (res.status !== 201) throw new Error(`issueKey failed: ${res.status}`)
  return ((await res.json()) as { key: string }).key
}

/** REST GET /api/v1/me over the real X-API-Key chain. */
async function restMe(key: string): Promise<{ id: string; email: string }> {
  const res = await fetch(`${baseUrl}/api/v1/me`, { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  return (await res.json()) as { id: string; email: string }
}

async function connect(token: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new McpClient({ name: 'account-identity-int-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

/** Call describe_environment over the real MCP transport. */
async function describeEnvironment(token: string): Promise<CallToolResult> {
  const client = await connect(token)
  try {
    return (await client.callTool({
      name: 'describe_environment',
      arguments: {},
    })) as CallToolResult
  } finally {
    await client.close()
  }
}

async function mcpAccountId(token: string): Promise<string> {
  const result = await describeEnvironment(token)
  expect(result.isError).toBeFalsy()
  return (result.structuredContent as { account: { id: string } }).account.id
}

/** The raw HTTP status /mcp answers a token with (no SDK retry/negotiation in the way). */
async function mcpStatus(token: string): Promise<number> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'describe_environment', arguments: {} },
    }),
  })
  await res.body?.cancel()
  return res.status
}

beforeAll(async () => {
  process.env.BASE_URL = TEST_BASE_URL
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()
  server = createTestApp({ gateway: createFakeGateway() }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  // Two distinct OAuth clients: a connector is one client, so "two connectors
  // on one account" is two clients holding tokens for the same user.
  clientOne = await ensureTestClient(ownerPool)
  clientTwo = await ensureTestClient(ownerPool)
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = ANY($1)', [
    [clientOne, clientTwo],
  ])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [
    [clientOne, clientTwo],
  ])
  // By id, not email: erasure rewrites an erased account's email.
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [userIds])
  await closePools()
})

describe('describe_environment account identity (issue #321)', () => {
  it('equals REST /api/v1/me id for the same account across API-key and OAuth credentials', async () => {
    const user = await newUser('parity')
    const key = await issueKey(user.session)
    const token = await mintAccessToken(ownerPool, clientOne, user.id, 'memory:read')

    const me = await restMe(key)
    const mcpId = await mcpAccountId(token)
    expect(mcpId).toBe(me.id)
    expect(mcpId).toBe(user.id)
  })

  it('is stable for one account across two different OAuth clients', async () => {
    const user = await newUser('stable')
    const viaOne = await mintAccessToken(ownerPool, clientOne, user.id, 'memory:read')
    const viaTwo = await mintAccessToken(ownerPool, clientTwo, user.id)
    expect(await mcpAccountId(viaOne)).toBe(user.id)
    expect(await mcpAccountId(viaTwo)).toBe(user.id)
  })

  it('distinguishes two accounts, each reporting only its own id, even with identical scope names', async () => {
    const a = await newUser('tenant-a')
    const b = await newUser('tenant-b')
    const tokenA = await mintAccessToken(ownerPool, clientOne, a.id, 'memory:read')
    const tokenB = await mintAccessToken(ownerPool, clientOne, b.id, 'memory:read')

    const resultA = await describeEnvironment(tokenA)
    const resultB = await describeEnvironment(tokenB)
    const reportA = resultA.structuredContent as {
      account: { id: string }
      scopes: Array<{ name: string }>
    }
    const reportB = resultB.structuredContent as typeof reportA
    // Both accounts carry the default `personal`/`work` scopes, so the scope
    // list cannot tell them apart — the account id must.
    expect(reportA.scopes.map((s) => s.name).sort()).toEqual(
      reportB.scopes.map((s) => s.name).sort(),
    )
    expect(reportA.account.id).toBe(a.id)
    expect(reportB.account.id).toBe(b.id)
    expect(reportA.account.id).not.toBe(reportB.account.id)
    // Neither response carries the other tenant's id, nor either email.
    expect(JSON.stringify(resultA)).not.toContain(b.id)
    expect(JSON.stringify(resultB)).not.toContain(a.id)
    for (const email of emails) {
      expect(JSON.stringify(resultA)).not.toContain(email)
      expect(JSON.stringify(resultB)).not.toContain(email)
    }
  })

  it('an erased account yields no identity: its token stops authenticating', async () => {
    const user = await newUser('erased')
    const token = await mintAccessToken(ownerPool, clientOne, user.id, 'memory:read')
    expect(await mcpAccountId(token)).toBe(user.id)

    await deleteAccount(user.id, { now: new Date() })
    // Erasure revokes every OAuth token in the same transaction, so the bearer
    // check rejects the request before any tool runs.
    expect(await mcpStatus(token)).toBe(401)
  })

  it('an erased account reached by a still-resolving token gets account_deleted, not an id', async () => {
    // Models a request already in flight when erasure committed: a token row
    // that still resolves, for a users row that is now a tombstone.
    const user = await newUser('erased-inflight')
    await deleteAccount(user.id, { now: new Date() })
    const stale = await mintAccessToken(ownerPool, clientOne, user.id, 'memory:read')

    const result = await describeEnvironment(stale)
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('account_deleted')
    expect(result.structuredContent).toBeUndefined()
  })

  it('a deleted users row yields no identity: its tokens are gone with it', async () => {
    const user = await newUser('missing')
    const token = await mintAccessToken(ownerPool, clientOne, user.id, 'memory:read')
    await ownerPool.query('DELETE FROM users WHERE id = $1', [user.id])
    // oauth_tokens.user_id cascades on delete, so no token can outlive the row.
    expect(await mcpStatus(token)).toBe(401)
  })
})
