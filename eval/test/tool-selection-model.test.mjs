// SPDX-License-Identifier: Apache-2.0
// Offline unit tests for the model-in-the-loop tool-selection slice (advisory,
// nightly-only). No network, no live model: gateways are hand-written fakes
// mirroring the packages/llm Gateway contract, same as judge.test.mjs. Only
// the PURE parts are pinned here — prompt building, answer parsing/
// normalization, metric aggregation, gateway-failure handling and agreement
// computation — plus gateway construction, proxy-unavailable resolution, and
// the CLI's skip-path behavior (both text and --json).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { embeddingsFixtureName } from '../src/tool-selection.mjs'
import {
  aggregateModelSelection,
  buildSelectionPrompt,
  computeAgreement,
  createGatewayFromEnv,
  formatToolCatalog,
  GATEWAY_API_KEY_ENV,
  loadProxyOrReason,
  loadProxyPredictions,
  normalizeAnswer,
  parseToolAnswer,
  runModelToolSelection,
  summarizeServedModel,
} from '../src/tool-selection-model.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, '../fixtures')

const TOOLS = [
  { name: 'remember', description: 'Persist a new memory.' },
  { name: 'search', description: 'Rank memories by relevance.' },
]
const TOOL_NAMES = TOOLS.map((t) => t.name)

test('formatToolCatalog lists every tool as "- name: description"', () => {
  const block = formatToolCatalog(TOOLS)
  assert.match(block, /^- remember: Persist a new memory\.$/m)
  assert.match(block, /^- search: Rank memories by relevance\.$/m)
})

test('buildSelectionPrompt embeds the catalog, the utterance, and forces a bare name', () => {
  const prompt = buildSelectionPrompt('save this decision', TOOLS)
  assert.match(prompt, /Available tools:/)
  assert.match(prompt, /- remember: Persist a new memory\./)
  assert.match(prompt, /Need: save this decision/)
  assert.match(prompt, /Respond with ONLY the exact tool name/)
})

test('normalizeAnswer strips wrapping punctuation and takes the first line', () => {
  assert.equal(normalizeAnswer('search'), 'search')
  assert.equal(normalizeAnswer('  search  \n'), 'search')
  assert.equal(normalizeAnswer('`search`'), 'search')
  assert.equal(normalizeAnswer('"search".'), 'search')
  assert.equal(normalizeAnswer('search\nbecause it ranks by relevance'), 'search')
  assert.equal(normalizeAnswer(undefined), '')
})

test('parseToolAnswer matches an exact registered name', () => {
  const result = parseToolAnswer('search', TOOL_NAMES)
  assert.deepEqual(result, { tool: 'search', unparseable: false })
})

test('parseToolAnswer is strict: a near-miss or explanation is unparseable, not an error', () => {
  assert.deepEqual(parseToolAnswer('Search', TOOL_NAMES), { tool: null, unparseable: true })
  assert.deepEqual(parseToolAnswer('the search tool', TOOL_NAMES), {
    tool: null,
    unparseable: true,
  })
  assert.deepEqual(parseToolAnswer('get_facts', TOOL_NAMES), { tool: null, unparseable: true })
  assert.deepEqual(parseToolAnswer('', TOOL_NAMES), { tool: null, unparseable: true })
})

test('aggregateModelSelection scores accuracy, per-tool, confusions and unparseable_rate', () => {
  const picks = [
    { id: 's1', expected_tool: 'remember', predicted: 'remember', unparseable: false },
    { id: 's2', expected_tool: 'remember', predicted: 'search', unparseable: false },
    { id: 's3', expected_tool: 'search', predicted: 'search', unparseable: false },
    { id: 's4', expected_tool: 'search', predicted: null, unparseable: true },
  ]
  const m = aggregateModelSelection(picks)
  assert.equal(m.n, 4)
  assert.equal(m.n_answered, 4)
  assert.equal(m.gateway_error_count, 0)
  assert.equal(m.model_selection_accuracy_at_1, 0.5)
  assert.equal(m.unparseable_rate, 0.25)
  assert.deepEqual(m.per_tool, { remember: 0.5, search: 0.5 })
  assert.deepEqual(m.confusions, [
    { pair: 'remember -> search', count: 1 },
    { pair: 'search -> unparseable', count: 1 },
  ])
})

test('aggregateModelSelection excludes gateway_error picks from both rates, counts them separately', () => {
  const picks = [
    { id: 's1', expected_tool: 'remember', predicted: 'remember', unparseable: false },
    { id: 's2', expected_tool: 'remember', predicted: 'search', unparseable: false },
    // Two gateway failures on 'search' scenarios: must NOT dilute
    // model_selection_accuracy_at_1 / unparseable_rate, and must NOT appear
    // in per_tool or confusions (nothing was learned about the model here).
    {
      id: 's3',
      expected_tool: 'search',
      predicted: null,
      unparseable: false,
      gatewayError: 'timeout',
    },
    { id: 's4', expected_tool: 'search', predicted: null, unparseable: false, gatewayError: '502' },
  ]
  const m = aggregateModelSelection(picks)
  assert.equal(m.n, 4)
  assert.equal(m.n_answered, 2)
  assert.equal(m.gateway_error_count, 2)
  assert.equal(m.model_selection_accuracy_at_1, 0.5) // 1 hit / 2 answered, not / 4
  assert.equal(m.unparseable_rate, 0) // no unparseable among the 2 answered
  assert.deepEqual(m.per_tool, { remember: 0.5 }) // 'search' never got a real answer
  assert.deepEqual(m.confusions, [{ pair: 'remember -> search', count: 1 }])
})

test('aggregateModelSelection reports null rates (not 0) when every call gateway-errored', () => {
  // n_answered: 0 means "nothing was measured", which is a different fact
  // from "the model got everything wrong" (0). 0 would silently read as the
  // latter, so both rates must be null — n and gateway_error_count are the
  // disambiguators a caller reads instead.
  const picks = [
    {
      id: 's1',
      expected_tool: 'remember',
      predicted: null,
      unparseable: false,
      gatewayError: 'timeout',
    },
    {
      id: 's2',
      expected_tool: 'search',
      predicted: null,
      unparseable: false,
      gatewayError: 'timeout',
    },
  ]
  const m = aggregateModelSelection(picks)
  assert.equal(m.n, 2)
  assert.equal(m.n_answered, 0)
  assert.equal(m.gateway_error_count, 2)
  assert.equal(m.model_selection_accuracy_at_1, null)
  assert.equal(m.unparseable_rate, null)
  assert.deepEqual(m.per_tool, {})
  assert.deepEqual(m.confusions, [])
})

test('computeAgreement compares model vs proxy only where both have a parseable pick', () => {
  const picks = [
    { id: 's1', expected_tool: 'remember', predicted: 'remember', unparseable: false },
    { id: 's2', expected_tool: 'remember', predicted: 'search', unparseable: false },
    { id: 's3', expected_tool: 'search', predicted: 'search', unparseable: false },
    // Unparseable: excluded from the comparison entirely (already counted in
    // unparseable_rate — must not also show up as a disagreement).
    { id: 's4', expected_tool: 'search', predicted: null, unparseable: true },
  ]
  const proxy = { s1: 'remember', s2: 'remember', s3: 'search' } // no entry for s4
  const a = computeAgreement(picks, proxy)
  assert.equal(a.compared, 3)
  assert.equal(a.proxy_model_agreement, +(2 / 3).toFixed(4))
  assert.deepEqual(a.disagreements, [
    { id: 's2', expected_tool: 'remember', model: 'search', proxy: 'remember' },
  ])
})

test('computeAgreement excludes gateway_error picks even when the proxy has a prediction', () => {
  const picks = [
    { id: 's1', expected_tool: 'remember', predicted: 'remember', unparseable: false },
    {
      id: 's2',
      expected_tool: 'remember',
      predicted: null,
      unparseable: false,
      gatewayError: 'timeout',
    },
  ]
  const a = computeAgreement(picks, { s1: 'remember', s2: 'remember' })
  assert.equal(a.compared, 1)
  assert.equal(a.proxy_model_agreement, 1)
  assert.deepEqual(a.disagreements, [])
})

test('computeAgreement reports null agreement when nothing is comparable', () => {
  const picks = [{ id: 's1', expected_tool: 'remember', predicted: null, unparseable: true }]
  const a = computeAgreement(picks, { s1: 'remember' })
  assert.equal(a.compared, 0)
  assert.equal(a.proxy_model_agreement, null)
  assert.deepEqual(a.disagreements, [])
})

test('summarizeServedModel reports the first observed model and whether it varied', () => {
  assert.deepEqual(summarizeServedModel(['gpt-4o-mini-2026-01-08', 'gpt-4o-mini-2026-01-08']), {
    served_model: 'gpt-4o-mini-2026-01-08',
    served_model_varied: false,
  })
  assert.deepEqual(summarizeServedModel(['gpt-4o-mini-2026-01-08', 'gpt-4o-mini-2026-02-01']), {
    served_model: 'gpt-4o-mini-2026-01-08',
    served_model_varied: true,
  })
})

test('summarizeServedModel treats missing/empty model values as unobserved, not a variation', () => {
  assert.deepEqual(summarizeServedModel([undefined, '', 'gpt-4o-mini-2026-01-08']), {
    served_model: 'gpt-4o-mini-2026-01-08',
    served_model_varied: false,
  })
  assert.deepEqual(summarizeServedModel([undefined, undefined]), {
    served_model: null,
    served_model_varied: false,
  })
})

test('loadProxyPredictions reuses tool-selection.mjs rankTools, not re-derived math', () => {
  // Orthogonal alpha/beta, gamma at 45deg — same synthetic shape as
  // tool-selection.test.mjs, so a passing test here pins that the SAME
  // ranking (including its name tie-break) is what gets reused.
  const fixture = {
    tools: {
      alpha: { vector: [1, 0] },
      beta: { vector: [0, 1] },
      gamma: { vector: [1, 1] },
    },
    toolScenarios: {
      s1: { vector: [1, 0] }, // nearest: alpha
      s2: { vector: [0, 1] }, // nearest: beta
    },
  }
  const scenarios = [
    { id: 's1', expected_tool: 'alpha' },
    { id: 's2', expected_tool: 'beta' },
    { id: 's3', expected_tool: 'gamma' }, // no cached vector for s3 -> skipped
  ]
  const predictions = loadProxyPredictions(scenarios, fixture)
  assert.deepEqual(predictions, { s1: 'alpha', s2: 'beta' })
})

test('createGatewayFromEnv skips when the secret is absent', () => {
  assert.equal(createGatewayFromEnv({}), null)
})

test('createGatewayFromEnv returns a gateway when the secret is set', () => {
  const env = { [GATEWAY_API_KEY_ENV]: 'sk-test', LLM_GATEWAY_URL: 'https://gw.example/v1' }
  const gateway = createGatewayFromEnv(env)
  assert.ok(gateway)
  assert.equal(typeof gateway.complete, 'function')
})

test('createGatewayFromEnv sends max_completion_tokens:32 and temperature:0 on every request', async () => {
  // No real network: swap the global fetch for an inspecting fake for the
  // duration of this test only, then restore it — pins the exact request
  // body createGatewayFromEnv sends without a live gateway.
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'search' } }],
        model: 'fake-served-model',
      }),
    }
  }
  try {
    const gateway = createGatewayFromEnv({ [GATEWAY_API_KEY_ENV]: 'sk-test' })
    await gateway.complete('prompt one')
    await gateway.complete('prompt two')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requests.length, 2)
  for (const body of requests) {
    assert.equal(body.max_completion_tokens, 32)
    assert.equal(body.temperature, 0)
  }
})

/**
 * Write `content` to `path`, run `fn`, then always delete `path` (even on a
 * thrown assertion). Unlike tool-selection.test.mjs's corrupt-fixture helper,
 * there is nothing to back up and restore here: `path` is keyed off a model
 * name ('test-invalid-model') that no real fixture ever uses, so this can
 * only ever create and remove a file of its own — no pre-existing content to
 * preserve.
 */
function withFixtureFile(path, content, fn) {
  writeFileSync(path, content)
  try {
    return fn()
  } finally {
    rmSync(path, { force: true })
  }
}

test('loadProxyOrReason: fixture absent -> clear reason, no throw (the path every nightly run takes today)', () => {
  const scenarios = [{ id: 'ts-remember-1', expected_tool: 'remember' }]
  const { predictions, reason } = loadProxyOrReason(fixturesDir, 'no-such-model', scenarios)
  assert.equal(predictions, null)
  assert.match(reason, /embeddings fixture not generated/)
})

test('loadProxyOrReason: fixture present but invalid -> integrity-error reason, never a throw', () => {
  const model = 'test-invalid-model'
  const path = join(fixturesDir, embeddingsFixtureName(model))
  const scenarios = [{ id: 'ts-remember-1', expected_tool: 'remember' }]
  const { predictions, reason } = withFixtureFile(
    path,
    '{"model":"test-invalid-model","dims":1536,"tools":{',
    () => loadProxyOrReason(fixturesDir, model, scenarios),
  )
  assert.equal(predictions, null)
  assert.match(reason, /embeddings fixture integrity error/)
  assert.match(reason, /malformed fixture/)
})

/** Fake gateway: answers each scenario with a fixed, injected {text, model} reply by id. */
function fakeGateway(repliesById, model = 'fake-model-v1') {
  const calls = []
  return {
    calls,
    complete(prompt) {
      const match = /Need: (.*)/.exec(prompt)
      calls.push(prompt)
      const text = repliesById[match?.[1]] ?? ''
      return Promise.resolve({ text, model })
    },
  }
}

test('runModelToolSelection integrates prompt building, parsing, aggregation and provenance', async () => {
  const scenarios = [
    { id: 's1', utterance: 'save this decision', expected_tool: 'remember' },
    { id: 's2', utterance: 'rank my memories', expected_tool: 'search' },
  ]
  const gateway = fakeGateway({
    'save this decision': 'remember',
    'rank my memories': 'not a real tool',
  })
  const result = await runModelToolSelection({ scenarios, tools: TOOLS, gateway })
  assert.equal(result.harness, 'tool-selection-model')
  assert.equal(result.tier, 'advisory')
  assert.equal(result.tools, 2)
  assert.equal(result.served_model, 'fake-model-v1')
  assert.equal(result.served_model_varied, false)
  assert.equal(result.metrics.model_selection_accuracy_at_1, 0.5)
  assert.equal(result.metrics.unparseable_rate, 0.5)
  assert.equal(result.metrics.gateway_error_count, 0)
  assert.ok(!('agreement' in result.metrics), 'no proxy predictions were passed in')
  assert.match(result.agreement_note, /proxy_model_agreement skipped/)
})

test('runModelToolSelection attaches proxy agreement when predictions are supplied', async () => {
  const scenarios = [{ id: 's1', utterance: 'save this decision', expected_tool: 'remember' }]
  const gateway = fakeGateway({ 'save this decision': 'remember' })
  const result = await runModelToolSelection({
    scenarios,
    tools: TOOLS,
    gateway,
    proxyPredictions: { s1: 'remember' },
  })
  assert.equal(result.metrics.agreement.compared, 1)
  assert.equal(result.metrics.agreement.proxy_model_agreement, 1)
  assert.equal(result.agreement_note, undefined)
})

test('runModelToolSelection surfaces the specific proxy-unavailable reason when supplied', async () => {
  const scenarios = [{ id: 's1', utterance: 'save this decision', expected_tool: 'remember' }]
  const gateway = fakeGateway({ 'save this decision': 'remember' })
  const result = await runModelToolSelection({
    scenarios,
    tools: TOOLS,
    gateway,
    proxyUnavailableReason: 'embeddings fixture not generated: /fake/path.json',
  })
  assert.equal(result.agreement_note, 'embeddings fixture not generated: /fake/path.json')
})

test('runModelToolSelection tolerates a transient gateway failure: partial metrics, gateway_error_count set', async () => {
  const scenarios = [
    { id: 's1', utterance: 'save this decision', expected_tool: 'remember' },
    { id: 's2', utterance: 'boom', expected_tool: 'remember' },
    { id: 's3', utterance: 'rank my memories', expected_tool: 'search' },
  ]
  const gateway = {
    complete(prompt) {
      if (prompt.includes('Need: boom')) return Promise.reject(new Error('gateway timeout'))
      if (prompt.includes('Need: save this decision')) {
        return Promise.resolve({ text: 'remember', model: 'fake-model-v1' })
      }
      return Promise.resolve({ text: 'search', model: 'fake-model-v1' })
    },
  }
  const result = await runModelToolSelection({ scenarios, tools: TOOLS, gateway })
  // The loop completed all 3 scenarios (not thrown/aborted at s2), and the
  // two that got a real answer are both scored correctly.
  assert.equal(result.metrics.n, 3)
  assert.equal(result.metrics.n_answered, 2)
  assert.equal(result.metrics.gateway_error_count, 1)
  assert.equal(result.metrics.model_selection_accuracy_at_1, 1)
  assert.equal(result.served_model, 'fake-model-v1')
})

test('the real committed catalog parses its own tool names as valid picks', () => {
  // Cheap sanity pin against the real fixtures (no network, just JSON reads):
  // every expected_tool in the committed scenarios is a name that would parse
  // as a valid, non-unparseable pick against the real transport-surfaces
  // catalog this slice loads at runtime.
  const surfaces = JSON.parse(
    readFileSync(join(here, '../fixtures/transport-surfaces.json'), 'utf8'),
  )
  const scenarios = JSON.parse(readFileSync(join(here, '../fixtures/tool-selection.json'), 'utf8'))
  const toolNames = surfaces.mcp.tools.map((t) => t.name)
  for (const s of scenarios.toolScenarios) {
    assert.deepEqual(parseToolAnswer(s.expected_tool, toolNames), {
      tool: s.expected_tool,
      unparseable: false,
    })
  }
})

test('the standalone CLI skips cleanly (exit 0, clear message) with no gateway secret', () => {
  const cli = join(here, '../src/tool-selection-model.mjs')
  const out = execFileSync('node', [cli], {
    encoding: 'utf8',
    env: { ...process.env, LLM_GATEWAY_API_KEY: '' },
  })
  assert.match(out, /^SKIP: LLM_GATEWAY_API_KEY not configured/)
})

test('the standalone CLI --json skip emits a JSON object, not a bare line (safe for | jq)', () => {
  const cli = join(here, '../src/tool-selection-model.mjs')
  const out = execFileSync('node', [cli, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, LLM_GATEWAY_API_KEY: '' },
  })
  const parsed = JSON.parse(out)
  assert.equal(parsed.status, 'skipped')
  assert.match(parsed.reason, /LLM_GATEWAY_API_KEY not configured/)
})
