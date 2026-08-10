// SPDX-License-Identifier: Apache-2.0
// ONE-TIME generator for eval/fixtures/tool-selection-embeddings-<model>.json —
// the cached vectors the report-only tool-selection slice (src/tool-selection.mjs)
// scores offline. Modelled on pipeline/embed.mjs (same provider path, same model
// naming) and on scripts/gen-transport-surfaces.mjs (generated once, committed,
// never on the slice's runtime path).
//
// WHAT IT EMBEDS
//   (a) every scenario utterance in fixtures/tool-selection.json — the tool
//       scenarios AND the non-tool surface scenarios, keyed by scenario id (not
//       by index, so re-ordering the fixture cannot silently re-label a vector);
//   (b) every TOOL DESCRIPTION as the registry currently exports it, stored with
//       a sha256 of the EXACT text embedded. That hash is the slice's tripwire:
//       edit a description without re-running this script and the slice fails
//       loudly instead of scoring a vector for text nobody serves.
//
// DESCRIPTION SOURCE + LIVE CROSS-CHECK. Descriptions come from the committed
// fixtures/transport-surfaces.json (the real tools/list capture). When
// apps/server has been BUILT, this script additionally reads the live registry
// (apps/server/dist/mcp/tools.js) and refuses to generate if the two disagree —
// so an embedding fixture can never be built from a stale capture. When the
// build is absent the cross-check is SKIPPED with a printed notice (never
// silently): the capture is then trusted as-is.
//
// RESPONSE VALIDATION BEFORE WRITE. Nothing from the HTTP body is written
// through. Each batch must return exactly as many items as it sent; items are
// aligned by their declared `index` (a re-ordered response would mislabel every
// vector against its utterance and score plausibly forever); and each embedding
// is REBUILT as a fresh array of exactly DIMS numbers, every element passed
// through Number() with a finiteness check. Any violation aborts before the
// fixture is touched — an HTML error page, a truncated body, or a silently
// re-dimensioned model must never become the artifact the gate trusts.
//
// PROVIDER ACCESS. eval/ is deliberately outside scripts/check-no-direct-provider.sh
// (the harness compares providers directly by design — see that script's header),
// so this calls the embeddings endpoint the same way pipeline/embed.mjs does.
// Nothing in apps/ or packages/ may do this.
//
// Usage (needs an API key; one command, no other prerequisites):
//   OPENAI_API_KEY=… node eval/scripts/gen-tool-selection-embeddings.mjs
//   # optional: --model openai-large-1536 (default)
//   # optional live cross-check: pnpm --filter @3ngram/server build first
// The output is >1 MB, above Biome's file ceiling, so it is committed compact
// like the golden-set embeddings — no formatting pass needed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { embeddingsFixtureName, loadRegistryDescriptions, sha256 } from '../src/tool-selection.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures')
const args = process.argv.slice(2)
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'openai-large-1536'

const API_KEY = process.env.OPENAI_API_KEY ?? process.env.LLM_GATEWAY_API_KEY
const BASE_URL = process.env.LLM_GATEWAY_URL || 'https://api.openai.com/v1'

/**
 * Credential + model preconditions. Inside a function, not at module top level,
 * so the validators below can be imported by a test without the import itself
 * calling process.exit — see the main() guard at the bottom.
 */
function assertPreconditions() {
  if (!API_KEY) {
    process.stderr.write(
      'no embedding credential: set OPENAI_API_KEY (or LLM_GATEWAY_API_KEY) and re-run.\n',
    )
    process.exit(2)
  }
  if (model !== 'openai-large-1536') {
    process.stderr.write(
      `unsupported model ${model}; this slice is generated for openai-large-1536\n`,
    )
    process.exit(2)
  }
}

/**
 * Read the LIVE registry descriptions from apps/server's BUILT dist and assert
 * the committed capture still matches. Returns a status string for the log; a
 * disagreement is fatal (generating from a stale capture is exactly the drift
 * the hashes exist to catch).
 */
async function crossCheckLiveRegistry(captured) {
  const dist = join(here, '../../apps/server/dist/mcp/tools.js')
  if (!existsSync(dist)) return 'SKIPPED (apps/server not built — capture trusted as-is)'
  const { TOOLS } = await import(pathToFileURL(dist).href)
  const live = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.config.description]))
  const names = [...new Set([...Object.keys(live), ...Object.keys(captured)])].sort()
  const drifted = names.filter((name) => live[name] !== captured[name])
  if (drifted.length) {
    process.stderr.write(
      `transport-surfaces.json is stale for: ${drifted.join(', ')}\n` +
        'refresh it first: node eval/scripts/gen-transport-surfaces.mjs > eval/fixtures/transport-surfaces.json\n',
    )
    process.exit(2)
  }
  return `OK (${names.length} tools match the live registry)`
}

/**
 * The dimensionality this fixture is generated at, and the ONLY length accepted
 * back from the provider. The gate's cosine is undefined across ragged vectors,
 * so a short row would not fail loudly later — it would score.
 */
const DIMS = 1536

/**
 * Rebuild ONE embedding as fresh primitives. Nothing from the response body is
 * written through: every element goes through Number() and a finiteness check,
 * and the result is a newly allocated array of plain numbers. A string, null,
 * NaN, Infinity, a nested object, or a wrong length is a hard failure — an HTML
 * error page, a truncated body, or a silently re-dimensioned model must never
 * reach the fixture the gate trusts.
 */
export function toVector(embedding, position) {
  if (!Array.isArray(embedding) || embedding.length !== DIMS) {
    const shape = Array.isArray(embedding) ? `length ${embedding.length}` : typeof embedding
    throw new Error(`embeddings response item ${position}: expected ${DIMS} numbers, got ${shape}`)
  }
  const vector = new Array(DIMS)
  for (let i = 0; i < DIMS; i++) {
    // typeof FIRST, then Number(). Coercion alone is not a validation: JSON null
    // coerces to a perfectly finite 0, so a body with holes in it would have been
    // accepted as a vector of real zeros. (Caught by exercising the generator
    // against a fake provider — the check as first written let it through.)
    const raw = embedding[i]
    const value = typeof raw === 'number' ? Number(raw) : Number.NaN
    if (!Number.isFinite(value)) {
      throw new Error(
        `embeddings response item ${position}: element ${i} is ${raw === null ? 'null' : typeof raw}, not a finite number`,
      )
    }
    vector[i] = value
  }
  return vector
}

/**
 * Order a batch response by its declared `index` and assert it covers the batch
 * exactly. Alignment is load-bearing: a re-ordered response would mislabel every
 * vector against its utterance and the slice would report a plausible, wrong
 * number forever. A partially indexed batch is malformed, not a fallback case.
 */
export function orderedItems(data, expected) {
  if (!Array.isArray(data) || data.length !== expected) {
    const got = Array.isArray(data) ? data.length : typeof data
    throw new Error(`embeddings response: expected ${expected} items, got ${got}`)
  }
  const indexed = data.filter((item) => Number.isInteger(item?.index))
  if (indexed.length === 0) return data
  if (indexed.length !== data.length) {
    throw new Error('embeddings response mixes indexed and unindexed items — cannot align')
  }
  const ordered = new Array(expected)
  for (const item of data) {
    if (item.index < 0 || item.index >= expected || ordered[item.index] !== undefined) {
      throw new Error(`embeddings response has a duplicate or out-of-range index ${item.index}`)
    }
    ordered[item.index] = item
  }
  return ordered
}

/** Parse the batch response, failing with a readable message on a non-JSON body. */
async function parseBatch(res) {
  const body = await res.text()
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`embeddings response is not JSON: ${body.slice(0, 200)}`)
  }
}

async function embed(texts) {
  const out = []
  const batchSize = 64
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-large', input: batch, dimensions: DIMS }),
    })
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const items = orderedItems((await parseBatch(res)).data, batch.length)
    out.push(...items.map((item, j) => toVector(item?.embedding, i + j)))
    process.stdout.write(`\r${Math.min(i + batchSize, texts.length)}/${texts.length}`)
  }
  return out
}

/** Embed a scenario array and key the vectors by scenario id. */
async function embedScenarios(scenarios) {
  const vectors = await embed(scenarios.map((s) => s.utterance))
  return Object.fromEntries(scenarios.map((s, i) => [s.id, vectors[i]]))
}

async function main() {
  assertPreconditions()
  const scenarios = JSON.parse(readFileSync(join(fixtures, 'tool-selection.json'), 'utf8'))
  const descriptions = loadRegistryDescriptions(fixtures)
  process.stdout.write(`live registry cross-check: ${await crossCheckLiveRegistry(descriptions)}\n`)

  const toolNames = Object.keys(descriptions).sort()
  const toolVectors = await embed(toolNames.map((name) => descriptions[name]))
  const toolScenarios = await embedScenarios(scenarios.toolScenarios)
  const surfaceScenarios = await embedScenarios(scenarios.surfaceScenarios)

  // Reached only when EVERY vector validated: the write is the last thing that
  // happens, so a malformed batch aborts with the previous fixture untouched.
  writeFileSync(
    join(fixtures, embeddingsFixtureName(model)),
    JSON.stringify({
      model,
      // Not read back off the response: every vector was rebuilt at exactly DIMS.
      dims: DIMS,
      descriptionSource: 'eval/fixtures/transport-surfaces.json (real tools/list capture)',
      generatedBy: 'eval/scripts/gen-tool-selection-embeddings.mjs',
      tools: Object.fromEntries(
        toolNames.map((name, i) => [
          name,
          { descriptionSha256: sha256(descriptions[name]), vector: toolVectors[i] },
        ]),
      ),
      toolScenarios,
      surfaceScenarios,
    }),
  )
  process.stdout.write(
    `\n${model}: ${toolNames.length} tool + ${scenarios.toolScenarios.length} tool-scenario + ${scenarios.surfaceScenarios.length} surface-scenario vectors, ${DIMS}d (all validated)\n`,
  )
}

// Run only as a script. Importing this module (the validator tests do) must not
// generate anything, hit the network, or exit the process.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
