// SPDX-License-Identifier: Apache-2.0
// Offline tests for the transport-cost advisory slice (#134 E-D). No network, no
// model: the slice runs purely over the two committed fixtures. These assert the
// DETERMINISTIC totals and — the load-bearing property — that the per-turn-vs-once
// accounting behaves: MCP's per-task total scales with the turn count (the standing
// tool-schema tax), while CLI/REST count their surface ONCE regardless of turns.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { encode } from 'gpt-tokenizer/encoding/o200k_base'

const here = dirname(fileURLToPath(import.meta.url))
const slice = join(here, '../src/transport-cost.mjs')

/** Run the slice with --json and parse its single-line machine summary. */
function runSlice() {
  const out = execFileSync('node', [slice, '--json'], { encoding: 'utf8' })
  return JSON.parse(out.trim())
}

/** Index the summary rows by transport for direct assertions. */
function rowsByTransport(summary) {
  return Object.fromEntries(summary.rows.map((r) => [r.transport, r]))
}

test('emits a deterministic machine summary for all three transports', () => {
  const a = runSlice()
  const b = runSlice()
  assert.deepEqual(a, b, 're-runs must be byte-identical (deterministic)')
  assert.equal(a.harness, 'transport-cost-advisory')
  assert.equal(a.tier, 'advisory')
  assert.equal(a.rows.length, 3)
  assert.deepEqual(a.rows.map((r) => r.transport).sort(), ['cli', 'mcp', 'rest'])
})

test('the per-turn-vs-once policy is explicit and drives the totals', () => {
  const summary = runSlice()
  const rows = rowsByTransport(summary)
  // MCP carries its surface EVERY turn; CLI/REST learn it once.
  assert.equal(rows.mcp.surfacePolicy, 'perTurn')
  assert.equal(rows.cli.surfacePolicy, 'once')
  assert.equal(rows.rest.surfacePolicy, 'once')
  assert.equal(summary.surfacePolicy.mcp, 'perTurn')
  assert.equal(summary.surfacePolicy.cli, 'once')
  assert.equal(summary.surfacePolicy.rest, 'once')
})

test('the deterministic per-task totals match the committed fixtures (both cost models)', () => {
  // The frozen numbers (turns=8, real SDK tools/list surface, cache read=0.1x
  // write=1.25x). Frozen on purpose: a fixture or accounting change MUST move
  // these totals in lockstep here, so THIS assertion is the only in-repo
  // citation of the measured totals — any prose stays citation-free and can
  // never silently drift from a fixture refresh (issue #58 item 3).
  const summary = runSlice()
  const rows = rowsByTransport(summary)
  assert.equal(summary.turnCount, 8)
  assert.equal(summary.cacheReadMultiplier, 0.1)
  assert.equal(summary.cacheWriteMultiplier, 1.25)
  assert.deepEqual(
    {
      mcp: [rows.mcp.surfaceTokens, rows.mcp.perTaskUncached, rows.mcp.perTaskCacheEffective],
      cli: [rows.cli.surfaceTokens, rows.cli.perTaskUncached, rows.cli.perTaskCacheEffective],
      rest: [rows.rest.surfaceTokens, rows.rest.perTaskUncached, rows.rest.perTaskCacheEffective],
    },
    {
      // MCP totals moved with the combined selector + retrieval-scope surface
      // (issues #46/#47): scope_project, set_retrieval_default, and the
      // appliedScope/retrievalScopePolicy output fields all ride tools/list;
      // precise recorded-range descriptions account for the final delta.
      // +13/+104/+26 (issue #71): the `remember` description now names the
      // scope_project includeUnscoped opt-in instead of asserting flatly that a
      // NULL-project memory never matches a project filter.
      // +263/+2104/+512 (freshness-gate regen): the committed fixture predated
      // per-tool ToolAnnotations (readOnlyHint/idempotentHint/openWorldHint) —
      // live on tools/list already, just never re-captured. A fresh regen picks
      // them up; the CI freshness gate (this PR) now catches this class of drift.
      // +66/+528/+129 (supersession visibility): the search tool's output
      // schema (both full and compact hit shapes) grew a `superseded: boolean`
      // field, plus a tool-description sentence naming it. Only MCP moves: its
      // per-tool tools/list surface tokenizes the REAL outputSchema (a standing
      // per-turn tax). REST's routes[].responseShape in
      // gen-transport-surfaces.mjs is a hand-maintained compact summary string,
      // not derived from the live Zod schema, and was not touched here — a
      // pre-existing approximation this change does not widen.
      // +693/+5544/+1352 mcp, +486/+486/+486 rest (structured facts on
      // `remember`): the optional `facts` array joins the tool input schema, so
      // it rides tools/list every MCP turn and the REST request surface once.
      // CLI is unchanged — it shells the same commands and never carries the
      // schema.
      mcp: [20710, 167496, 42201],
      cli: [333, 1236, 1236],
      rest: [2307, 3324, 3324],
    },
  )
})

test('MCP uncached per-task = surface * turns + op-io (per-turn tax scales with turns)', () => {
  const summary = runSlice()
  const rows = rowsByTransport(summary)
  const mcp = rows.mcp
  // The defining identity: MCP's surface rides in context every model turn (uncached).
  assert.equal(mcp.perTurnTokens, mcp.surfaceTokens)
  assert.equal(mcp.perTaskUncached, mcp.surfaceTokens * summary.turnCount + mcp.operationTokens)
  assert.ok(summary.turnCount > 1, 'a multi-turn session is needed to show the scaling')
})

test('caching strictly reduces the MCP per-task cost (cacheEffective < uncached)', () => {
  const summary = runSlice()
  const rows = rowsByTransport(summary)
  // Prompt caching bills later turns' surface at ~0.1x, so the cache-effective MCP
  // total must be strictly below the uncached worst case — and the saving is large.
  assert.ok(
    rows.mcp.perTaskCacheEffective < rows.mcp.perTaskUncached,
    'caching must lower the MCP per-task total',
  )
  // The cache-effective surface is the modeled first-write + cached reads, NOT
  // surface * turns.
  const r = summary.cacheReadMultiplier
  const w = summary.cacheWriteMultiplier
  const expectedSurface = Math.round(
    rows.mcp.surfaceTokens * w + rows.mcp.surfaceTokens * r * (summary.turnCount - 1),
  )
  assert.equal(rows.mcp.perTaskCacheEffective, expectedSurface + rows.mcp.operationTokens)
})

test('CLI/REST surface is once: cacheEffective == uncached (caching is a no-op)', () => {
  const summary = runSlice()
  const rows = rowsByTransport(summary)
  for (const transport of ['cli', 'rest']) {
    const row = rows[transport]
    assert.equal(row.perTurnTokens, 0, `${transport} has no per-turn surface tax`)
    // Learned once regardless of caching: both cost models are identical, and equal
    // surface + op-io (no turn factor).
    assert.equal(
      row.perTaskUncached,
      row.surfaceTokens + row.operationTokens,
      `${transport} surface is counted once, independent of turns`,
    )
    assert.equal(
      row.perTaskCacheEffective,
      row.perTaskUncached,
      `${transport} surface is learned once, so caching changes nothing`,
    )
  }
})

test('the per-turn tax makes MCP dominate CLI under both cost models', () => {
  const summary = runSlice()
  const rows = rowsByTransport(summary)
  // The headline finding survives caching: even the cache-effective MCP total is an
  // order of magnitude over CLI; the uncached worst case far more so.
  assert.ok(
    rows.mcp.perTaskUncached > rows.cli.perTaskUncached * 10,
    'uncached MCP per-task should be an order of magnitude over CLI',
  )
  assert.ok(
    rows.mcp.perTaskCacheEffective > rows.cli.perTaskCacheEffective * 10,
    'even cache-effective MCP per-task stays an order of magnitude over CLI',
  )
  // CLI is the leanest under both models (lightest surface + lightest envelope).
  assert.ok(rows.cli.perTaskUncached < rows.rest.perTaskUncached)
})

test('CLI fallback ops are counted on the fallback transport wire, not the prose', () => {
  // revise/resolve are not exposed by the v1 CLI; the agent falls back to REST.
  // The accounting must tokenize the REAL REST request+response on the CLI wire,
  // never the explanatory prose stub in cli.request (which would undercount CLI).
  const script = JSON.parse(
    readFileSync(join(here, '../fixtures/transport-task-script.json'), 'utf8'),
  )
  const fallbackOps = script.operations.filter((op) => op.transports.cli.fallbackTo)
  assert.ok(fallbackOps.length > 0, 'fixture must exercise the CLI fallback path')

  const proseTokens = fallbackOps.reduce((sum, op) => {
    const cli = op.transports.cli
    return sum + encode(cli.request).length + encode(JSON.stringify(cli.response)).length
  }, 0)
  const restWireTokens = fallbackOps.reduce((sum, op) => {
    const rest = op.transports.rest
    return (
      sum +
      encode(JSON.stringify(rest.request)).length +
      encode(JSON.stringify(rest.response)).length
    )
  }, 0)
  assert.notEqual(proseTokens, restWireTokens, 'prose stub differs from the real REST wire')

  // The summary's CLI op-io must reflect the REST wire for the fallback ops, so it
  // must exceed what the prose stub would have produced.
  const summary = runSlice()
  const cliOpIo = rowsByTransport(summary).cli.operationTokens
  const cliWithProse = cliOpIo - restWireTokens + proseTokens
  assert.ok(
    cliOpIo > cliWithProse,
    'CLI op-io must count the heavier REST fallback wire, not the prose stub',
  )
})

test('round-trips equal the operation count for every transport', () => {
  const summary = runSlice()
  const rows = rowsByTransport(summary)
  for (const transport of ['mcp', 'cli', 'rest']) {
    assert.equal(rows[transport].roundTrips, summary.turnCount)
  }
})

test('the MCP surface fixture is the REAL SDK tools/list + prompts/list (11 tools, 2 prompts)', () => {
  const surfaces = JSON.parse(
    readFileSync(join(here, '../fixtures/transport-surfaces.json'), 'utf8'),
  )
  assert.equal(surfaces.mcp.tools.length, 11, 'the v1 MCP surface is exactly 11 tools')
  const names = surfaces.mcp.tools.map((t) => t.name)
  assert.deepEqual(
    names.sort(),
    [
      'briefing',
      'configure_scope',
      'describe_environment',
      'get_facts',
      'get_memories',
      'handoff',
      'remember',
      'resolve',
      'review_proposals',
      'search',
      'revise',
    ].sort(),
  )
  // The captured payload is the SDK's own tools/list serialization, so each tool
  // carries the SDK-shaped fields a host receives — name + title + description +
  // JSON-Schema'd input + output (NOT a hand-rolled subset).
  for (const tool of surfaces.mcp.tools) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.title, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.inputSchema, 'object')
    assert.equal(typeof tool.outputSchema, 'object')
  }
  // prompts/list is part of the same standing MCP surface — the 2 code-defined
  // prompts (briefing, debrief) the SDK serves.
  assert.deepEqual(surfaces.mcp.prompts.map((p) => p.name).sort(), ['briefing', 'debrief'])
})

test('the MCP surface fixture covers resource templates and completions (additive sections)', () => {
  // Additive: transport-cost.mjs's surfaceTokens() only reads mcp.tools/prompts
  // and cli/rest, so these sections carry no per-task token cost — they exist so
  // the freshness gate (CI) covers the FULL MCP surface, not just tools/prompts.
  const surfaces = JSON.parse(
    readFileSync(join(here, '../fixtures/transport-surfaces.json'), 'utf8'),
  )
  // resources/templates/list: the one threengram://memory/{id} template
  // (apps/server/src/mcp/resources.ts), including its registration-time
  // cacheHint (never echoed on the wire; recovered by running the real
  // registerResources against a capturing stub — see gen-transport-surfaces.mjs).
  assert.equal(surfaces.mcp.resourceTemplates.length, 1)
  const memoryTemplate = surfaces.mcp.resourceTemplates[0]
  assert.equal(memoryTemplate.name, 'memory')
  assert.equal(memoryTemplate.uriTemplate, 'threengram://memory/{id}')
  assert.deepEqual(memoryTemplate.cacheHint, { ttlMs: 24 * 60 * 60_000, cacheScope: 'private' })

  // Completions coverage: which prompt args and resource-template URI variables
  // are wired to completable() (apps/server/src/mcp/completions.ts, resources.ts).
  // No `completions.tools`: the MCP completion protocol dispatches
  // completion/complete on ref/prompt or ref/resource only — there is no
  // ref/tool, so a tool argument can never be a completion target, and a
  // section that is `completable: false` for every tool arg by construction
  // would freeze a protocol fact, not a registry fact worth gating on.
  const { completions } = surfaces.mcp
  assert.ok(!('tools' in completions), 'completions must not carry a tools section')
  assert.deepEqual(completions.prompts.map((p) => p.name).sort(), ['briefing', 'debrief'])

  // Today exactly one prompt arg — debrief's `scope`, via
  // facetCompleter(ctx, 'scopes') — is completable; every other prompt arg is not.
  const completablePromptArgs = completions.prompts.flatMap(({ name, args }) =>
    args.filter((arg) => arg.completable).map((arg) => `${name}.${arg.name}`),
  )
  assert.deepEqual(completablePromptArgs, ['debrief.scope'])

  // The memory template's {id} carries NO complete callback (resources.ts
  // registers `list: undefined` and no complete map) — docs/concepts/mcp-surface
  // .mdx rules this out deliberately (enumerating {id} is a cross-tenant
  // existence oracle by a different door), so this must stay false.
  assert.deepEqual(completions.resources, [
    { name: 'memory', variables: [{ name: 'id', completable: false }] },
  ])
})

test('the search surface is the WIDER searchQuerySchema on BOTH transports', () => {
  // Regression guard (Codex P2, gen-transport-surfaces.mjs:134): the REST search
  // route .parse()s searchQuerySchema (query + limit + type/scope/project/status
  // filters + asOf). The committed REST surface must reflect what the route
  // actually parses, so the filter fields MUST be present — otherwise the REST
  // contract undercounts and misdocuments the real wider surface. Since the MCP
  // search tool ALSO registers searchQuerySchema now (the historical narrow
  // query+limit tool schema is gone — ONE validation boundary, hard rule 2),
  // both transports must carry the same wider field set.
  const surfaces = JSON.parse(
    readFileSync(join(here, '../fixtures/transport-surfaces.json'), 'utf8'),
  )
  const widerFields = ['asOf', 'limit', 'memoryType', 'project', 'query', 'scope', 'status']
  const searchRoute = surfaces.rest.routes.find((r) => r.path === '/api/v1/search')
  assert.ok(searchRoute, 'REST surface must expose the /api/v1/search route')
  const props = searchRoute.requestSchema.properties
  for (const field of widerFields) {
    assert.ok(field in props, `REST search request schema must carry the ${field} field`)
  }
  // The MCP search tool registers searchQueryV3Schema — a strict SUPERSET
  // composition over the same wider searchQuerySchema (V2 added memoryTypes[]
  // and the recordedAfter/recordedBefore range; V3 adds the continuation pair
  // cursor + projection, issue #49; ONE validation boundary, hard rule 2).
  // REST stays on searchQuerySchema until its own stacked slices land, so MCP
  // must carry every wider field plus exactly the V2 axes + the V3 pair.
  const v3Fields = [
    ...widerFields,
    'memoryTypes',
    'recordedAfter',
    'recordedBefore',
    'cursor',
    'projection',
  ].sort()
  const searchTool = surfaces.mcp.tools.find((t) => t.name === 'search')
  assert.deepEqual(
    Object.keys(searchTool.inputSchema.properties).sort(),
    v3Fields,
    'the MCP search tool surface is searchQueryV3Schema (wider set + V2 axes + cursor/projection)',
  )
})

test('generated MCP and REST contracts advertise the recorded-bound precision limit', () => {
  const precision = /at most 3 fractional-second digits/i
  const surfaces = JSON.parse(
    readFileSync(join(here, '../fixtures/transport-surfaces.json'), 'utf8'),
  )
  const searchTool = surfaces.mcp.tools.find((tool) => tool.name === 'search')
  for (const field of ['recordedAfter', 'recordedBefore']) {
    assert.match(
      searchTool.inputSchema.properties[field].description,
      precision,
      `MCP tools/list must advertise ${field} precision`,
    )
  }

  const openapi = JSON.parse(
    readFileSync(join(here, '../../docs/api-reference/openapi.json'), 'utf8'),
  )
  const listParams = openapi.paths['/api/v1/memories'].get.parameters
  for (const field of ['recordedAfter', 'recordedBefore']) {
    const parameter = listParams.find((item) => item.name === field)
    assert.match(
      parameter.schema.description,
      precision,
      `REST OpenAPI must advertise ${field} precision`,
    )
  }
})
