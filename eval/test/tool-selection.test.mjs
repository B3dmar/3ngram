// SPDX-License-Identifier: Apache-2.0
// Offline unit tests for the report-only tool-selection slice
// (docs/concepts/mcp-surface.mdx). Two things are pinned here: the metric MATH on
// tiny synthetic vectors (so accuracy/margin/overlap cannot drift under a
// refactor without a test moving), and the INTEGRITY failure paths — a stale
// description hash and a missing/extra tool must throw, because both would
// otherwise produce a plausible-looking number for a surface nobody serves.
//
// No network, no embeddings fixture required: every vector here is hand-written.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertFixtureMatchesRegistry,
  computeToolSelection,
  cosine,
  descriptionOverlap,
  embeddingsFixtureName,
  formatToolSelection,
  runToolSelectionSlice,
  selectionMetrics,
  sha256,
  surfaceAttraction,
} from '../src/tool-selection.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, '../fixtures')

// Three synthetic "descriptions": alpha and beta are orthogonal (perfectly
// separated), gamma sits at 45 degrees to both (the overlapping one).
const TOOL_VECTORS = { alpha: [1, 0], beta: [0, 1], gamma: [1, 1] }
const DESCRIPTIONS = { alpha: 'A', beta: 'B', gamma: 'G' }
// s1 routes to its expected tool; s2 is a deliberate misroute (its utterance
// vector points at beta while the label says alpha).
const SCENARIOS = [
  { id: 's1', utterance: 'a', expected_tool: 'alpha' },
  { id: 's2', utterance: 'b', expected_tool: 'alpha' },
]
const SCENARIO_VECTORS = { s1: [1, 0], s2: [0, 1] }
// cos(45 degrees), rounded the way the slice rounds its metrics.
const HALF_ROOT_TWO = +Math.SQRT1_2.toFixed(4)

function fixtureFor(overrides = {}) {
  return {
    model: 'synthetic',
    tools: Object.fromEntries(
      Object.entries(TOOL_VECTORS).map(([name, vector]) => [
        name,
        { descriptionSha256: sha256(DESCRIPTIONS[name]), vector },
      ]),
    ),
    toolScenarios: SCENARIO_VECTORS,
    surfaceScenarios: {},
    ...overrides,
  }
}

test('cosine is 1 for identical, 0 for orthogonal, and scale-invariant', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [7, 0]), 1)
})

test('selection_accuracy_at_1 counts the nearest description, not the label', () => {
  const m = selectionMetrics(SCENARIOS, SCENARIO_VECTORS, TOOL_VECTORS)
  assert.equal(m.n, 2)
  assert.equal(m.selection_accuracy_at_1, 0.5)
  assert.deepEqual(m.by_tool, { alpha: 0.5 })
})

test('selection_margin is the mean top1-top2 gap, not the top1 score', () => {
  // Both scenarios: winner 1.0, runner-up gamma at cos(45) -> gap 1 - 0.7071.
  const m = selectionMetrics(SCENARIOS, SCENARIO_VECTORS, TOOL_VECTORS)
  assert.equal(m.selection_margin, +(1 - Math.SQRT1_2).toFixed(4))
  assert.ok(m.selection_margin < 1, 'the margin must be a gap, never the raw top score')
})

test('misroutes are reported as directed confusion pairs', () => {
  const m = selectionMetrics(SCENARIOS, SCENARIO_VECTORS, TOOL_VECTORS)
  assert.deepEqual(m.confusions, [{ pair: 'alpha -> beta', count: 1 }])
})

test('max_description_overlap reports the worst pair, not the mean', () => {
  const o = descriptionOverlap(TOOL_VECTORS)
  assert.equal(o.max_description_overlap, HALF_ROOT_TWO)
  // alpha~beta is 0 and alpha~gamma is cos(45): the MAX must win, with its names.
  assert.deepEqual(o.max_overlap_pair, ['alpha', 'gamma'])
})

test('the surface slice reports tool attraction, never an accuracy', () => {
  const surface = [{ id: 'x1', utterance: 'x', expected_surface: 'resource:memory' }]
  const a = surfaceAttraction(surface, { x1: [1, 1] }, TOOL_VECTORS)
  assert.equal(a.n, 1)
  assert.equal(a.rows[0].nearest_tool, 'gamma')
  assert.equal(a.rows[0].cosine, 1)
  assert.equal(a.max_top_tool_cosine, 1)
  assert.ok(!('selection_accuracy_at_1' in a), 'non-tool targets are not scored as accuracy')
})

test('a changed description text fails loudly with a regenerate instruction', () => {
  assert.throws(
    () => assertFixtureMatchesRegistry(fixtureFor(), { ...DESCRIPTIONS, beta: 'B (reworded)' }),
    (err) => {
      assert.match(err.message, /tool description changed/)
      assert.match(err.message, /beta/)
      assert.match(err.message, /regenerate embeddings/)
      return true
    },
  )
})

test('a newly registered tool missing from the fixture fails loudly', () => {
  assert.throws(
    () => assertFixtureMatchesRegistry(fixtureFor(), { ...DESCRIPTIONS, delta: 'D' }),
    /registered but absent from the fixture: delta/,
  )
})

test('a fixture tool that is no longer registered fails loudly', () => {
  const { gamma: _dropped, ...stillRegistered } = DESCRIPTIONS
  assert.throws(
    () => assertFixtureMatchesRegistry(fixtureFor(), stillRegistered),
    /in the fixture but no longer registered: gamma/,
  )
})

test('a scenario with no cached vector fails loudly instead of shrinking the metric', () => {
  assert.throws(
    () =>
      computeToolSelection({
        scenarios: { toolScenarios: SCENARIOS, surfaceScenarios: [] },
        fixture: fixtureFor({ toolScenarios: { s1: [1, 0] } }),
        registryDescriptions: DESCRIPTIONS,
      }),
    /tool scenarios have no cached embedding: s2/,
  )
})

test('computeToolSelection assembles both metric families over one fixture', () => {
  const results = computeToolSelection({
    scenarios: { toolScenarios: SCENARIOS, surfaceScenarios: [] },
    fixture: fixtureFor(),
    registryDescriptions: DESCRIPTIONS,
  })
  assert.equal(results.tools, 3)
  assert.equal(results.selection_accuracy_at_1, 0.5)
  assert.equal(results.max_description_overlap, HALF_ROOT_TWO)
  assert.equal(results.surface_slice.n, 0)
})

test('every scenario in the committed fixture targets a REGISTERED tool', () => {
  // The fixture is authored by hand; a typo'd or retired tool name would quietly
  // guarantee a miss forever. Registered names come from the same committed
  // tools/list capture the slice scores against.
  const scenarios = JSON.parse(readFileSync(join(fixturesDir, 'tool-selection.json'), 'utf8'))
  const surfaces = JSON.parse(readFileSync(join(fixturesDir, 'transport-surfaces.json'), 'utf8'))
  const registered = new Set(surfaces.mcp.tools.map((t) => t.name))
  const ids = new Set()
  for (const s of [...scenarios.toolScenarios, ...scenarios.surfaceScenarios]) {
    assert.ok(!ids.has(s.id), `duplicate scenario id ${s.id}`)
    ids.add(s.id)
  }
  for (const s of scenarios.toolScenarios) {
    assert.ok(registered.has(s.expected_tool), `${s.id} targets unregistered ${s.expected_tool}`)
  }
  // Coverage: every registered tool carries scenarios, so the metric can never
  // report a healthy average while a tool is untested.
  const covered = new Set(scenarios.toolScenarios.map((s) => s.expected_tool))
  assert.deepEqual([...covered].sort(), [...registered].sort())
  for (const s of scenarios.surfaceScenarios) {
    assert.match(s.expected_surface, /^(resource|prompt):/)
  }
})

test('a missing embeddings fixture is reported, never an error', () => {
  const slice = runToolSelectionSlice({ fixturesDir, model: 'no-such-model' })
  assert.equal(slice.status, 'fixture-missing')
  assert.ok(slice.path.endsWith(embeddingsFixtureName('no-such-model')))
  const text = formatToolSelection(slice)
  assert.match(text, /report-only \(no floor yet\)/)
  assert.match(text, /fixture not generated/)
})

/**
 * Run `fn` with a deliberately CORRUPT embeddings fixture in place, restoring
 * whatever was there before (nothing today; the real fixture once it lands — this
 * must never delete it). Truncated JSON is the realistic corruption: a killed
 * generator run, a bad merge, a partial checkout.
 */
function withCorruptFixture(fn) {
  const target = join(fixturesDir, embeddingsFixtureName('openai-large-1536'))
  const backup = `${target}.test-backup`
  const hadReal = existsSync(target)
  if (hadReal) renameSync(target, backup)
  try {
    writeFileSync(target, '{"model":"openai-large-1536","dims":1536,"tools":{"remember":')
    return fn()
  } finally {
    rmSync(target, { force: true })
    if (hadReal) renameSync(backup, target)
  }
}

test('a MALFORMED embeddings fixture is an error result, never a throw', () => {
  // Regression pin (cross-audit finding): the reads and parses must sit INSIDE
  // runToolSelectionSlice's try. A parse outside it throws uncaught, and the
  // report-only guarantee would hold for a stale fixture but not a truncated one.
  const slice = withCorruptFixture(() =>
    runToolSelectionSlice({ fixturesDir, model: 'openai-large-1536' }),
  )
  assert.equal(slice.status, 'error')
  assert.match(slice.message, /malformed fixture/)
  assert.match(slice.message, /tool-selection-embeddings-openai-large-1536\.json/)
  assert.match(formatToolSelection(slice), /ERROR: malformed fixture/)
})

test('a MALFORMED fixture leaves the blocking gate at exit 0, error line printed', () => {
  // The end of the same finding: run.mjs must survive it. execFileSync THROWS on a
  // non-zero exit, so reaching the assertions at all is the exit-0 proof.
  const out = withCorruptFixture(() =>
    execFileSync('node', [join(here, '../src/run.mjs'), '--model', 'openai-large-1536'], {
      encoding: 'utf8',
    }),
  )
  assert.match(out, /eval gate: PASS/)
  assert.match(out, /report-only \(no floor yet\)\n {2}ERROR: malformed fixture/)
})

test('the standalone CLI exits 2 on the same malformed fixture', () => {
  // The documented split: report-only inside the gate, loud non-zero standalone.
  const err = withCorruptFixture(() => {
    try {
      execFileSync('node', [join(here, '../src/tool-selection.mjs')], { encoding: 'utf8' })
      return undefined
    } catch (e) {
      return e
    }
  })
  assert.ok(err, 'the standalone CLI must exit non-zero on a malformed fixture')
  assert.equal(err.status, 2)
  assert.match(err.stdout, /ERROR: malformed fixture/)
})

test('the blocking gate stays green and prints the report-only section', () => {
  // The load-bearing wiring property: report-only means the slice can never move
  // run.mjs's exit code — including while its embeddings fixture does not exist.
  const out = execFileSync('node', [join(here, '../src/run.mjs'), '--model', 'openai-large-1536'], {
    encoding: 'utf8',
  })
  assert.match(out, /eval gate: PASS/)
  assert.match(out, /tool-selection \+ description-overlap — report-only \(no floor yet\)/)
})
