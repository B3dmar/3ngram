// SPDX-License-Identifier: Apache-2.0
// Offline unit tests for the GATED tool-selection slice
// (docs/concepts/mcp-surface.mdx). Three things are pinned here: the metric MATH on
// tiny synthetic vectors (so accuracy/margin/overlap cannot drift under a
// refactor without a test moving), the INTEGRITY failure paths — a stale
// description hash and a missing/extra tool must throw, because both would
// otherwise produce a plausible-looking number for a surface nobody serves — and
// the GATE WIRING, since these metrics replaced the MCP tool cap as the surface's
// protection and are only worth that if a broken fixture cannot pass the gate.
//
// No network, no embeddings fixture required: every vector here is hand-written.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  l2Norm,
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

/** The fixture's scenario shape: vector + a hash of the utterance embedded. */
function scenarioEntries(scenarios, vectors) {
  return Object.fromEntries(
    scenarios.map((s) => [s.id, { utteranceSha256: sha256(s.utterance), vector: vectors[s.id] }]),
  )
}

function fixtureFor(overrides = {}) {
  return {
    model: 'synthetic',
    tools: Object.fromEntries(
      Object.entries(TOOL_VECTORS).map(([name, vector]) => [
        name,
        { descriptionSha256: sha256(DESCRIPTIONS[name]), vector },
      ]),
    ),
    toolScenarios: scenarioEntries(SCENARIOS, SCENARIO_VECTORS),
    surfaceScenarios: {},
    ...overrides,
  }
}

test('cosine is 1 for identical, 0 for orthogonal, and scale-invariant', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [7, 0]), 1)
})

test('cosine THROWS on a zero-norm vector instead of returning NaN', () => {
  // NaN is the dangerous answer: it survives every comparison in the ranking and
  // reports as a metric under status: 'ok'. Both argument positions are guarded.
  assert.throws(() => cosine([0, 0], [1, 0]), /cosine is undefined for a zero-norm vector/)
  assert.throws(() => cosine([1, 0], [0, 0]), /cosine is undefined for a zero-norm vector/)
  assert.throws(() => cosine([0, 0], [0, 0]), /regenerate embeddings/)
})

test('l2Norm is the shared definition both ends of the guard use', () => {
  assert.equal(l2Norm([3, 4]), 5)
  assert.equal(l2Norm([0, 0]), 0)
})

test('a zero-norm vector in the fixture is an integrity error, not a NaN metric', () => {
  // Defense at the reading end: the fixture is committed and could be hand-edited
  // after generation, so the slice must not trust the generator's guard alone.
  const zeroTool = fixtureFor()
  zeroTool.tools.beta.vector = [0, 0]
  assert.throws(
    () =>
      computeToolSelection({
        scenarios: { toolScenarios: SCENARIOS, surfaceScenarios: [] },
        fixture: zeroTool,
        registryDescriptions: DESCRIPTIONS,
      }),
    /tool beta description: vector has zero norm/,
  )

  const zeroScenario = fixtureFor()
  zeroScenario.toolScenarios.s2.vector = [0, 0]
  assert.throws(
    () =>
      computeToolSelection({
        scenarios: { toolScenarios: SCENARIOS, surfaceScenarios: [] },
        fixture: zeroScenario,
        registryDescriptions: DESCRIPTIONS,
      }),
    /tool scenario s2: vector has zero norm/,
  )
})

test('a non-finite element in a stored vector is an integrity error', () => {
  const fixture = fixtureFor()
  fixture.toolScenarios.s1.vector = [1, null]
  assert.throws(
    () =>
      computeToolSelection({
        scenarios: { toolScenarios: SCENARIOS, surfaceScenarios: [] },
        fixture,
        registryDescriptions: DESCRIPTIONS,
      }),
    /tool scenario s1: element 1 is not a finite number/,
  )
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
        fixture: fixtureFor({
          toolScenarios: scenarioEntries([SCENARIOS[0]], SCENARIO_VECTORS),
        }),
        registryDescriptions: DESCRIPTIONS,
      }),
    /tool scenarios have no cached embedding: s2/,
  )
})

test('an EDITED utterance under a stable id fails loudly (stale cached vector)', () => {
  // The silent one: ids are stable by design, so retuning the wording in place
  // would otherwise keep scoring the vector of the OLD sentence indefinitely and
  // every metric would still look healthy.
  const edited = [SCENARIOS[0], { ...SCENARIOS[1], utterance: 'b, reworded' }]
  assert.throws(
    () =>
      computeToolSelection({
        scenarios: { toolScenarios: edited, surfaceScenarios: [] },
        fixture: fixtureFor(),
        registryDescriptions: DESCRIPTIONS,
      }),
    (err) => {
      assert.match(err.message, /tool utterance changed since the embeddings were generated: s2/)
      assert.match(err.message, /regenerate embeddings/)
      return true
    },
  )
})

test('a surface-scenario utterance edit is caught the same way', () => {
  const surface = [{ id: 'x1', utterance: 'original', expected_surface: 'resource:memory' }]
  assert.throws(
    () =>
      computeToolSelection({
        scenarios: {
          toolScenarios: SCENARIOS,
          surfaceScenarios: [{ ...surface[0], utterance: 'edited' }],
        },
        fixture: fixtureFor({ surfaceScenarios: scenarioEntries(surface, { x1: [1, 1] }) }),
        registryDescriptions: DESCRIPTIONS,
      }),
    /surface utterance changed since the embeddings were generated: x1/,
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
  // Coverage: EXACTLY 5 scenarios per registered tool. Set equality alone would
  // pass with a single surviving scenario per tool, and a per-tool accuracy over
  // n=1 is noise reported as a metric. 5 is what this fixture promises, so 5 is
  // what is asserted — an exact count also catches accidental duplication, which
  // a >= floor would wave through. (The lifecycle rule for a FUTURE tool is >= 3;
  // that is a different contract and belongs with the change that introduces it.)
  const PER_TOOL = 5
  const counts = new Map([...registered].map((name) => [name, 0]))
  for (const s of scenarios.toolScenarios)
    counts.set(s.expected_tool, counts.get(s.expected_tool) + 1)
  const offenders = [...counts.entries()].filter(([, n]) => n !== PER_TOOL)
  assert.deepEqual(
    offenders,
    [],
    `every registered tool needs exactly ${PER_TOOL} scenarios; offenders: ${offenders
      .map(([name, n]) => `${name}=${n}`)
      .join(', ')}`,
  )
  assert.equal(scenarios.toolScenarios.length, registered.size * PER_TOOL)
  for (const s of scenarios.surfaceScenarios) {
    assert.match(s.expected_surface, /^(resource|prompt):/)
  }
})

test('a missing embeddings fixture is a result, not a throw', () => {
  const slice = runToolSelectionSlice({ fixturesDir, model: 'no-such-model' })
  assert.equal(slice.status, 'fixture-missing')
  assert.ok(slice.path.endsWith(embeddingsFixtureName('no-such-model')))
  const text = formatToolSelection(slice)
  assert.match(text, /gated \(fixtures\/floors\.json\)/)
  assert.match(text, /fixture not generated/)
})

/**
 * Move `from` to `to`, treating "there was nothing to move" as a normal outcome.
 * ACT, do not check-then-act: an existsSync probe followed by a rename is a
 * file-system race (CodeQL js/file-system-race), and the probe buys nothing here
 * because the rename itself already reports absence as ENOENT. Any OTHER errno
 * still throws — a permission or cross-device failure must not pass silently.
 */
function moveIfPresent(from, to) {
  try {
    renameSync(from, to)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

/**
 * Run `fn` with a deliberately CORRUPT embeddings fixture in place, restoring
 * whatever was there before (nothing today; the real fixture once it lands — this
 * must never delete it). Truncated JSON is the realistic corruption: a killed
 * generator run, a bad merge, a partial checkout.
 */
function withCorruptFixture(fn) {
  const target = join(fixturesDir, embeddingsFixtureName('openai-large-1536'))
  const backup = `${target}.test-backup`
  moveIfPresent(target, backup)
  try {
    writeFileSync(target, '{"model":"openai-large-1536","dims":1536,"tools":{"remember":')
    return fn()
  } finally {
    rmSync(target, { force: true })
    moveIfPresent(backup, target)
  }
}

test('a MALFORMED embeddings fixture is an error result, never a throw', () => {
  // Regression pin (cross-audit finding): the reads and parses must sit INSIDE
  // runToolSelectionSlice's try, so the caller decides what to do about it. An
  // uncaught throw would deny run.mjs the chance to print the diagnostic block
  // (with its regenerate hint) before exiting.
  const slice = withCorruptFixture(() =>
    runToolSelectionSlice({ fixturesDir, model: 'openai-large-1536' }),
  )
  assert.equal(slice.status, 'error')
  assert.match(slice.message, /malformed fixture/)
  assert.match(slice.message, /tool-selection-embeddings-openai-large-1536\.json/)
  assert.match(formatToolSelection(slice), /ERROR: malformed fixture/)
})

test('a MALFORMED fixture FAILS the blocking gate at exit 2, never passes it', () => {
  // The load-bearing property of gating this slice. While it was report-only a
  // corrupt fixture printed an error and the gate still said PASS; now that three
  // metrics are ratcheted against it, "did not run" must never be spendable as
  // "did not regress" — a maintainer who truncates the fixture has to be stopped,
  // not congratulated. Exit 2 (integrity), not 1 (regression): nothing was scored.
  const err = withCorruptFixture(() => {
    try {
      execFileSync('node', [join(here, '../src/run.mjs'), '--model', 'openai-large-1536'], {
        encoding: 'utf8',
      })
      return undefined
    } catch (e) {
      return e
    }
  })
  assert.ok(err, 'a corrupt embeddings fixture must fail the gate')
  assert.equal(err.status, 2)
  assert.doesNotMatch(err.stdout, /eval gate: PASS/)
  // The diagnostic still prints BEFORE the exit — the regenerate hint is the whole
  // point of not just throwing.
  assert.match(err.stdout, /gated \(fixtures\/floors\.json\)\n {2}ERROR: malformed fixture/)
  assert.match(err.stdout, /regenerate embeddings/)
  assert.match(err.stderr, /the tool-selection slice is gated and did not run/)
})

test('the standalone CLI exits 2 on the same malformed fixture', () => {
  // Same code either way now: standalone and inside the gate both refuse to score.
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

test('the blocking gate scores the slice into results.slices and ratchets it', () => {
  // The wiring property: the three scalars are GATED metrics, so they have to show
  // up in the JSON the gate prints and be covered by fixtures/floors.json. A metric
  // that is merely printed underneath the JSON is the report-only arrangement this
  // replaced.
  const out = execFileSync('node', [join(here, '../src/run.mjs'), '--model', 'openai-large-1536'], {
    encoding: 'utf8',
  })
  assert.match(out, /eval gate: PASS/)
  assert.match(out, /tool-selection \+ description-overlap — gated \(fixtures\/floors\.json\)/)

  // The JSON block is everything up to the blank line before the human-readable
  // section; JSON.stringify with an indent never emits a blank line of its own.
  const slices = JSON.parse(out.slice(0, out.indexOf('\n\n'))).slices
  const floors = JSON.parse(readFileSync(join(fixturesDir, 'floors.json'), 'utf8'))
  for (const key of ['selection_accuracy_at_1', 'selection_margin']) {
    assert.equal(typeof slices[key], 'number', `${key} must be a gated slice metric`)
    assert.equal(typeof floors.recorded[key], 'number', `${key} needs a floor`)
    assert.ok(slices[key] >= floors.recorded[key], `${key} must sit at or above its floor`)
  }
  // Overlap is the one metric where LOWER is better, so it is a CEILING. Pinned
  // here because storing it under `recorded` would silently invert the comparison
  // and gate the surface the wrong way for as long as nobody re-derived it by hand.
  assert.equal(typeof slices.max_description_overlap, 'number')
  assert.equal(floors.recorded.max_description_overlap, undefined)
  assert.equal(typeof floors.ceilings.max_description_overlap, 'number')
  assert.ok(slices.max_description_overlap <= floors.ceilings.max_description_overlap)
})
