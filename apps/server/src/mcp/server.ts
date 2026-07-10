// SPDX-License-Identifier: Apache-2.0
// MCP server factory — builds a per-request McpServer from the {@link TOOLS}
// registry. STATELESS (docs/concepts/mcp-design.mdx): a fresh server + transport per request
// (sessionIdGenerator: undefined), so NO in-process session state survives a
// request — any instance serves any request and a Railway redeploy is a
// non-event. The authenticated tenant + optional embedding gateway are captured
// in the handler closure (the per-request context), never stored on the server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SERVER_VERSION } from '../version.js'
import { registerPrompts } from './prompts.js'
import { runTool, TOOLS, type ToolContext } from './tools.js'

// `version` derives from package.json (see ../version.ts) so the `initialize`
// result always matches the published package version and never skews.
const SERVER_INFO = { name: '3ngram', version: SERVER_VERSION } as const

/**
 * Build an McpServer with every registry tool registered, bound to one request's
 * {@link ToolContext}. Each tool registers its Zod input/output RAW SHAPES (the
 * SDK validates inbound args against inputSchema and the structured result
 * against outputSchema), and delegates to {@link runTool} for uniform metrics +
 * typed-error mapping. The code-defined PROMPTS (briefing, debrief)
 * are registered alongside; registerPrompt auto-enables the `prompts` capability,
 * so prompts/list + prompts/get are served with no transport-route change (both
 * stay Bearer-gated by routes/mcp.ts). Prompts carry no tenant data, so they need
 * no {@link ToolContext}.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO)
  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config, (args: unknown) => runTool(tool, args, ctx))
  }
  registerPrompts(server)
  return server
}
