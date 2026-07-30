// SPDX-License-Identifier: Apache-2.0
// ONE-TIME generator for eval/fixtures/transport-surfaces.json (issue #134 E-D).
//
// CAPTURE METHOD — the MCP surface is the REAL tools/list (and prompts/list)
// payload the MCP SDK emits, NOT a hand-rolled z.toJSONSchema reconstruction. We
// wire the SDK's in-memory transport between a Client and the app's actual
// McpServer (apps/server createMcpServer, built from the live TOOLS registry +
// registerPrompts) and call client.listTools() / client.listPrompts(). The
// returned arrays are byte-for-byte what a host receives over the wire — the SDK
// does its OWN Zod->JSON-Schema serialization (draft-07, with title/annotations/
// _meta as the SDK adds them), so this captures the ground-truth standing context
// an MCP-connected agent carries. This is verifiable against the MCP Inspector
// (https://modelcontextprotocol.io/docs/tools/inspector): point it at the server
// and the tools/list it shows is the same payload committed here.
//
// It is run ONCE and its output is committed, so the advisory slice
// (src/transport-cost.mjs) stays OFFLINE and never imports apps/server at runtime.
//
// Re-run to refresh the committed surface after a schema/registry change:
//   pnpm --filter @3ngram/schema build
//   pnpm --filter @3ngram/server build   # this script imports apps/server/dist
//   node eval/scripts/gen-transport-surfaces.mjs > eval/fixtures/transport-surfaces.json
//   pnpm exec biome format --write eval/fixtures/transport-surfaces.json  # CI formats JSON
//
// NOTE: this script is NOT on the slice's runtime path. It imports apps/server's
// BUILT dist (and the MCP SDK), so it MUST run from a context where apps/server's
// node_modules resolve — it imports via absolute paths under apps/server below.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')
const serverDir = join(repoRoot, 'apps/server')
// Resolve the MCP packages + apps/server dist from apps/server's module graph
// (they are deps of @3ngram/server, not of @3ngram/eval — same resolution trick the
// previous generator used for zod). createRequire anchored at apps/server's
// package.json gives us its node_modules.
const requireFromServer = createRequire(join(serverDir, 'package.json'))
const clientModuleUrl = pathToUrl(requireFromServer.resolve('@modelcontextprotocol/client'))
const mcpServerModuleUrl = pathToUrl(requireFromServer.resolve('@modelcontextprotocol/server'))
const serverFactoryUrl = pathToUrl(join(serverDir, 'dist/mcp/server.js'))
// @3ngram/schema is a dep of @3ngram/eval; resolve it from THIS package so the
// REST search surface derives from the SAME schema the REST route parses
// (searchQuerySchema), not the narrower MCP tool input schema.
const schemaModuleUrl = pathToUrl(requireFromServer.resolve('@3ngram/schema'))

function pathToUrl(p) {
  return new URL(`file://${p}`).href
}

const { Client } = await import(clientModuleUrl)
const { InMemoryTransport, McpServer } = await import(mcpServerModuleUrl)
const { createMcpServer } = await import(serverFactoryUrl)
const { searchQuerySchema } = await import(schemaModuleUrl)

/**
 * Capture the SDK's real tools/list + prompts/list. We wire the in-memory
 * transport between a Client and the app's McpServer (built from the live TOOLS
 * registry) and ask the client what it receives — the exact payload a host
 * injects into the agent context. A stub ToolContext is enough: listTools /
 * listPrompts read only the registered metadata + schemas, never a handler, so no
 * DB, gateway, or tenant is touched.
 */
async function captureMcpSurface() {
  const server = createMcpServer({
    userId: 'surface-generator',
    scopes: ['memory:read', 'memory:write'],
    gateway: undefined,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'transport-surface-generator', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  const { prompts } = await client.listPrompts()
  await client.close()
  await server.close()
  // Sort by name so the committed fixture is stable regardless of registry order.
  const byName = (a, b) => a.name.localeCompare(b.name)
  return { tools: [...tools].sort(byName), prompts: [...prompts].sort(byName) }
}

/**
 * Serialize an arbitrary Zod object schema to JSON Schema via the SAME SDK path
 * the MCP surface uses (registerTool -> listTools), so a REST request schema that
 * is NOT an MCP tool schema (e.g. searchQuerySchema) is byte-style-identical to
 * the captured tool schemas: draft-07, `$schema` last, SDK annotations. We
 * register the full schema on a throwaway in-memory McpServer and read back the
 * serialized inputSchema the SDK emits — never invoking the handler, so
 * no DB/gateway/tenant is touched.
 */
async function serializeSchemaViaSdk(schema) {
  const server = new McpServer({ name: 'transport-surface-serializer', version: '0.0.0' })
  server.registerTool('__surface__', { description: '', inputSchema: schema }, async () => ({
    content: [],
  }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'transport-surface-serializer', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return tools.find((t) => t.name === '__surface__').inputSchema
}

// CLI surface: `3ngram --help` (the USAGE banner from apps/cli/src/run.ts) plus the
// per-command argument surface (apps/cli/src/commands.ts parseArgs options). This is
// the help text a coding agent must know to drive the CLI — the agent already knows
// bash, so this surface is learned ONCE on demand, not re-sent every turn.
const CLI_SURFACE = {
  help: [
    'usage: 3ngram <command> [options]',
    '',
    'commands:',
    '  remember  --type <t> --topic <t> --content <c> [--scope --project --tags]',
    '  search    <query> [--limit --type --scope --project --status]',
    '  facts     [--subject --predicate --valid-at --as-known-at --limit]',
    '',
    'global:  --base-url <url> --api-key <key> --json',
    'env:     THREENGRAM_BASE_URL THREENGRAM_API_KEY (flags override)',
  ].join('\n'),
  commands: {
    remember:
      '3ngram remember --type <type> --topic <topic> --content <content> [--scope <scope>] [--project <project>] [--tags <tag>]... [--base-url <url>] [--api-key <key>] [--json]\n  Append a new memory (decision, fact, preference, ...). --type/--topic/--content required.',
    search:
      '3ngram search <query> [--limit <n>] [--type <type>] [--scope <scope>] [--project <project>] [--status <status>] [--base-url <url>] [--api-key <key>] [--json]\n  Unified semantic + keyword retrieval. Query is positional or --query.',
    facts:
      '3ngram facts [--subject <subject>] [--predicate <predicate>] [--valid-at <iso>] [--as-known-at <iso>] [--limit <n>] [--base-url <url>] [--api-key <key>] [--json]\n  Currently-valid facts for a subject, with optional bi-temporal time travel.',
  },
}

// REST surface: the /api/v1 contract a coding agent must know to call the routes
// (apps/server/src/rest/router.ts). Like the CLI this is learned ONCE — the agent
// reads the contract, then issues curl/fetch by hand. method + path + auth +
// request-body schema + response-shape per route. Each request schema is the
// schema the REST route ACTUALLY parses, serialized via the SAME SDK path as the
// MCP surface so the comparison is apples to apples:
//   - remember -> rememberToolInputSchema   (== MCP remember tool)
//   - search   -> searchQuerySchema         (WIDER than the MCP search tool's
//                  searchInputSchema: + the type/scope/project/status filters and
//                  asOf — the router .parse()s searchQuerySchema, router.ts:137)
//   - get_facts-> factsQueryInputSchema      (== MCP get_facts tool)
//   - revise   -> reviseToolInputSchema       (== MCP revise tool)
//   - resolve  -> resolveToolInputSchema      (== MCP resolve tool)
// Only `search` diverges from its MCP tool schema; every other route's REST parse
// schema is the SAME @3ngram/schema shape its MCP tool registers, so reusing the
// captured tool inputSchema is faithful for those.
function restSurface(toolsByName, searchRequestSchema) {
  const inputSchema = (name) => toolsByName.get(name).inputSchema
  return {
    basePath: '/api/v1',
    auth: 'X-API-Key: <key> header on every route; {error:<reason>} on non-2xx',
    routes: [
      {
        name: 'remember',
        method: 'POST',
        path: '/api/v1/memories',
        requestSchema: inputSchema('remember'),
        responseStatus: 201,
        responseShape: '{memory:{id,memoryType,topic,scope,project},embedded,commitmentId?}',
      },
      {
        name: 'search',
        method: 'POST',
        path: '/api/v1/search',
        // searchQuerySchema (router.ts:137), NOT the narrow MCP search tool schema.
        requestSchema: searchRequestSchema,
        responseStatus: 200,
        responseShape: '{hits:[{id,memoryType,topic,content,score}],count}',
      },
      {
        name: 'get_facts',
        method: 'GET',
        path: '/api/v1/facts',
        requestSchema: inputSchema('get_facts'),
        responseStatus: 200,
        responseShape: '{facts:[{id,subject,predicate,value,confidence,validFrom,validTo}],count}',
      },
      {
        name: 'revise',
        method: 'POST',
        path: '/api/v1/memories/:id/revise',
        requestSchema: inputSchema('revise'),
        responseStatus: 200,
        responseShape: '{memory:{id,memoryType,topic,scope,project},embedded}',
      },
      {
        name: 'resolve',
        method: 'POST',
        path: '/api/v1/memories/:id/resolve',
        requestSchema: inputSchema('resolve'),
        responseStatus: 200,
        responseShape: '{commitmentId,status}',
      },
    ],
  }
}

const mcp = await captureMcpSurface()
const toolsByName = new Map(mcp.tools.map((t) => [t.name, t]))
// The REST /api/v1/search route parses the WIDER searchQuerySchema (query + limit
// + the type/scope/project/status filters + asOf), not the MCP search tool's
// narrow searchInputSchema. Serialize it through the SDK path so it matches the
// captured tool schemas byte-for-byte in style.
const searchRequestSchema = await serializeSchemaViaSdk(searchQuerySchema)

const surfaces = {
  _meta: {
    description:
      'Agent-facing context surface per transport, captured offline for the transport-cost advisory slice (#134 E-D). Generated by eval/scripts/gen-transport-surfaces.mjs.',
    captureMethod:
      'MCP surface: the REAL tools/list + prompts/list payload the MCP SDK emits, captured by wiring the SDK in-memory transport between a Client and the app McpServer (apps/server createMcpServer over the live TOOLS registry) and calling listTools()/listPrompts(). The SDK does its own Zod->JSON-Schema serialization; this is the exact payload a host injects, verifiable against the MCP Inspector. CLI: USAGE banner + per-command arg surface from apps/cli. REST: route contracts from apps/server/src/rest/router.ts; each request schema is the schema the route ACTUALLY .parse()s, serialized through the SAME SDK path as the MCP surface. search uses the WIDER searchQuerySchema (query+limit+type/scope/project/status filters+asOf), NOT the narrow MCP search tool schema; the other routes parse the same shapes their MCP tools register.',
    generatedFrom:
      'apps/server MCP server (built dist/, real SDK tools/list + prompts/list via in-memory transport), apps/cli, apps/server REST router',
  },
  mcp: {
    transport: 'mcp',
    note: 'The real tools/list + prompts/list payload an MCP client receives. ALL tool schemas ride in the agent context EVERY model turn (standing per-turn tax). Inspector-verifiable.',
    tools: mcp.tools,
    prompts: mcp.prompts,
  },
  cli: {
    transport: 'cli',
    note: 'The CLI help an agent learns ONCE on demand (it already knows bash). Not re-sent per turn.',
    ...CLI_SURFACE,
  },
  rest: {
    transport: 'rest',
    note: 'The REST contract an agent learns ONCE on demand (it already knows HTTP). Not re-sent per turn.',
    ...restSurface(toolsByName, searchRequestSchema),
  },
}

process.stdout.write(`${JSON.stringify(surfaces, null, 2)}\n`)
