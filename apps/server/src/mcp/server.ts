// SPDX-License-Identifier: Apache-2.0
// MCP server factory — builds a per-request McpServer from the {@link TOOLS}
// registry. STATELESS (docs/concepts/mcp-design.mdx): createMcpHandler invokes
// this factory per request for both eras, so NO tenant/session state survives a
// request — any instance serves any request and a Railway redeploy is a
// non-event. The authenticated tenant + optional embedding gateway are captured
// in the handler closure (the per-request context), never stored on the server.
import { McpServer } from '@modelcontextprotocol/server'
import { SERVER_VERSION } from '../version.js'
import { registerPrompts } from './prompts.js'
import { runTool, TOOLS, type ToolContext } from './tools.js'

// `version` derives from package.json (see ../version.ts) so the `initialize`
// result always matches the published package version and never skews.
const SERVER_INFO = { name: '3ngram', version: SERVER_VERSION } as const

/**
 * Tool and prompt definitions change only with a server deployment. One hour
 * avoids reconnect refetches without making a rolling deployment's old catalog
 * sticky for long. Both lists are identical across tenants, so shared caching
 * is safe; tool authorization still runs on every tools/call.
 */
export const MCP_CATALOG_CACHE_TTL_MS = 60 * 60_000

/**
 * Build an McpServer with every registry tool registered, bound to one request's
 * {@link ToolContext}. Each tool registers its full Zod Standard Schema objects (the
 * SDK validates inbound args against inputSchema and the structured result
 * against outputSchema), and delegates to {@link runTool} for uniform metrics +
 * typed-error mapping. The code-defined PROMPTS (briefing, debrief)
 * are registered alongside; registerPrompt auto-enables the `prompts` capability,
 * so prompts/list + prompts/get are served with no transport-route change (both
 * stay Bearer-gated by routes/mcp.ts). Prompts carry no tenant data, so they need
 * no {@link ToolContext}.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    cacheHints: {
      'tools/list': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
      'prompts/list': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
    },
  })
  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config, (args: unknown) => runTool(tool, args, ctx))
  }
  registerPrompts(server)
  return server
}
