// SPDX-License-Identifier: Apache-2.0
// Tool-selection + description-overlap slice (docs/concepts/mcp-surface.mdx).
//
// REPORT-ONLY — this slice has NO floors and NEVER changes an exit code when it
// runs inside the golden-set gate (src/run.mjs). It exists to MEASURE the thing
// the MAX_TOOLS = 12 cap is a proxy for: "tool-selection accuracy degrades as the
// list grows, and every description is re-sent on every tools/list. Two
// well-separated tools cost less than one overloaded one. That is what to
// optimise; the number is a proxy." A later PR baselines floors FROM this
// slice's observed output — do not add floors here.
//
// WHAT IT MEASURES (pure cosine over committed cached embeddings, no network):
//   selection_accuracy_at_1  — an agent utterance's nearest tool DESCRIPTION is
//                              the tool that should serve it.
//   selection_margin         — mean (top1 - top2) cosine gap. Accuracy says the
//                              right tool won; the margin says by how much, which
//                              is what erodes first as descriptions overlap.
//   max_description_overlap  — the largest pairwise cosine between two tool
//                              descriptions, reported WITH the offending pair.
//                              This is the direct read on description separation.
//
// SUBSTITUTION CAVEAT: nearest-description-by-cosine is a deterministic PROXY for
// a model's tool choice, not a model run. It is the same substitution the
// blocking gate makes (exact cosine for the product retriever) and it is what
// keeps this offline and reproducible. Read it as a separation signal, not as a
// prediction of what Claude would call.
//
// THE REGISTRY SOURCE. Tool descriptions are read from the committed
// fixtures/transport-surfaces.json — the REAL tools/list payload captured from
// the live registry by scripts/gen-transport-surfaces.mjs. That capture is the
// only offline projection of the registry available to a slice that must not
// build or import apps/server. The generator for this slice's embeddings
// cross-checks it against the live built registry, so an embedding fixture can
// never be generated from a stale capture.
//
// FAILURE IS LOUD, NOT SILENT. The computation THROWS when the fixture no longer
// describes what it claims: a tool description hash that no longer matches the
// registry text, a SCENARIO UTTERANCE edited under its cached vector (ids are
// stable, so this is the easy one to miss), a registered tool missing from the
// fixture or a fixture tool no longer registered, or a vector that cosine cannot
// score. Run standalone it exits 2; wired into run.mjs the error is printed
// prominently and the gate's exit code is left alone (report-only).
//
// Usage: node eval/src/tool-selection.mjs [--model openai-large-1536] [--json]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFlag } from './lib.mjs'

/** Appended to every integrity failure so the fix is never a guess. */
export const REGENERATE_HINT =
  'regenerate embeddings: node eval/scripts/gen-tool-selection-embeddings.mjs (see eval/README.md)'

/** The embeddings fixture name for a model, matching the golden-set convention. */
export function embeddingsFixtureName(model) {
  return `tool-selection-embeddings-${model}.json`
}

/**
 * L2 norms below this are treated as zero. Cosine is UNDEFINED against a
 * zero-norm vector (0/0 = NaN), and NaN does not fail — it propagates through
 * the comparisons silently and reports as a metric. The fixture is committed and
 * could in principle be hand-edited, so the guard lives at BOTH ends: the
 * generator refuses to write such a vector, and this module refuses to score one.
 */
const MIN_VECTOR_NORM = 1e-9

/** Euclidean norm — exported so both ends of the guard share one definition. */
export function l2Norm(vector) {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  return Math.sqrt(sum)
}

export function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denominator = Math.sqrt(na) * Math.sqrt(nb)
  // `!(x > 0)` on purpose: catches 0 AND NaN. Returning NaN here would turn a
  // corrupt vector into a plausible-looking score instead of a loud failure.
  if (!(denominator > 0)) {
    throw new Error(`cosine is undefined for a zero-norm vector. ${REGENERATE_HINT}`)
  }
  return dot / denominator
}

/** sha256 of the EXACT text that was embedded — the drift tripwire. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * A stored vector is usable iff every element is a finite number and its norm is
 * not effectively zero. Checked at LOAD, so a corrupt fixture is named here
 * rather than surfacing as a NaN metric under `status: 'ok'`.
 */
function assertUsableVector(vector, label) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`${label}: expected a non-empty vector. ${REGENERATE_HINT}`)
  }
  const bad = vector.findIndex((v) => typeof v !== 'number' || !Number.isFinite(v))
  if (bad !== -1) {
    throw new Error(`${label}: element ${bad} is not a finite number. ${REGENERATE_HINT}`)
  }
  if (l2Norm(vector) < MIN_VECTOR_NORM) {
    throw new Error(`${label}: vector has zero norm, cosine would be undefined. ${REGENERATE_HINT}`)
  }
}

const round = (n) => +n.toFixed(4)

/** How many confusion pairs the human-readable block prints before eliding. */
const TOP_CONFUSIONS = 5

/**
 * Assert the embedding fixture still describes the registry it was generated
 * from. Three failure classes, each named explicitly so the message says what to
 * do: a tool registered but absent from the fixture, a fixture tool no longer
 * registered, and a description whose text changed under a stored vector (the
 * silent one — the vector would still score, just for text nobody serves).
 */
export function assertFixtureMatchesRegistry(fixture, registryDescriptions) {
  const inFixture = new Set(Object.keys(fixture.tools))
  const inRegistry = new Set(Object.keys(registryDescriptions))
  const missing = [...inRegistry].filter((name) => !inFixture.has(name)).sort()
  const extra = [...inFixture].filter((name) => !inRegistry.has(name)).sort()
  if (missing.length || extra.length) {
    const parts = []
    if (missing.length) parts.push(`registered but absent from the fixture: ${missing.join(', ')}`)
    if (extra.length) parts.push(`in the fixture but no longer registered: ${extra.join(', ')}`)
    throw new Error(
      `tool-selection fixture is out of date — ${parts.join('; ')}. ${REGENERATE_HINT}`,
    )
  }
  const drifted = [...inRegistry]
    .filter((name) => fixture.tools[name].descriptionSha256 !== sha256(registryDescriptions[name]))
    .sort()
  if (drifted.length) {
    throw new Error(
      `tool description changed since the embeddings were generated: ${drifted.join(', ')}. ${REGENERATE_HINT}`,
    )
  }
}

/** Rank every tool description against one utterance vector, best first. */
function rankTools(utteranceVector, toolVectors) {
  return Object.entries(toolVectors)
    .map(([name, vector]) => ({ name, score: cosine(utteranceVector, vector) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/**
 * Accuracy@1 + mean top1-top2 margin over the tool scenarios, with the per-tool
 * breakdown and the observed confusion pairs — the two things the later
 * floor-baselining PR needs to argue about a specific description, not a number.
 */
export function selectionMetrics(scenarios, utteranceVectors, toolVectors) {
  const perTool = new Map()
  const confusions = new Map()
  let hits = 0
  let marginSum = 0
  for (const scenario of scenarios) {
    const ranked = rankTools(utteranceVectors[scenario.id], toolVectors)
    const predicted = ranked[0].name
    const correct = predicted === scenario.expected_tool
    marginSum += ranked[0].score - ranked[1].score
    if (correct) hits++
    const tally = perTool.get(scenario.expected_tool) ?? { hits: 0, total: 0 }
    perTool.set(scenario.expected_tool, {
      hits: tally.hits + (correct ? 1 : 0),
      total: tally.total + 1,
    })
    if (!correct) {
      const key = `${scenario.expected_tool} -> ${predicted}`
      confusions.set(key, (confusions.get(key) ?? 0) + 1)
    }
  }
  return {
    n: scenarios.length,
    selection_accuracy_at_1: round(hits / scenarios.length),
    selection_margin: round(marginSum / scenarios.length),
    by_tool: Object.fromEntries(
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
 * The largest pairwise cosine between two tool descriptions, with the pair. This
 * is the metric the surface budget actually turns on: two descriptions that sit
 * on top of each other cost selection accuracy no matter how few tools there are.
 */
export function descriptionOverlap(toolVectors) {
  const names = Object.keys(toolVectors).sort()
  let max = { pair: [], score: Number.NEGATIVE_INFINITY }
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const score = cosine(toolVectors[names[i]], toolVectors[names[j]])
      if (score > max.score) max = { pair: [names[i], names[j]], score }
    }
  }
  return { max_description_overlap: round(max.score), max_overlap_pair: max.pair }
}

/**
 * The non-tool slice. These utterances belong to the memory RESOURCE or to a
 * PROMPT, neither of which has a description in the committed registry capture,
 * so there is nothing honest to score them against as a target. What IS
 * measurable — and is the real question for the surface budget — is how hard the
 * tool descriptions PULL on a need that is not a tool's: the nearest tool and how
 * close it gets. Reported, never scored as accuracy.
 */
export function surfaceAttraction(surfaceScenarios, utteranceVectors, toolVectors) {
  const rows = surfaceScenarios.map((scenario) => {
    const [top] = rankTools(utteranceVectors[scenario.id], toolVectors)
    return {
      id: scenario.id,
      expected_surface: scenario.expected_surface,
      nearest_tool: top.name,
      cosine: round(top.score),
    }
  })
  if (!rows.length) return { n: 0, mean_top_tool_cosine: 0, max_top_tool_cosine: 0, rows }
  const mean = rows.reduce((sum, r) => sum + r.cosine, 0) / rows.length
  return {
    n: rows.length,
    mean_top_tool_cosine: round(mean),
    max_top_tool_cosine: round(Math.max(...rows.map((r) => r.cosine))),
    rows,
  }
}

/**
 * Read + parse a fixture, naming the FILE on a parse failure. A bare
 * `Unexpected end of JSON input` says nothing about which of three fixtures is
 * corrupt, and this error is the one a reader sees inside an otherwise-green gate.
 */
function readJson(path) {
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`malformed fixture ${path}: ${reason}. ${REGENERATE_HINT}`)
  }
}

/** Tool descriptions exactly as the SDK serves them, from the committed capture. */
export function loadRegistryDescriptions(fixturesDir) {
  const surfaces = readJson(join(fixturesDir, 'transport-surfaces.json'))
  return Object.fromEntries(surfaces.mcp.tools.map((tool) => [tool.name, tool.description]))
}

/**
 * Resolve every scenario to its cached vector, validating the whole contract on
 * the way: a vector exists, its stored utteranceSha256 still matches the CURRENT
 * utterance text, and the vector is usable.
 *
 * The hash is the load-bearing part. Scenario ids are stable by design, so
 * editing an utterance in place — the most natural way to tune this fixture —
 * would otherwise keep scoring the vector of the OLD wording indefinitely, and
 * every metric would look fine. Same tripwire the tool descriptions carry.
 */
function resolveScenarioVectors(scenarios, entries, label) {
  const missing = scenarios.filter((s) => !Array.isArray(entries[s.id]?.vector)).map((s) => s.id)
  if (missing.length) {
    throw new Error(
      `${label} scenarios have no cached embedding: ${missing.join(', ')}. ${REGENERATE_HINT}`,
    )
  }
  const drifted = scenarios
    .filter((s) => entries[s.id].utteranceSha256 !== sha256(s.utterance))
    .map((s) => s.id)
  if (drifted.length) {
    throw new Error(
      `${label} utterance changed since the embeddings were generated: ${drifted.join(', ')}. ${REGENERATE_HINT}`,
    )
  }
  for (const s of scenarios) assertUsableVector(entries[s.id].vector, `${label} scenario ${s.id}`)
  return Object.fromEntries(scenarios.map((s) => [s.id, entries[s.id].vector]))
}

/** The whole report, computed from already-loaded data (pure — the test seam). */
export function computeToolSelection({ scenarios, fixture, registryDescriptions }) {
  assertFixtureMatchesRegistry(fixture, registryDescriptions)
  const toolUtterances = resolveScenarioVectors(
    scenarios.toolScenarios,
    fixture.toolScenarios,
    'tool',
  )
  const surfaceUtterances = resolveScenarioVectors(
    scenarios.surfaceScenarios,
    fixture.surfaceScenarios,
    'surface',
  )
  const toolVectors = Object.fromEntries(
    Object.entries(fixture.tools).map(([name, entry]) => {
      assertUsableVector(entry.vector, `tool ${name} description`)
      return [name, entry.vector]
    }),
  )
  return {
    model: fixture.model,
    tools: Object.keys(toolVectors).length,
    ...selectionMetrics(scenarios.toolScenarios, toolUtterances, toolVectors),
    ...descriptionOverlap(toolVectors),
    surface_slice: surfaceAttraction(scenarios.surfaceScenarios, surfaceUtterances, toolVectors),
  }
}

/**
 * Load + compute, reporting the three states the caller must distinguish:
 * `fixture-missing` (the embeddings have not been generated yet — NOT an error,
 * the slice is report-only and must not break CI before the fixture lands),
 * `error` (integrity failure, loud), and `ok`.
 *
 * EVERY read and parse is inside the try, deliberately. A truncated or malformed
 * fixture is exactly as plausible as a stale one (a half-written generator run, a
 * bad merge, an LFS miss), and a JSON.parse outside this boundary would throw
 * UNCAUGHT — sinking the blocking gate with exit 1 and breaking the report-only
 * guarantee this module opens with. Report-only has to hold for malformed input
 * too, or it does not hold.
 */
export function runToolSelectionSlice({ fixturesDir, model }) {
  const embeddingsPath = join(fixturesDir, embeddingsFixtureName(model))
  if (!existsSync(embeddingsPath)) {
    return { status: 'fixture-missing', path: embeddingsPath }
  }
  try {
    return {
      status: 'ok',
      results: computeToolSelection({
        scenarios: readJson(join(fixturesDir, 'tool-selection.json')),
        fixture: readJson(embeddingsPath),
        registryDescriptions: loadRegistryDescriptions(fixturesDir),
      }),
    }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/** Human-readable block, shared by the standalone CLI and run.mjs. */
export function formatToolSelection(slice) {
  const head = 'tool-selection + description-overlap — report-only (no floor yet)'
  if (slice.status === 'fixture-missing') {
    return `${head}\n  fixture not generated: ${slice.path}\n  ${REGENERATE_HINT}`
  }
  if (slice.status === 'error') return `${head}\n  ERROR: ${slice.message}`
  const r = slice.results
  const lines = [
    head,
    `  scenarios=${r.n} tools=${r.tools} model=${r.model}`,
    `  selection_accuracy_at_1=${r.selection_accuracy_at_1}  selection_margin=${r.selection_margin}`,
    `  max_description_overlap=${r.max_description_overlap} (${r.max_overlap_pair.join(' ~ ')})`,
    `  surface slice (non-tool targets, n=${r.surface_slice.n}): mean nearest-tool cosine=${r.surface_slice.mean_top_tool_cosine}, max=${r.surface_slice.max_top_tool_cosine}`,
  ]
  if (r.confusions.length) {
    // Only the worst few: a degenerate run produces a confusion pair per scenario,
    // and a screenful of them would bury the gated metrics printed above. The
    // full list is always available in the --json output.
    const shown = r.confusions.slice(0, TOP_CONFUSIONS)
    const rest = r.confusions.length - shown.length
    const tail = rest > 0 ? `, +${rest} more (--json for all)` : ''
    lines.push(`  top misroutes: ${shown.map((c) => `${c.pair} x${c.count}`).join(', ')}${tail}`)
  }
  return lines.join('\n')
}

// Standalone CLI. Here — and ONLY here — an integrity failure exits non-zero; the
// run.mjs wiring stays report-only.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
  const slice = runToolSelectionSlice({
    fixturesDir,
    model: parseFlag(args, 'model', 'openai-large-1536'),
  })
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(slice, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatToolSelection(slice)}\n`)
  }
  if (slice.status === 'error') process.exit(2)
}
