// SPDX-License-Identifier: Apache-2.0
// threengram://facets over the REAL transport and runtime role (issue #168).
//
// An agent must be able to learn the tenant's live scope and project names
// without already knowing them and without a new tool. These tests pin:
//   - resources/list advertises EXACTLY the facets resource (the memory
//     template stays unlisted — no corpus enumeration);
//   - resources/read returns the token tenant's {scopes, projects}, the same
//     payload REST GET /api/v1/memories/facets serves, and describe_environment
//     inlines the same inventory for hosts that never surface resources;
//   - tenant B sees only its own labels (RLS);
//   - an account with no live memories reads {scopes: [], projects: []} even
//     when its scope REGISTRY holds a scope (registered-but-empty scopes are
//     configure_scope's list, not facets);
//   - superseded/archived memories do not contribute labels;
//   - a read-only token may read it (same scope gate as the memory resource).
// Seeded labels are test-local random strings; no memory content is asserted.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import { MAX_INLINE_FACET_LABELS } from '@3ngram/schema'
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

const PASSWORD = 'mcp-facets-168-password'
const FACETS_URI = 'threengram://facets'

interface Facets {
  scopes: string[]
  projects: string[]
}

let server: Server
let baseUrl: string
let clientId: string
const userIds: string[] = []

// Unique labels per run so a shared DB cannot make an assertion pass by accident.
const tag = crypto.randomUUID().slice(0, 8)
const scopeA = `client-a-${tag}`
const projectA = `project-a-${tag}`
const scopeB = `client-b-${tag}`
const projectB = `project-b-${tag}`
const archivedScope = `archived-${tag}`
const supersededProject = `superseded-${tag}`

let userA: string
let userB: string
let userEmpty: string
let keyA: string
// One token per (user, scope grant): two identical grants minted in the same
// second would sign byte-identical JWTs and collide on oauth_tokens.token_hash.
let tokenARead: string
let tokenAFull: string
let tokenAWrite: string
let tokenBRead: string
let tokenEmpty: string
let tokenMany: string

async function newUser(label: string): Promise<{ id: string; session: string }> {
  const email = `facets-${label}-${crypto.randomUUID()}@test.local`
  const user = await createUser(email, PASSWORD)
  userIds.push(user.id)
  const grant = await login(email, PASSWORD, 1)
  if (!grant) throw new Error('login failed in setup')
  return { id: user.id, session: grant.token }
}

/** Seed one memory row (owner connection — RLS bypassed for setup only). */
async function seed(
  userId: string,
  scope: string,
  project: string | null,
  lifecycle: 'live' | 'archived' | 'superseded' = 'live',
): Promise<void> {
  await ownerPool.query(
    // A superseded row has a CLOSED validity window (valid_from <= valid_to).
    `INSERT INTO memories
       (user_id, memory_type, topic, content, content_hash, scope, project, status, valid_from, valid_to)
     VALUES ($1, 'note', 't', 'c', $2, $3, $4, $5, now() - interval '1 hour',
             CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
    [
      userId,
      `facets-${crypto.randomUUID()}`,
      scope,
      project,
      lifecycle === 'archived' ? 'archived' : 'active',
      lifecycle === 'superseded',
    ],
  )
}

async function connect(token: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new McpClient({ name: 'mcp-facets-int-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function readFacets(token: string): Promise<Facets> {
  const client = await connect(token)
  try {
    const read = await client.readResource({ uri: FACETS_URI })
    expect(read.contents).toHaveLength(1)
    expect(read.contents[0]?.mimeType).toBe('application/json')
    return JSON.parse(read.contents[0]?.text as string) as Facets
  } finally {
    await client.close()
  }
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
  clientId = await ensureTestClient(ownerPool)

  const a = await newUser('a')
  const b = await newUser('b')
  const empty = await newUser('empty')
  userA = a.id
  userB = b.id
  userEmpty = empty.id

  const res = await fetch(`${baseUrl}/auth/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.session}` },
    body: JSON.stringify({ name: 'facets' }),
  })
  if (res.status !== 201) throw new Error(`issueKey failed: ${res.status}`)
  keyA = ((await res.json()) as { key: string }).key

  tokenARead = await mintAccessToken(ownerPool, clientId, userA, 'memory:read')
  tokenAFull = await mintAccessToken(ownerPool, clientId, userA)
  tokenAWrite = await mintAccessToken(ownerPool, clientId, userA, 'memory:write')
  tokenBRead = await mintAccessToken(ownerPool, clientId, userB, 'memory:read')
  tokenEmpty = await mintAccessToken(ownerPool, clientId, userEmpty)
  const many = await newUser('many')
  tokenMany = await mintAccessToken(ownerPool, clientId, many.id, 'memory:read')
  // One more distinct live project than describe_environment inlines.
  for (let i = 0; i <= MAX_INLINE_FACET_LABELS; i += 1) {
    await seed(many.id, 'work', `many-${tag}-${String(i).padStart(3, '0')}`)
  }

  await seed(userA, scopeA, projectA)
  await seed(userA, 'work', null)
  // Non-live rows must not contribute labels.
  await seed(userA, archivedScope, null, 'archived')
  await seed(userA, scopeA, supersededProject, 'superseded')
  await seed(userB, scopeB, projectB)
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1)', [userIds])
  await closePools()
})

describe('threengram://facets resource (issue #168, real transport)', () => {
  it('resources/list advertises exactly the facets resource', async () => {
    const client = await connect(tokenARead)
    const listed = await client.listResources()
    await client.close()
    expect(listed.resources.map((r) => r.uri)).toEqual([FACETS_URI])
  })

  it('reads the token tenant’s live scopes and projects — the REST facets payload', async () => {
    const facets = await readFacets(tokenARead)
    expect(facets).toEqual({ scopes: [scopeA, 'work'].sort(), projects: [projectA] })
    // Archived and superseded rows contribute nothing.
    expect(facets.scopes).not.toContain(archivedScope)
    expect(facets.projects).not.toContain(supersededProject)

    const rest = await fetch(`${baseUrl}/api/v1/memories/facets`, {
      headers: { 'x-api-key': keyA },
    })
    expect(rest.status).toBe(200)
    expect(await rest.json()).toEqual(facets)
  })

  it('tenant B sees only its own labels', async () => {
    const facetsB = await readFacets(tokenBRead)
    expect(facetsB).toEqual({ scopes: [scopeB], projects: [projectB] })
    expect(facetsB.scopes).not.toContain(scopeA)
    expect(facetsB.projects).not.toContain(projectA)
  })

  it('an account with no live memories reads empty arrays, though its registry has scopes', async () => {
    const token = tokenEmpty
    // Register a scope with no memory in it: the registry is a different list.
    const registeredOnly = `registered-${tag}`
    const client = await connect(token)
    const created = await client.callTool({
      name: 'configure_scope',
      arguments: { action: 'create', name: registeredOnly },
    })
    expect(created.isError).toBeFalsy()
    const env = await client.callTool({ name: 'describe_environment', arguments: {} })
    await client.close()

    expect(await readFacets(token)).toEqual({ scopes: [], projects: [] })
    const report = env.structuredContent as { facets: Facets; scopes: Array<{ name: string }> }
    expect(report.facets).toEqual({
      scopes: [],
      projects: [],
      truncated: { scopes: false, projects: false },
    })
    expect(report.scopes.map((s) => s.name)).toContain(registeredOnly)
  })

  it('describe_environment inlines the same inventory as the resource', async () => {
    const token = tokenAFull
    const client = await connect(token)
    const env = await client.callTool({ name: 'describe_environment', arguments: {} })
    await client.close()
    expect(env.isError).toBeFalsy()
    const report = env.structuredContent as { facets: Facets; account: { id: string } }
    // Under the cap: the same labels as the resource, nothing truncated.
    expect(report.facets).toEqual({
      ...(await readFacets(token)),
      truncated: { scopes: false, projects: false },
    })
    expect(report.account.id).toBe(userA)
  })

  it('caps the INLINE copy at MAX_INLINE_FACET_LABELS and flags it; the resource stays complete', async () => {
    const client = await connect(tokenMany)
    const env = await client.callTool({ name: 'describe_environment', arguments: {} })
    await client.close()
    expect(env.isError).toBeFalsy()
    const inline = (
      env.structuredContent as {
        facets: Facets & { truncated: { scopes: boolean; projects: boolean } }
      }
    ).facets
    const full = await readFacets(tokenMany)
    expect(full.projects).toHaveLength(MAX_INLINE_FACET_LABELS + 1)
    // The first labels in ASC order, and the flag says the list was cut.
    expect(inline.projects).toEqual(full.projects.slice(0, MAX_INLINE_FACET_LABELS))
    expect(inline.truncated).toEqual({ scopes: false, projects: true })
    expect(inline.scopes).toEqual(full.scopes)
  })

  it('refuses a write-only token (same scope gate as the memory resource)', async () => {
    const client = await connect(tokenAWrite)
    await expect(client.readResource({ uri: FACETS_URI })).rejects.toThrow()
    await client.close()
  })
})
