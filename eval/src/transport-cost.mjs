// SPDX-License-Identifier: Apache-2.0
// Transport token-cost advisory slice (issue #134 E-D, docs/concepts/architecture.mdx "one core, N
// transports").
//
// ADVISORY ONLY — this harness NEVER gates a PR. The blocking golden-set gate
// lives in run.mjs and is untouched; this slice is NOT added to it. It mirrors
// the longmemeval.mjs advisory pattern: deterministic, OFFLINE (no live model, no
// network), exit 0.
//
// WHAT IT MEASURES — STATIC token ACCOUNTING, not a live agent run. It models the
// agent's CONTEXT token cost of using 3ngram memory over one representative coding
// session across the three transports (MCP / CLI / REST). It does NOT call a model
// and does NOT measure success rate; it counts tokens the agent's context would
// carry under a fixed, explicit accounting policy.
//
// THE CORE FINDING — per-turn vs once. An MCP client receives the REAL tools/list
// payload (the SDK's own Zod->JSON-Schema serialization of every tool: name, title,
// description, input/output schema) and those ~10 tool schemas RIDE IN THE AGENT
// CONTEXT EVERY MODEL TURN (a standing per-turn tax). A CLI is invoked on demand —
// the agent already knows bash, so its command surface is learned ONCE (a one-time
// cost). REST sits between (a contract learned once, like the CLI, but with heavier
// per-call envelopes than the CLI's argv-in/JSON-out). This per-turn-vs-once
// distinction is the DOMINANT variable and the knob the result hinges on — it is
// made explicit below (SURFACE_POLICY) and is the single thing the recommendation
// turns on.
//
// CACHING — two cost models, reported side by side. The per-turn MCP surface is the
// WORST CASE (uncached). Real hosts use provider prompt caching (Anthropic/OpenAI):
// after the first turn writes the tool definitions to cache, subsequent turns bill
// the cached prefix at ~0.1x. So this slice reports BOTH an `uncached` per-task
// (surface x turns, the standing tax billed in full every turn) and a
// `cacheEffective` per-task (surface once at full rate, then surface x 0.1 x the
// remaining turns) — the realistic floor a caching host pays. CLI/REST learn their
// surface ONCE regardless, so caching does not change them.
//
// TOKENIZER — one tokenizer (gpt-tokenizer, o200k_base, pure JS, no native build)
// is used CONSISTENTLY across all transports. It is a PROXY for Claude's tokenizer;
// the comparison is RELATIVE, not an absolute Claude token count (see the memo).
//
// FIXTURES (committed, offline):
//   fixtures/transport-surfaces.json    — each transport's agent-facing context
//                                          surface. MCP = the REAL tools/list +
//                                          prompts/list payload the SDK emits
//                                          (Inspector-verifiable), CLI help, REST
//                                          contract. Generated once by
//                                          scripts/gen-transport-surfaces.mjs.
//   fixtures/transport-task-script.json — a fixed coding-agent session (8 ops) with
//                                          the per-op request+response payloads on
//                                          the wire for each transport.
//
// Usage:
//   node eval/src/transport-cost.mjs [--json]
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encode } from 'gpt-tokenizer/encoding/o200k_base'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures')
const args = process.argv.slice(2)
const asJson = args.includes('--json')

/**
 * The accounting POLICY — the knob the whole result hinges on. `perTurn` transports
 * carry their full surface in context EVERY model turn (MCP injects tool schemas);
 * `once` transports learn the surface a SINGLE time (the agent already knows
 * bash/HTTP, then reads the help/contract once). Making this explicit is the point
 * of the experiment.
 */
const SURFACE_POLICY = {
  mcp: 'perTurn',
  cli: 'once',
  rest: 'once',
}

/**
 * Provider prompt-cache READ multiplier. After the first turn writes the standing
 * surface (tool definitions) into the provider cache, every later turn re-bills that
 * cached prefix at this fraction of the base input rate. Anthropic and OpenAI both
 * price cache reads at ~0.1x base (Anthropic: 5-min/1-hr cache, 0.1x read; OpenAI
 * automatic prompt caching, ~0.25-0.5x — 0.1x is the strong-caching case we model as
 * the realistic floor). The `cacheEffective` model below uses this; the `uncached`
 * model ignores it (worst case, no caching).
 */
const CACHE_READ_MULTIPLIER = 0.1

/**
 * Optional cache-WRITE surcharge on the FIRST turn. Writing a prefix to the provider
 * cache costs slightly more than a plain input token (Anthropic ~1.25x for the 5-min
 * TTL). Set to 1.25 to charge it; 1.0 to ignore. We charge it so `cacheEffective` is
 * not optimistic about the first turn.
 */
const CACHE_WRITE_MULTIPLIER = 1.25

/** Count o200k_base tokens for a value, serializing non-strings as compact JSON. */
function countTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return encode(text).length
}

function loadFixture(name) {
  const path = join(fixtures, `${name}.json`)
  if (!existsSync(path)) {
    process.stderr.write(`fixture not found: ${path}\n`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * The SURFACE token cost — the agent-facing context surface counted ONCE,
 * independent of how many turns/ops the session has. For MCP this is the FULL real
 * tools/list payload the SDK emits — the entire serialized `tools` array (every
 * tool exactly as a host receives it: name, title, description, input/outputSchema,
 * and any SDK-added fields) plus the `prompts` array from prompts/list. We tokenize
 * the payload AS THE HOST INJECTS IT (serialized arrays), not a hand-picked subset,
 * so the number is the true standing context. For CLI the help banner + per-command
 * help; for REST the route contract.
 */
function surfaceTokens(surfaces) {
  // The whole tools/list payload rides in context; count it as serialized, the way
  // the host carries it. prompts/list is part of the same standing MCP surface.
  const mcp = countTokens(surfaces.mcp.tools) + countTokens(surfaces.mcp.prompts ?? [])
  const cli =
    countTokens(surfaces.cli.help) +
    Object.values(surfaces.cli.commands).reduce((sum, h) => sum + countTokens(h), 0)
  const rest =
    countTokens(surfaces.rest.basePath) +
    countTokens(surfaces.rest.auth) +
    surfaces.rest.routes.reduce(
      (sum, route) =>
        sum +
        countTokens(`${route.method} ${route.path}`) +
        countTokens(route.requestSchema) +
        countTokens(route.responseShape),
      0,
    )
  return { mcp, cli, rest }
}

/**
 * Per-operation request+response tokens, summed over the whole task script, per
 * transport. This is the on-the-wire I/O the agent's context carries for each call
 * (independent of the surface). The MCP envelope (JSON-RPC + content mirror +
 * structuredContent) is heavier per call than the bare REST body or the CLI's
 * argv-in/JSON-out.
 */
function operationTokens(script) {
  const totals = { mcp: 0, cli: 0, rest: 0 }
  for (const op of script.operations) {
    for (const transport of ['mcp', 'cli', 'rest']) {
      const t = op.transports[transport]
      // Honor a transport fallback: when an op is not exposed on this transport
      // (e.g. revise/resolve have no v1 CLI command), the agent falls back to
      // another transport's wire (REST/curl). Count that transport's real
      // request+response, not the explanatory prose in t.request.
      const wire = t.fallbackTo ? op.transports[t.fallbackTo] : t
      totals[transport] += countTokens(wire.request) + countTokens(wire.response)
    }
  }
  return totals
}

/**
 * Round-trip count per transport over the session — one round-trip per operation.
 * (The model TURN count drives the per-turn surface tax separately; see turns.)
 */
function roundTrips(script) {
  const n = script.operations.length
  return { mcp: n, cli: n, rest: n }
}

const surfaces = loadFixture('transport-surfaces')
const script = loadFixture('transport-task-script')

// TURN COUNT — derived from the task script. The accounting model assigns ONE model
// turn per operation: each op is a distinct tool-call/round-trip the agent decides
// on its own turn. This is the multiplier on the per-turn surface tax for MCP.
const turnCount = script.operations.length

const surface = surfaceTokens(surfaces)
const perOp = operationTokens(script)
const trips = roundTrips(script)

/**
 * UNCACHED surface contribution — the worst case, no provider caching. `perTurn`
 * transports re-pay the FULL surface every model turn (× turnCount); `once`
 * transports pay it a single time.
 */
function surfaceUncached(transport) {
  return SURFACE_POLICY[transport] === 'perTurn'
    ? surface[transport] * turnCount
    : surface[transport]
}

/**
 * CACHE-EFFECTIVE surface contribution — the realistic floor a caching host pays.
 * For `perTurn` (MCP): the first turn WRITES the surface to the provider cache
 * (charged at CACHE_WRITE_MULTIPLIER), then each of the remaining turns READS it from
 * cache at CACHE_READ_MULTIPLIER (~0.1x). For `once` transports the surface is learned
 * a single time regardless, so caching is a no-op — it equals the uncached surface.
 */
function surfaceCacheEffective(transport) {
  if (SURFACE_POLICY[transport] !== 'perTurn') return surface[transport]
  const firstTurn = surface[transport] * CACHE_WRITE_MULTIPLIER
  const cachedTurns = surface[transport] * CACHE_READ_MULTIPLIER * (turnCount - 1)
  // Tokens are whole; round the cache arithmetic so the summary stays integer + deterministic.
  return Math.round(firstTurn + cachedTurns)
}

/**
 * Per-task TOTAL = surface cost + per-operation I/O. Reported under BOTH cost models:
 * `uncached` (surface re-billed in full every turn for MCP) and `cacheEffective`
 * (surface written once then read from cache at ~0.1x). The op I/O is identical under
 * both (it is not a cacheable prefix — fresh request/response every call).
 */
function perTaskUncached(transport) {
  return surfaceUncached(transport) + perOp[transport]
}
function perTaskCacheEffective(transport) {
  return surfaceCacheEffective(transport) + perOp[transport]
}

const rows = ['mcp', 'cli', 'rest'].map((transport) => ({
  transport,
  surfacePolicy: SURFACE_POLICY[transport],
  surfaceTokens: surface[transport],
  perTurnTokens: SURFACE_POLICY[transport] === 'perTurn' ? surface[transport] : 0,
  operationTokens: perOp[transport],
  // Per-task under both cost models (the headline columns).
  perTaskUncached: perTaskUncached(transport),
  perTaskCacheEffective: perTaskCacheEffective(transport),
  roundTrips: trips[transport],
}))

const summary = {
  harness: 'transport-cost-advisory',
  tier: 'advisory',
  tokenizer: 'gpt-tokenizer/o200k_base',
  tokenizerCaveat: 'proxy for Claude tokenizer; relative comparison only',
  turnCount,
  cacheReadMultiplier: CACHE_READ_MULTIPLIER,
  cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
  surfacePolicy: SURFACE_POLICY,
  rows,
}

function renderTable(rows) {
  const header = [
    'transport',
    'policy',
    'surface',
    'per-turn',
    'op-io',
    'per-task(uncached)',
    'per-task(cached)',
    'round-trips',
  ]
  const lines = rows.map((r) => [
    r.transport,
    r.surfacePolicy,
    String(r.surfaceTokens),
    String(r.perTurnTokens),
    String(r.operationTokens),
    String(r.perTaskUncached),
    String(r.perTaskCacheEffective),
    String(r.roundTrips),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((line) => line[i].length)))
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  const out = [fmt(header), fmt(widths.map((w) => '-'.repeat(w)))]
  for (const line of lines) out.push(fmt(line))
  return out.join('\n')
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} else {
  process.stdout.write(`transport token-cost (advisory, static accounting) — turns=${turnCount}\n`)
  process.stdout.write(`tokenizer: ${summary.tokenizer} (proxy for Claude; relative only)\n`)
  process.stdout.write(
    `cache model: read=${CACHE_READ_MULTIPLIER}x write=${CACHE_WRITE_MULTIPLIER}x (MCP surface only)\n\n`,
  )
  process.stdout.write(`${renderTable(rows)}\n`)
}
