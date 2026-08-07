// SPDX-License-Identifier: Apache-2.0
// MCP completions: completion/complete over the tenant's own facets (issue #104).
//
// Driven through the REAL client SDK and handler, so the `completions` capability
// declaration, the completable-argument plumbing, and the 100-value cap are all
// exercised as a client would meet them rather than asserted about in isolation.
//
// THE SECURITY PROPERTY under test is that facet labels never cross a tenant or
// a scope boundary: the spec's completion section calls out completion-based
// information disclosure specifically, and scope/project names ARE tenant data.
import {
  type ClientOptions,
  Client as McpClient,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const TENANT = '11111111-1111-1111-1111-111111111111'

const listMemoryFacets = vi.fn((_userId: string) =>
  Promise.resolve({
    scopes: ['work', 'work-archive', 'personal'],
    projects: ['3ngram', 'platform'],
  }),
)

vi.mock('@3ngram/core', () => ({ listMemoryFacets, resolveRetrievalPolicy: vi.fn() }))

const { createMcpProtocolHandler } = await import('../src/routes/mcp.js')

const clients: McpClient[] = []
const handlers: ReturnType<typeof createMcpProtocolHandler>[] = []

function authInfo(scopes: string[]): AuthInfo {
  return {
    token: 'completion-contract-token',
    clientId: 'completion-contract-client',
    scopes,
    expiresAt: 2_000_000_000,
    resource: new URL('https://api.3ngram.test/mcp'),
    extra: { userId: TENANT },
  }
}

async function connect(scopes = ['memory:read'], options?: ClientOptions): Promise<McpClient> {
  const handler = createMcpProtocolHandler({ gateway: undefined })
  handlers.push(handler)
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo: authInfo(scopes) }),
  })
  const client = new McpClient(
    { name: 'completion-contract', version: '0.0.0' },
    options ?? { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )
  clients.push(client)
  await client.connect(transport)
  return client
}

const completeScope = (client: McpClient, value: string) =>
  client.complete({
    ref: { type: 'ref/prompt', name: 'debrief' },
    argument: { name: 'scope', value },
  })

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(handlers.splice(0).map((h) => h.close()))
  vi.clearAllMocks()
})

describe('completion over tenant facets', () => {
  it('advertises the completions capability', async () => {
    // The gap issue #104 named: the capability was never declared, so a client
    // had no reason to ask. registerPrompt auto-enables it the moment any
    // argument is completable.
    const client = await connect()
    expect(client.getServerCapabilities()?.completions).toBeDefined()
  })

  it('offers the tenant’s own scope names', async () => {
    const client = await connect()
    const result = await completeScope(client, '')
    expect(result.completion.values).toEqual(['work', 'work-archive', 'personal'])
    // The tenant comes from verified authInfo, never from the request.
    expect(listMemoryFacets).toHaveBeenCalledWith(TENANT)
  })

  it('filters by what the user has typed, case-insensitively', async () => {
    const client = await connect()
    await expect(completeScope(client, 'work')).resolves.toMatchObject({
      completion: { values: ['work', 'work-archive'] },
    })
    await expect(completeScope(client, 'WORK-')).resolves.toMatchObject({
      completion: { values: ['work-archive'] },
    })
    await expect(completeScope(client, 'zzz')).resolves.toMatchObject({
      completion: { values: [] },
    })
  })

  it('caps at 100 values and reports hasMore', async () => {
    // The SDK's createCompletionResult owns the cap; this proves we are inside
    // that boundary rather than hand-rolling a second one that could drift.
    listMemoryFacets.mockResolvedValueOnce({
      scopes: Array.from({ length: 150 }, (_, i) => `scope-${i}`),
      projects: [],
    })
    const client = await connect()
    const result = await completeScope(client, '')
    expect(result.completion.values).toHaveLength(100)
    expect(result.completion.hasMore).toBe(true)
    expect(result.completion.total).toBe(150)
  })
})

describe('completion authorization', () => {
  it('returns nothing for a token without the read scope, and never reads', async () => {
    // Fail-closed, and quiet: a completion is a UI affordance, so a denied read
    // degrades to an empty list rather than an error mid-keystroke. What matters
    // is that no facet label leaves the server.
    const client = await connect(['memory:write'])
    const result = await completeScope(client, '')
    expect(result.completion.values).toEqual([])
    expect(listMemoryFacets).not.toHaveBeenCalled()
  })

  it('returns nothing for a scopeless token', async () => {
    const client = await connect([])
    const result = await completeScope(client, '')
    expect(result.completion.values).toEqual([])
    expect(listMemoryFacets).not.toHaveBeenCalled()
  })

  it('does not complete an argument that is not completable', async () => {
    // briefing.selector is a closed enum of selector KINDS, not a scope name —
    // nothing tenant-specific to offer, and no DB read should happen for it.
    const client = await connect()
    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'briefing' },
      argument: { name: 'selector', value: '' },
    })
    expect(result.completion.values).toEqual([])
    expect(listMemoryFacets).not.toHaveBeenCalled()
  })

  it('does not offer completion for the memory resource id', async () => {
    // DELIBERATE: the memory template's only variable is a uuid. Completing it
    // would mean offering the tenant's memory ids as suggestions — the corpus
    // enumeration that `list: undefined` refused in issue #105. This asserts the
    // side door stays shut.
    const client = await connect()
    const result = await client.complete({
      ref: { type: 'ref/resource', uri: 'threengram://memory/{id}' },
      argument: { name: 'id', value: '' },
    })
    expect(result.completion.values).toEqual([])
    expect(listMemoryFacets).not.toHaveBeenCalled()
  })
})
