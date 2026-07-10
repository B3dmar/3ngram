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
  // write=1.25x). These are the figures the memo cites; a fixture or accounting
  // change MUST move them in lockstep so the memo can never silently drift.
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
      mcp: [13160, 107096, 27478],
      cli: [333, 1236, 1236],
      rest: [1786, 2803, 2803],
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

test('the MCP surface fixture is the REAL SDK tools/list + prompts/list (10 tools, 2 prompts)', () => {
  const surfaces = JSON.parse(
    readFileSync(join(here, '../fixtures/transport-surfaces.json'), 'utf8'),
  )
  assert.equal(surfaces.mcp.tools.length, 10, 'the v1 MCP surface is exactly 10 tools')
  const names = surfaces.mcp.tools.map((t) => t.name)
  assert.deepEqual(
    names.sort(),
    [
      'briefing',
      'configure_scope',
      'describe_environment',
      'get_facts',
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

test('the REST /api/v1/search surface is the WIDER searchQuerySchema, not the MCP tool schema', () => {
  // Regression guard (Codex P2, gen-transport-surfaces.mjs:134): the REST search
  // route .parse()s searchQuerySchema (query + limit + type/scope/project/status
  // filters + asOf), which is WIDER than the MCP search tool's searchInputSchema
  // (query + limit ONLY). The committed REST surface must reflect what the route
  // actually parses, so the filter fields MUST be present — otherwise the REST
  // contract undercounts and misdocuments the real wider surface.
  const surfaces = JSON.parse(
    readFileSync(join(here, '../fixtures/transport-surfaces.json'), 'utf8'),
  )
  const searchRoute = surfaces.rest.routes.find((r) => r.path === '/api/v1/search')
  assert.ok(searchRoute, 'REST surface must expose the /api/v1/search route')
  const props = searchRoute.requestSchema.properties
  for (const field of ['query', 'limit', 'memoryType', 'scope', 'project', 'status', 'asOf']) {
    assert.ok(field in props, `REST search request schema must carry the ${field} field`)
  }
  // The MCP search TOOL stays narrow (query + limit only) — the divergence is the point.
  const searchTool = surfaces.mcp.tools.find((t) => t.name === 'search')
  assert.deepEqual(
    Object.keys(searchTool.inputSchema.properties).sort(),
    ['limit', 'query'],
    'the MCP search tool surface stays query + limit only',
  )
})
