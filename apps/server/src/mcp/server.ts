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
import { registerResources } from './resources.js'
import { runTool, TOOLS, type ToolContext } from './tools.js'

// `version` derives from package.json (see ../version.ts) so the `initialize`
// result always matches the published package version and never skews.
const SERVER_INFO = { name: '3ngram', version: SERVER_VERSION } as const

/**
 * Natural-language usage policy surfaced to the model via
 * `DiscoverResult.instructions`. It is the ONLY place an agent learns when to
 * reach for one tool over another — the 11 tool descriptions each explain
 * themselves, with no cross-tool framing.
 *
 * TREAT AS POLICY, NOT DOCUMENTATION. Clients that surface this prepend it to
 * model context on every session, so it competes with the tool descriptions for
 * attention. Every sentence here has to earn its place; the failure mode this
 * targets is "the agent has the tools but never writes anything worth keeping",
 * which is a usage problem, not a schema problem.
 *
 * This is a compression of the JTBD table in docs/concepts/mcp-design.mdx.
 * Change them together — the doc links back here for exactly that reason.
 */
export const SERVER_INSTRUCTIONS = `3ngram is the user's persistent memory across sessions and tools.

Start a session with \`briefing\` to load what is already known. Before saying something is not known, not decided, or not recorded, \`search\` for it (add order: "chronological" for an exhaustive listing instead of ranked relevance) — this corpus outlives the conversation you can see.

Memory is append-only. Never rewrite or delete: use \`revise\` to supersede a memory that has become wrong, and \`resolve\` to settle a commitment or blocker. Superseding keeps the old version readable as history.

Write decisions, commitments, blockers, and stated preferences — the things that would be expensive to rediscover. Do not write transcript noise, restatements of what the user just said, or anything re-derivable from the code.

Scope and project decide what later reads return, so set them when you \`remember\`: a memory written with no project will not appear in that project's briefing.

When a memory states something measurable, pass it as \`facts\` on the same \`remember\` call so \`get_facts\` can read it back without re-parsing prose. Values are text: put the unit in the predicate and keep one measure per fact.`

/**
 * Tool definitions, prompt definitions, and the discovery advertisement change
 * only with a server deployment. One hour avoids reconnect refetches without
 * making a rolling deployment's old catalog sticky for long. All three payloads
 * are identical across tenants, so shared caching is safe; tool authorization
 * still runs on every tools/call.
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
    instructions: SERVER_INSTRUCTIONS,
    // The 2026-07-28 spec requires cache hints on every cacheable result, and
    // server/discover is on that list. Without a CONFIGURED hint the SDK does
    // not leave the fields off — its 2026 codec fills them from its own
    // defaults (ttlMs 0, cacheScope 'private'), so discovery advertises itself
    // as immediately stale and clients re-probe on every reconnect.
    // 'public' is correct for the same reason it is correct on the catalogs:
    // DiscoverResult carries supportedVersions, capabilities, and serverInfo —
    // no tenant data. It shares the catalog TTL because it goes stale on
    // exactly the same trigger: a deployment.
    cacheHints: {
      'server/discover': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
      'tools/list': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
      'prompts/list': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
      // The TEMPLATE list is a static descriptor — one uri template and its
      // human-readable metadata, identical for every tenant — so it caches
      // 'public' alongside the other catalogs and changes on the same trigger.
      // The RESOURCE BODIES are the opposite: resources/read carries tenant
      // data and is pinned 'private' with its own long TTL at the registration
      // site (see resources.ts). Per-resource hints win over this map field by
      // field, so the two never collide.
      'resources/templates/list': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
    },
  })
  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config, (args: unknown) => runTool(tool, args, ctx))
  }
  // Prompts now take the request ToolContext too: their TEXT still carries no
  // tenant data, but a completable argument reads the tenant's own facets.
  registerPrompts(server, ctx)
  // Resources need the per-request ToolContext: unlike prompts (static text, no
  // tenant data), a resource read returns memory content and therefore enforces
  // the same tenant + scope + access guards a read tool does.
  registerResources(server, ctx)
  return server
}
