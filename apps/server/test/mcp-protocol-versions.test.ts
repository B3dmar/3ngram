// SPDX-License-Identifier: Apache-2.0
// Dual-era MCP contract: one handler must serve the legacy 2025 handshake,
// a client pinned to 2026-07-28, and automatic era negotiation. The handler is
// driven in-process through its real fetch face, so no sockets or DB are needed.
import {
  type ClientOptions,
  Client as McpClient,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import type { AuthInfo, ProtocolEra } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_CATALOG_CACHE_TTL_MS } from '../src/mcp/server.js'
import { createMcpProtocolHandler } from '../src/routes/mcp.js'

const authInfo: AuthInfo = {
  token: 'protocol-contract-token',
  clientId: 'protocol-contract-client',
  scopes: ['memory:read', 'memory:write'],
  expiresAt: 2_000_000_000,
  resource: new URL('https://api.3ngram.test/mcp'),
  extra: { userId: '11111111-1111-1111-1111-111111111111' },
}

const clients: McpClient[] = []
const handlers: ReturnType<typeof createMcpProtocolHandler>[] = []

async function connect(
  options?: ClientOptions,
  transformRequest?: (request: Request) => Request,
): Promise<McpClient> {
  const handler = createMcpProtocolHandler({ gateway: undefined })
  handlers.push(handler)
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init)
      return handler.fetch(transformRequest?.(request) ?? request, {
        authInfo,
      })
    },
  })
  const client = new McpClient({ name: 'protocol-contract', version: '0.0.0' }, options)
  clients.push(client)
  await client.connect(transport)
  return client
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(handlers.splice(0).map((handler) => handler.close()))
})

const cases: Array<{
  name: string
  options?: ClientOptions
  era: ProtocolEra
}> = [
  { name: 'legacy default', era: 'legacy' },
  {
    name: '2026-07-28 pin',
    options: { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    era: 'modern',
  },
  {
    name: 'automatic negotiation',
    options: { versionNegotiation: { mode: 'auto' } },
    era: 'modern',
  },
]

describe('MCP protocol compatibility', () => {
  for (const contract of cases) {
    it(`serves ${contract.name}`, async () => {
      const client = await connect(contract.options)
      expect(client.getProtocolEra()).toBe(contract.era)
      const toolCatalog = await client.listTools()
      expect(toolCatalog.tools).toHaveLength(10)
      expect(toolCatalog.tools.map((tool) => tool.name)).toContain('describe_environment')
      const promptCatalog = await client.listPrompts()
      expect(promptCatalog.prompts).toHaveLength(2)

      if (contract.era === 'modern') {
        expect(toolCatalog).toMatchObject({
          ttlMs: MCP_CATALOG_CACHE_TTL_MS,
          cacheScope: 'public',
        })
        expect(promptCatalog).toMatchObject({
          ttlMs: MCP_CATALOG_CACHE_TTL_MS,
          cacheScope: 'public',
        })
      } else {
        expect(toolCatalog).not.toHaveProperty('ttlMs')
        expect(toolCatalog).not.toHaveProperty('cacheScope')
        expect(promptCatalog).not.toHaveProperty('ttlMs')
        expect(promptCatalog).not.toHaveProperty('cacheScope')
      }
    })
  }

  it('rejects a modern Mcp-Name/body mismatch before tool dispatch', async () => {
    const client = await connect(
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      (request) => {
        if (request.headers.get('mcp-method') !== 'tools/call') return request
        const headers = new Headers(request.headers)
        headers.set('mcp-name', 'remember')
        return new Request(request, { headers })
      },
    )

    await expect(
      client.callTool({ name: 'describe_environment', arguments: {} }),
    ).rejects.toMatchObject({ code: -32_020 })
  })
})
