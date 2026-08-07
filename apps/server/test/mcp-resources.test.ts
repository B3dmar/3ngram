// SPDX-License-Identifier: Apache-2.0
// MCP resources: threengram://memory/{id} (issue #105).
//
// Driven through the REAL client SDK and the real dual-era handler rather than
// by calling the callback directly. That is deliberate: the first version of
// this feature specified a `3ngram://` scheme, which typechecks fine, reads fine,
// and is not a parseable URI (RFC 3986 requires a scheme to start with a letter).
// Only a round trip through the SDK's own URL handling catches that class of bug,
// so these tests exercise the transport rather than the function.
//
// Core is mocked: the design questions here are addressing, projection, caching
// and authorization — none of which need a database.
import {
  type ClientOptions,
  Client as McpClient,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const MEMORY_ID = '0197f3a1-3b7c-7c9a-9f2e-000000000001'
const OTHER_TENANT_ID = '0197f3a1-3b7c-7c9a-9f2e-000000000002'

class MemoryNotFoundError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super(`no memory ${memoryId} for this tenant`)
    this.name = 'MemoryNotFoundError'
    this.memoryId = memoryId
  }
}

const STORED = {
  id: MEMORY_ID,
  memoryType: 'decision',
  topic: 'we picked Postgres',
  content: 'We picked Postgres over DynamoDB because the access patterns are relational.',
  scope: 'work',
  project: '3ngram',
  // Lifecycle state the projection must NOT carry.
  status: 'archived',
  commitmentStatus: 'resolved',
  tags: ['db', 'architecture'],
  validFrom: new Date('2026-01-01T00:00:00.000Z'),
  validTo: new Date('2026-02-01T00:00:00.000Z'),
  recordedAt: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

const getMemoryById = vi.fn((_userId: string, memoryId: string) => {
  // The core contract: an id belonging to another tenant is RLS-filtered to
  // nothing and surfaces as the SAME error as an unknown id.
  if (memoryId !== MEMORY_ID) return Promise.reject(new MemoryNotFoundError(memoryId))
  return Promise.resolve(STORED)
})

vi.mock('@3ngram/core', () => ({
  getMemoryById,
  MemoryNotFoundError,
  resolveRetrievalPolicy: vi.fn(),
}))

const { MEMORY_RESOURCE_CACHE_TTL_MS, MEMORY_RESOURCE_TEMPLATE } = await import(
  '../src/mcp/resources.js'
)
const { createMcpProtocolHandler } = await import('../src/routes/mcp.js')

const clients: McpClient[] = []
const handlers: ReturnType<typeof createMcpProtocolHandler>[] = []

function authInfo(scopes: string[]): AuthInfo {
  return {
    token: 'resource-contract-token',
    clientId: 'resource-contract-client',
    scopes,
    expiresAt: 2_000_000_000,
    resource: new URL('https://api.3ngram.test/mcp'),
    extra: { userId: '11111111-1111-1111-1111-111111111111' },
  }
}

async function connect(scopes = ['memory:read'], options?: ClientOptions): Promise<McpClient> {
  const handler = createMcpProtocolHandler({ gateway: undefined })
  handlers.push(handler)
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo: authInfo(scopes) }),
  })
  const client = new McpClient(
    { name: 'resource-contract', version: '0.0.0' },
    options ?? { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )
  clients.push(client)
  await client.connect(transport)
  return client
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(handlers.splice(0).map((h) => h.close()))
  vi.clearAllMocks()
})

describe('memory resource addressing', () => {
  it('advertises a template whose scheme is a PARSEABLE URI', () => {
    // The regression that motivated this file. `new URL()` on a digit-leading
    // scheme throws, so `3ngram://memory/{id}` could never have been read.
    expect(() => new URL(MEMORY_RESOURCE_TEMPLATE.replace('{id}', MEMORY_ID))).not.toThrow()
    expect(MEMORY_RESOURCE_TEMPLATE.startsWith('3ngram://')).toBe(false)
    expect(/^[a-z][a-z0-9+.-]*:/.test(MEMORY_RESOURCE_TEMPLATE)).toBe(true)
  })

  it('lists the memory template with its cache hint', async () => {
    const client = await connect()
    const listed = await client.listResourceTemplates()
    expect(listed.resourceTemplates.map((t) => t.uriTemplate)).toContain(MEMORY_RESOURCE_TEMPLATE)
  })

  it('does NOT enumerate the corpus through resources/list', async () => {
    // `list: undefined` on the template: enumerating a tenant's memories is the
    // firehose the no-firehose rule exists to prevent.
    const client = await connect()
    const listed = await client.listResources()
    expect(listed.resources).toHaveLength(0)
  })
})

describe('memory resource read', () => {
  it('returns the stored body for an owned id', async () => {
    const client = await connect()
    const read = await client.readResource({ uri: `threengram://memory/${MEMORY_ID}` })
    const body = JSON.parse(read.contents[0]?.text as string)
    expect(body).toMatchObject({
      id: MEMORY_ID,
      content: STORED.content,
      topic: STORED.topic,
      memoryType: 'decision',
      scope: 'work',
      project: '3ngram',
    })
    expect(getMemoryById).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', MEMORY_ID)
  })

  it('omits every mutable lifecycle field (the invariant the long TTL rests on)', async () => {
    // THE load-bearing assertion. The stored row deliberately carries an
    // archived status, a resolved commitment, tags, and a closed validTo — all
    // things supersession/archive/resolve move. If any leaks into a body cached
    // for 24 hours, the cache serves stale answers.
    const client = await connect()
    const read = await client.readResource({ uri: `threengram://memory/${MEMORY_ID}` })
    const body = JSON.parse(read.contents[0]?.text as string)
    for (const mutable of ['status', 'validTo', 'validFrom', 'commitmentStatus', 'tags']) {
      expect(body, `${mutable} must not ride in a cacheable body`).not.toHaveProperty(mutable)
    }
  })

  it('caches privately, never publicly, and not on the catalog TTL', async () => {
    const client = await connect()
    const read = await client.readResource({ uri: `threengram://memory/${MEMORY_ID}` })
    // `public` would let a shared cache serve one tenant's memory to another.
    expect(read).toMatchObject({
      cacheScope: 'private',
      ttlMs: MEMORY_RESOURCE_CACHE_TTL_MS,
    })
  })

  it('reports an unknown id and a cross-tenant id identically', async () => {
    // No existence oracle: "not yours" must be indistinguishable from "no such
    // memory", or the URI enumerates other tenants' ids.
    const client = await connect()
    const unknown = await client
      .readResource({ uri: `threengram://memory/${OTHER_TENANT_ID}` })
      .catch((err: Error) => err)
    const malformed = await client
      .readResource({ uri: 'threengram://memory/nope' })
      .catch((err: Error) => err)
    expect(unknown).toBeInstanceOf(Error)
    expect(malformed).toBeInstanceOf(Error)
    // The invariant is INDISTINGUISHABILITY, not silence: echoing the caller's
    // own id back leaks nothing (they chose it). What must not differ is the
    // failure CLASS — a distinct "malformed uuid" vs "not found" would let a
    // caller separate "no such memory" from "exists, not yours".
    const shape = (err: unknown) =>
      (err as Error).message.replace(OTHER_TENANT_ID, '<ID>').replace('nope', '<ID>')
    expect(shape(malformed)).toBe(shape(unknown))
  })

  it('refuses a token without the read scope, fail-closed', async () => {
    // The resource analogue of runTool's scope gate. A write-only token must not
    // read memory content through a resource that no tool would have served it.
    const client = await connect(['memory:write'])
    await expect(client.readResource({ uri: `threengram://memory/${MEMORY_ID}` })).rejects.toThrow()
    expect(getMemoryById).not.toHaveBeenCalled()
  })

  it('refuses a scopeless token', async () => {
    const client = await connect([])
    await expect(client.readResource({ uri: `threengram://memory/${MEMORY_ID}` })).rejects.toThrow()
    expect(getMemoryById).not.toHaveBeenCalled()
  })
})
