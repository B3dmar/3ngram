// SPDX-License-Identifier: Apache-2.0
// Model-in-the-loop tool-selection slice (nightly ADVISORY tier).
//
// The blocking gate's tool-selection slice (src/tool-selection.mjs) is a
// deterministic PROXY: nearest tool DESCRIPTION by cosine, not a model
// decision. This slice measures the thing the proxy stands in for — a REAL
// model, given the REAL tool catalog (names + descriptions from the committed
// fixtures/transport-surfaces.json capture), forced to pick exactly one tool
// per scenario in fixtures/tool-selection.json (toolScenarios only; the
// non-tool surfaceScenarios have no tool to route to and are out of scope
// here). Drift between the two — the proxy_model_agreement metric — is the
// point: it says how far the offline, zero-cost gate proxy has wandered from
// what an actual model would do.
//
// ADVISORY ONLY: never gates a PR, never touches run.mjs or floors.json.
// Wired into eval-nightly.yml only (continue-on-error), and skips CLEANLY
// (clear log line, exit 0) when LLM_GATEWAY_API_KEY is absent — never a
// silent network dependency.
//
// GATEWAY: same OpenAI-compatible HTTP contract as judge.mjs's
// createGatewayFromEnv (LLM_GATEWAY_API_KEY / LLM_GATEWAY_URL, 30s timeout,
// throws on a non-OK response, '' treated as an unset LLM_GATEWAY_URL). Model
// override is LLM_TOOL_SELECTION_MODEL (default 'gpt-4o-mini', same default
// judge.mjs uses) — a distinct env var from judge.mjs's LLM_JUDGE_MODEL so the
// two advisory lanes can be pointed at different models independently. No
// concurrency limit: judge.mjs's runJudge has none either, and this makes one
// sequential call per scenario the same way.
//
// FORCED STRUCTURED ANSWER: the prompt asks for exactly one bare tool name.
// Anything that is not an EXACT match to a registered tool name is scored as
// an incorrect selection and counted in unparseable_rate — never thrown as a
// harness error. A model ignoring the instruction is a measurement, not a
// bug in this script.
//
// PARTIAL-RUN RESILIENCE: 55 sequential live calls means a single transient
// gateway error must not discard every completed scenario. A per-scenario
// gateway failure is caught and recorded as its OWN pick class,
// `gateway_error` — deliberately kept OUT of unparseable_rate (that metric is
// about MODEL behavior; a dropped connection is infrastructure, not the model
// declining to answer in-vocabulary). model_selection_accuracy_at_1 and
// unparseable_rate are both computed over `n_answered` (scenarios that got a
// real completion), with `n`, `n_answered` and `gateway_error_count` all
// reported explicitly so the denominator is never implicit.
//
// PROVENANCE: the response body's `model` field is recorded as
// `served_model` (first observed value) plus `served_model_varied` (true if
// the provider served more than one model across calls) — the env override
// is a floating alias (e.g. 'gpt-4o-mini'), so week-over-week drift is only
// attributable if the ACTUAL served model is on record.
//
// PROXY REUSE: the deterministic proxy's per-scenario top-1 pick is computed
// with tool-selection.mjs's own exported `rankTools` (cosine-ranking) — the
// SAME math the gate slice uses, never re-derived here. It only runs when
// `runToolSelectionSlice` reports the embeddings fixture as valid ('ok');
// absent or corrupt fixtures skip the agreement section with a clear note
// (loadProxyOrReason), never a failure (report-only end to end).
//
// Usage: node eval/src/tool-selection-model.mjs [--json] [--embeddings-model openai-large-1536]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFlag } from './lib.mjs'
import { embeddingsFixtureName, rankTools, runToolSelectionSlice } from './tool-selection.mjs'

export const GATEWAY_API_KEY_ENV = 'LLM_GATEWAY_API_KEY'
export const MODEL_ENV = 'LLM_TOOL_SELECTION_MODEL'

const round = (n) => +n.toFixed(4)

/** The catalog block: every tool's real name + description, one per line. */
export function formatToolCatalog(tools) {
  return tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
}

/** The forced-choice prompt: the real catalog + the utterance, one bare name back. */
export function buildSelectionPrompt(utterance, tools) {
  return [
    'You are an agent deciding which ONE tool to call for the need below.',
    '',
    'Available tools:',
    formatToolCatalog(tools),
    '',
    `Need: ${utterance}`,
    '',
    'Respond with ONLY the exact tool name from the list above that should handle',
    'this need. Output nothing else: no punctuation, no explanation, no quotes.',
  ].join('\n')
}

/**
 * Strip the wrapping an otherwise-compliant completion tends to add (a
 * trailing newline, backticks, quotes, a trailing period) and take the first
 * line only. This is normalization, not fuzzy matching — parseToolAnswer
 * below still requires an EXACT match against a registered name afterward.
 */
export function normalizeAnswer(text) {
  return (text ?? '')
    .split('\n')[0]
    .trim()
    .replace(/^[`"'*]+|[`"'*.]+$/g, '')
}

/**
 * Parse a forced-choice completion into a registered tool name or null.
 * STRICT by design: anything not an exact match to `toolNames` is
 * "unparseable" — an incorrect selection, not an error.
 */
export function parseToolAnswer(completion, toolNames) {
  const normalized = normalizeAnswer(completion)
  const tool = toolNames.find((name) => name === normalized) ?? null
  return { tool, unparseable: tool === null }
}

/**
 * OpenAI-compatible HTTP gateway — same contract as judge.mjs's
 * createGatewayFromEnv (30s timeout, throws on a non-OK response). Returns
 * null when the secret is absent so the caller skips the live lane cleanly.
 *
 * UNLIKE judge.mjs's gateway, `complete` resolves `{ text, model }` rather
 * than a bare string: `model` is the response body's served-model field
 * (provenance for `served_model` — see module header), not just the
 * requested alias.
 */
export function createGatewayFromEnv(env = process.env) {
  const apiKey = env[GATEWAY_API_KEY_ENV]
  if (!apiKey) return null
  // `||` (not `??`) for BOTH: CI exports LLM_GATEWAY_URL from an optional
  // secret and LLM_TOOL_SELECTION_MODEL from an optional Actions variable, so
  // either arrives as '' when unset — treat empty string as unset for both,
  // same convention judge.mjs uses for LLM_GATEWAY_URL (#122 class of bug: a
  // step that unconditionally sets an env var from an unset vars./secrets.
  // context passes '', and `??` would ship that empty string as the model).
  const baseUrl = (env.LLM_GATEWAY_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = env[MODEL_ENV] || 'gpt-4o-mini'
  return {
    async complete(prompt) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`gateway error: ${res.status} ${res.statusText}`)
      const data = await res.json()
      return { text: data.choices?.[0]?.message?.content ?? '', model: data.model }
    },
  }
}

/**
 * Run one scenario through the gateway and parse its pick. A gateway failure
 * (timeout, non-OK response, network error) is CAUGHT here, not propagated:
 * it becomes a `gatewayError` pick instead of discarding every scenario
 * completed so far in the sequential loop (see module header).
 */
async function selectOne(scenario, tools, toolNames, gateway) {
  const base = { id: scenario.id, expected_tool: scenario.expected_tool }
  let response
  try {
    response = await gateway.complete(buildSelectionPrompt(scenario.utterance, tools))
  } catch (err) {
    return {
      ...base,
      predicted: null,
      unparseable: false,
      gatewayError: err instanceof Error ? err.message : String(err),
    }
  }
  const { tool, unparseable } = parseToolAnswer(response.text, toolNames)
  return { ...base, predicted: tool, unparseable, model: response.model }
}

/**
 * Aggregate per-scenario picks into accuracy@1 (overall + per-tool), directed
 * confusion pairs, and the unparseable rate. Same shape family as
 * tool-selection.mjs's selectionMetrics, with "unparseable" standing in for a
 * predicted name in a confusion pair when the model did not answer
 * in-vocabulary.
 *
 * `gatewayError` picks (see selectOne) are INFRASTRUCTURE failures, not model
 * behavior: they are excluded entirely from accuracy, unparseable_rate,
 * per_tool and confusions, and counted separately as `gateway_error_count`.
 * `n_answered` (= n - gateway_error_count) is the explicit denominator both
 * rates are computed over, so a caller never has to infer it. When
 * `n_answered` is 0 (every call gateway-errored), both rates are `null` —
 * not `0` — because "nothing was measured" and "the model got everything
 * wrong" are different facts; `0` would silently read as the latter. This
 * mirrors computeAgreement's existing null-for-empty-denominator behavior.
 */
export function aggregateModelSelection(picks) {
  const answered = picks.filter((p) => !p.gatewayError)
  const perTool = new Map()
  const confusions = new Map()
  let hits = 0
  let unparseable = 0
  for (const p of answered) {
    const correct = !p.unparseable && p.predicted === p.expected_tool
    if (correct) hits++
    if (p.unparseable) unparseable++
    const tally = perTool.get(p.expected_tool) ?? { hits: 0, total: 0 }
    perTool.set(p.expected_tool, { hits: tally.hits + (correct ? 1 : 0), total: tally.total + 1 })
    if (!correct) {
      const label = p.unparseable ? 'unparseable' : p.predicted
      const key = `${p.expected_tool} -> ${label}`
      confusions.set(key, (confusions.get(key) ?? 0) + 1)
    }
  }
  const denom = answered.length
  return {
    n: picks.length,
    n_answered: denom,
    gateway_error_count: picks.length - denom,
    model_selection_accuracy_at_1: denom > 0 ? round(hits / denom) : null,
    unparseable_rate: denom > 0 ? round(unparseable / denom) : null,
    per_tool: Object.fromEntries(
      [...perTool.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, t]) => [name, round(t.hits / t.total)]),
    ),
    confusions: [...confusions.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair)),
  }
}

/**
 * Agreement with the deterministic embedding proxy. Compared only where the
 * model produced a parseable pick (no gateway error, not unparseable) AND the
 * proxy has a prediction for that scenario id. A gateway-error or unparseable
 * pick is excluded from the denominator — it is already accounted for
 * (gateway_error_count / unparseable_rate), so counting it again here would
 * double-count the same failure as a "disagreement".
 */
export function computeAgreement(picks, proxyPredictions) {
  const disagreements = []
  let agree = 0
  let compared = 0
  for (const p of picks) {
    if (p.gatewayError || p.unparseable) continue
    const proxy = proxyPredictions[p.id]
    if (proxy === undefined) continue
    compared++
    if (proxy === p.predicted) agree++
    else disagreements.push({ id: p.id, expected_tool: p.expected_tool, model: p.predicted, proxy })
  }
  return {
    compared,
    proxy_model_agreement: compared > 0 ? round(agree / compared) : null,
    disagreements,
  }
}

/**
 * Provenance for the LIVE served model: the env override (MODEL_ENV) is a
 * floating alias (e.g. 'gpt-4o-mini' resolves to whatever the provider
 * currently points it at), so attributing week-over-week metric drift needs
 * the ACTUAL model the response body reported. `served_model` is the first
 * observed value; `served_model_varied` flags a run where responses did not
 * all report the same model (a mid-run provider-side alias repoint).
 */
export function summarizeServedModel(models) {
  const seen = models.filter((m) => typeof m === 'string' && m.length > 0)
  if (seen.length === 0) return { served_model: null, served_model_varied: false }
  return { served_model: seen[0], served_model_varied: new Set(seen).size > 1 }
}

/**
 * The deterministic proxy's top-1 pick per tool scenario id, via
 * tool-selection.mjs's own `rankTools` (cosine-ranking) — reused, not
 * re-derived. Callers must only pass a fixture already validated by a
 * successful `runToolSelectionSlice` status 'ok' run over the SAME scenarios:
 * that run has already checked every vector's hash, finiteness and norm.
 */
export function loadProxyPredictions(scenarios, fixture) {
  const toolVectors = Object.fromEntries(
    Object.entries(fixture.tools).map(([name, entry]) => [name, entry.vector]),
  )
  const predictions = {}
  for (const scenario of scenarios) {
    const entry = fixture.toolScenarios[scenario.id]
    if (!entry) continue
    predictions[scenario.id] = rankTools(entry.vector, toolVectors)[0].name
  }
  return predictions
}

/**
 * Run the model-in-the-loop slice: one forced-choice call per tool scenario
 * against the real catalog, aggregated, plus the proxy-agreement section when
 * `proxyPredictions` is provided. Sequential (mirrors judge.mjs's runJudge —
 * no concurrency limit there either); a per-scenario gateway failure is
 * caught inside selectOne, so the loop always completes and reports partial
 * results rather than throwing away everything scored so far.
 *
 * `proxyUnavailableReason` (optional) is the specific reason the caller
 * already knows the proxy predictions are unavailable (from
 * loadProxyOrReason) — plumbed straight through into `agreement_note` so the
 * composition lives in ONE place instead of a post-hoc overwrite by the
 * caller.
 */
export async function runModelToolSelection({
  scenarios,
  tools,
  gateway,
  proxyPredictions,
  proxyUnavailableReason,
}) {
  const toolNames = tools.map((t) => t.name)
  const picks = []
  for (const scenario of scenarios) {
    picks.push(await selectOne(scenario, tools, toolNames, gateway))
  }
  const metrics = aggregateModelSelection(picks)
  if (proxyPredictions) metrics.agreement = computeAgreement(picks, proxyPredictions)
  const { served_model, served_model_varied } = summarizeServedModel(picks.map((p) => p.model))
  const result = {
    harness: 'tool-selection-model',
    tier: 'advisory',
    tools: tools.length,
    served_model,
    served_model_varied,
    metrics,
  }
  if (!proxyPredictions) {
    result.agreement_note =
      proxyUnavailableReason ??
      'embeddings fixture absent or invalid — proxy_model_agreement skipped'
  }
  return result
}

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, '../fixtures')

/** Real tool catalog (name + description) from the committed transport-surfaces capture. */
function loadTools(dir) {
  const surfaces = JSON.parse(readFileSync(join(dir, 'transport-surfaces.json'), 'utf8'))
  return surfaces.mcp.tools
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function loadToolScenarios(dir) {
  const data = JSON.parse(readFileSync(join(dir, 'tool-selection.json'), 'utf8'))
  return data.toolScenarios
}

/**
 * Load the proxy's per-scenario predictions, or a clear reason why not. The
 * fixture missing is the expected/normal case (a separate opt-in generator
 * produces it — and it is not committed today, so this is the path EVERY
 * nightly run takes until that fixture lands); an integrity error is loud in
 * the reason string but still just skips the agreement section — this slice
 * never throws on a stale or corrupt embeddings fixture. Exported for direct
 * unit-test coverage of both branches.
 */
export function loadProxyOrReason(dir, embeddingsModel, scenarios) {
  const slice = runToolSelectionSlice({ fixturesDir: dir, model: embeddingsModel })
  if (slice.status !== 'ok') {
    const reason =
      slice.status === 'fixture-missing'
        ? `embeddings fixture not generated: ${slice.path}`
        : `embeddings fixture integrity error: ${slice.message}`
    return { predictions: null, reason }
  }
  const fixture = JSON.parse(
    readFileSync(join(dir, embeddingsFixtureName(embeddingsModel)), 'utf8'),
  )
  return { predictions: loadProxyPredictions(scenarios, fixture), reason: null }
}

/**
 * Emit the "no gateway secret" skip in whichever shape the caller asked for:
 * a bare human line by default, or `{status:'skipped', reason}` under --json
 * so a `| jq` consumer downstream of this script never hits invalid JSON.
 */
function emitSkip(asJson, reason) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ status: 'skipped', reason })}\n`)
  } else {
    process.stdout.write(
      `SKIP: ${reason} — model-in-the-loop tool-selection slice skipped. Advisory only.\n`,
    )
  }
}

async function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const embeddingsModel = parseFlag(args, 'embeddings-model', 'openai-large-1536')

  const gateway = createGatewayFromEnv()
  if (!gateway) {
    emitSkip(asJson, `${GATEWAY_API_KEY_ENV} not configured`)
    return
  }

  const tools = loadTools(fixturesDir)
  const scenarios = loadToolScenarios(fixturesDir)
  const { predictions, reason } = loadProxyOrReason(fixturesDir, embeddingsModel, scenarios)

  const result = await runModelToolSelection({
    scenarios,
    tools,
    gateway,
    proxyPredictions: predictions,
    proxyUnavailableReason: reason ?? undefined,
  })
  process.stdout.write(`${JSON.stringify(result, null, asJson ? 0 : 2)}\n`)
}

// Run only as a script. Importing this module (unit tests do) must not hit
// the network, read env, or exit the process.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
