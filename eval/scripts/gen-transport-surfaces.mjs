// SPDX-License-Identifier: Apache-2.0
// ONE-TIME generator for eval/fixtures/transport-surfaces.json (issue #134 E-D).
//
// CAPTURE METHOD — the MCP surface is the REAL tools/list, prompts/list, and
// resources/templates/list payload the MCP SDK emits, NOT a hand-rolled
// z.toJSONSchema reconstruction. We wire the SDK's in-memory transport between a
// Client and the app's actual McpServer (apps/server createMcpServer, built from
// the live TOOLS registry + registerPrompts + registerResources) and call
// client.listTools() / client.listPrompts() / client.listResourceTemplates(). The
// returned arrays are byte-for-byte what a host receives over the wire — the SDK
// does its OWN Zod->JSON-Schema serialization (draft-07, with title/annotations/
// _meta as the SDK adds them), so this captures the ground-truth standing context
// an MCP-connected agent carries. This is verifiable against the MCP Inspector
// (https://modelcontextprotocol.io/docs/tools/inspector): point it at the server
// and the tools/list it shows is the same payload committed here.
//
// A resource's cacheHint and completions coverage are NOT part of that wire
// payload — completion/complete only reveals a completer by actually INVOKING
// it, which touches the DB for a tenant-scoped completer like facetCompleter,
// and cacheHint is registration-time metadata the SDK never echoes on
// resources/templates/list. Both are captured by running the SAME
// registerResources / registerPrompts registry the server uses against a
// capturing stub in place of a real McpServer, reading back the config/template
// objects those functions build (never calling a completer or touching a
// DB/tenant). Completions coverage is prompts + resource-template URI variables
// only (apps/server/src/mcp/completions.ts, resources.ts) — the protocol has no
// `ref/tool`, so a tool argument can never be a completion target; see the note
// on captureCompletionsCoverage below.
//
// It is run ONCE and its output is committed, so the advisory slice
// (src/transport-cost.mjs) stays OFFLINE and never imports apps/server at runtime.
//
// Re-run to refresh the committed surface after a schema/registry change:
//   pnpm exec turbo run build --filter="...@3ngram/server"  # server + its full dep graph
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
const promptsModuleUrl = pathToUrl(join(serverDir, 'dist/mcp/prompts.js'))
const resourcesModuleUrl = pathToUrl(join(serverDir, 'dist/mcp/resources.js'))
// @3ngram/schema is a dep of @3ngram/eval; resolve it from THIS package so the
// REST search surface derives from the SAME schema the REST route parses
// (searchQuerySchema), not the narrower MCP tool input schema.
const schemaModuleUrl = pathToUrl(requireFromServer.resolve('@3ngram/schema'))

function pathToUrl(p) {
  return new URL(`file://${p}`).href
}

const { Client } = await import(clientModuleUrl)
const { InMemoryTransport, McpServer, isCompletable } = await import(mcpServerModuleUrl)
const { createMcpServer } = await import(serverFactoryUrl)
const { registerPrompts } = await import(promptsModuleUrl)
const { registerResources } = await import(resourcesModuleUrl)
const { searchQuerySchema } = await import(schemaModuleUrl)

/**
 * The stub tenant every capture below runs as — same shape {@link ToolContext}
 * requires, reused everywhere so the registries see one consistent identity.
 * Read-only surface metadata (listTools/listPrompts/listResourceTemplates,
 * schema shapes, isCompletable) never dispatches a handler or a completer, so
 * this touches no DB, gateway, or tenant regardless of which registry consumes it.
 */
const SURFACE_CTX = {
  userId: 'surface-generator',
  scopes: ['memory:read', 'memory:write'],
  gateway: undefined,
}

/**
 * Code-point sort by `.name`, NOT localeCompare: this fixture is a byte-exact
 * freshness gate (CI regenerates and diffs it), and localeCompare's ICU
 * collation can vary across runners/Node builds — a sort a CI runner orders
 * differently from a contributor's machine would fail the gate on an
 * unrelated PR. Plain `<`/`>` is a fixed UTF-16 code-unit comparison, identical
 * everywhere.
 */
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Capture the SDK's real tools/list + prompts/list + resources/templates/list.
 * We wire the in-memory transport between a Client and the app's McpServer
 * (built from the live TOOLS registry) and ask the client what it receives — the
 * exact payload a host injects into the agent context. A stub ToolContext is
 * enough: listTools / listPrompts / listResourceTemplates read only the
 * registered metadata + schemas, never a handler, so no DB, gateway, or tenant
 * is touched.
 */
async function captureMcpSurface() {
  const server = createMcpServer(SURFACE_CTX)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'transport-surface-generator', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  const { prompts } = await client.listPrompts()
  const { resourceTemplates } = await client.listResourceTemplates()
  await client.close()
  await server.close()
  // Sort by name so the committed fixture is stable regardless of registry order.
  return {
    tools: [...tools].sort(byName),
    prompts: [...prompts].sort(byName),
    resourceTemplates: [...resourceTemplates].sort(byName),
  }
}

/**
 * Unwrap ONLY an `.optional()` wrapper, mirroring the SDK's own (internal)
 * unwrapOptionalSchema exactly: `schema.type === 'optional'` then
 * `schema.unwrap()`. NOT a generic `typeof schema.unwrap === 'function'` check —
 * that also matches `.nullable()`/`.default()`/`.readonly()`, which the SDK's
 * own handlePromptCompletion does NOT unwrap before testing isCompletable, so a
 * generic unwrap would report `completable: true` for e.g.
 * `completable(x).nullable()` even though the server would never actually
 * serve a completion for it. Every completable() call site in this codebase
 * today is either bare or wrapped in exactly one `.optional()`.
 */
function unwrapOptional(schema) {
  return schema?.type === 'optional' ? schema.unwrap() : schema
}

/**
 * Completions coverage — apps/server/src/mcp/completions.ts + resources.ts.
 * NOT visible on the wire: `completion/complete` only reveals a completer by
 * actually INVOKING it (facetCompleter calls listMemoryFacets, a DB read; a
 * resource-template completer could too), so this generator cannot recover it
 * from client.listPrompts()/listResourceTemplates() the way the rest of the
 * surface is captured. Instead it runs the SAME registerPrompts /
 * registerResources registries the server uses, against a capturing stub in
 * place of a real McpServer, and reads back each candidate's registration-time
 * state (a Zod schema's isCompletable(), or a ResourceTemplate's
 * completeCallback(variable) presence) WITHOUT ever calling a completer — so no
 * DB, gateway, or tenant is touched.
 *
 * TOOLS ARE NOT HERE ON PURPOSE. The MCP completion protocol dispatches
 * `completion/complete` on `ref/prompt` or `ref/resource` only — there is no
 * `ref/tool`, so a tool argument can never be a completion target, in this SDK
 * or any conformant one. A `completions.tools` section would therefore be
 * `completable: false` for every argument, forever, by construction: a fixture
 * entry that looks like live registry state but is actually a fixed protocol
 * fact, not something a future edit to apps/server/src/mcp/tools*.ts could ever
 * flip. Leaving it out keeps this freshness gate honest about what it guards.
 */
function captureCompletionsCoverage(recordedResources) {
  const argsOf = (zodObjectShape) =>
    Object.entries(zodObjectShape)
      .map(([name, fieldSchema]) => ({
        name,
        completable: isCompletable(unwrapOptional(fieldSchema)),
      }))
      .sort(byName)

  const recordedPrompts = []
  const promptStub = {
    registerPrompt(name, config) {
      recordedPrompts.push({ name, args: argsOf(config.argsSchema.shape) })
    },
  }
  registerPrompts(promptStub, SURFACE_CTX)

  const resources = recordedResources.map(({ name, template }) => ({
    name,
    // ResourceTemplate.uriTemplate.variableNames + completeCallback(variable)
    // are public, read-only accessors (apps/server/src/mcp/resources.ts wires
    // `{id}` with NO complete map today — docs/concepts/mcp-surface.mdx rules
    // this out deliberately: "Completion for the memory {id} — suggesting
    // memory ids is the same enumeration through a different door." Freezing
    // `completable: false` here is exactly what should trip this gate if that
    // ever changes.
    variables: template.uriTemplate.variableNames
      .map((variable) => ({
        name: variable,
        completable: template.completeCallback(variable) !== undefined,
      }))
      .sort(byName),
  }))

  return {
    prompts: recordedPrompts.sort(byName),
    resources: resources.sort(byName),
  }
}

/**
 * Run the real registerResources against a capturing stub in place of an
 * McpServer, and return every `{name, template, config}` it registers — the
 * SAME raw objects registerResource(...) builds. Called ONCE; the result feeds
 * both cacheHint attachment and resource-completions coverage below.
 */
function captureResourceRegistrations() {
  const recorded = []
  const resourceStub = {
    registerResource(name, template, config) {
      recorded.push({ name, template, config })
    },
  }
  registerResources(resourceStub, SURFACE_CTX)
  return recorded
}

/**
 * Attach each resource template's cacheHint (registration-time metadata, never
 * echoed on resources/templates/list — server.ts's per-method cacheHints map
 * covers the LIST call itself, not the per-resource body).
 */
function withCacheHints(resourceTemplates, recordedResources) {
  const cacheHintByName = new Map(recordedResources.map((r) => [r.name, r.config.cacheHint]))
  return resourceTemplates.map((template) => ({
    ...template,
    cacheHint: cacheHintByName.get(template.name),
  }))
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
//   - search   -> searchQuerySchema         (query + limit + the five optional
//                  filters — the router .parse()s searchQuerySchema, router.ts:137;
//                  the MCP search tool now registers the SAME wider schema, but the
//                  REST surface keeps serializing it independently so the contract
//                  stays faithful to what the route parses)
//   - get_facts-> factsQueryInputSchema      (== MCP get_facts tool)
//   - revise   -> reviseToolInputSchema       (== MCP revise tool)
//   - resolve  -> resolveToolInputSchema      (== MCP resolve tool)
// Every route's REST parse schema is the SAME @3ngram/schema shape its MCP tool
// registers; search is serialized from searchQuerySchema directly (see above).
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
const recordedResources = captureResourceRegistrations()
const completions = captureCompletionsCoverage(recordedResources)
const resourceTemplates = withCacheHints(mcp.resourceTemplates, recordedResources)
// The REST /api/v1/search route parses searchQuerySchema (query + limit + the
// type/scope/project/status filters + asOf) — the same wider schema the MCP
// search tool registers. Serialize it through the SDK path so it matches the
// captured tool schemas byte-for-byte in style.
const searchRequestSchema = await serializeSchemaViaSdk(searchQuerySchema)

const surfaces = {
  _meta: {
    description:
      'Agent-facing context surface per transport, captured offline for the transport-cost advisory slice (#134 E-D). Generated by eval/scripts/gen-transport-surfaces.mjs.',
    captureMethod:
      "MCP surface: the REAL tools/list + prompts/list + resources/templates/list payload the MCP SDK emits, captured by wiring the SDK in-memory transport between a Client and the app McpServer (apps/server createMcpServer over the live TOOLS registry) and calling listTools()/listPrompts()/listResourceTemplates(). The SDK does its own Zod->JSON-Schema serialization; this is the exact payload a host injects, verifiable against the MCP Inspector. Each resource template's cacheHint and completions coverage (which prompt args and resource-template URI variables are completable — apps/server/src/mcp/completions.ts, resources.ts) are registration-time metadata never echoed on the wire, so those are captured by running the real registerResources/registerPrompts registries against a capturing stub in place of an McpServer and reading back the config/template objects (isCompletable() and ResourceTemplate.completeCallback() decide completions coverage; no completer is ever called, no DB/gateway/tenant touched). Tool arguments are NOT part of completions coverage: the protocol has no ref/tool completion target, so every tool argument is uncompletable by construction, not by registry state. CLI: USAGE banner + per-command arg surface from apps/cli. REST: route contracts from apps/server/src/rest/router.ts; each request schema is the schema the route ACTUALLY .parse()s, serialized through the SAME SDK path as the MCP surface. search is serialized from searchQuerySchema (query+limit+type/scope/project/status filters+asOf), the schema the route parses (the MCP search tool registers the same wider schema); the other routes parse the same shapes their MCP tools register.",
    generatedFrom:
      'apps/server MCP server (built dist/, real SDK tools/list + prompts/list + resources/templates/list via in-memory transport, plus registerResources/registerPrompts introspection for cacheHint + completions coverage), apps/cli, apps/server REST router',
  },
  mcp: {
    transport: 'mcp',
    note: 'The real tools/list + prompts/list + resources/templates/list payload an MCP client receives. ALL tool schemas ride in the agent context EVERY model turn (standing per-turn tax). Inspector-verifiable.',
    tools: mcp.tools,
    prompts: mcp.prompts,
    resourceTemplates,
    completions,
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
