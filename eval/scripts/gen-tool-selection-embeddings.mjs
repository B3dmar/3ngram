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

async function embed(texts) {
  const out = []
  const batchSize = 64
  for (let i = 0; i < texts.length; i += batchSize) {
    const res = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-3-large',
        input: texts.slice(i, i + batchSize),
        dimensions: 1536,
      }),
    })
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`)
    out.push(...(await res.json()).data.map((d) => d.embedding))
    process.stdout.write(`\r${Math.min(i + batchSize, texts.length)}/${texts.length}`)
  }
  return out
}

/** Embed a scenario array and key the vectors by scenario id. */
async function embedScenarios(scenarios) {
  const vectors = await embed(scenarios.map((s) => s.utterance))
  return Object.fromEntries(scenarios.map((s, i) => [s.id, vectors[i]]))
}

const scenarios = JSON.parse(readFileSync(join(fixtures, 'tool-selection.json'), 'utf8'))
const descriptions = loadRegistryDescriptions(fixtures)
const crossCheck = await crossCheckLiveRegistry(descriptions)
process.stdout.write(`live registry cross-check: ${crossCheck}\n`)

const toolNames = Object.keys(descriptions).sort()
const toolVectors = await embed(toolNames.map((name) => descriptions[name]))
const toolScenarios = await embedScenarios(scenarios.toolScenarios)
const surfaceScenarios = await embedScenarios(scenarios.surfaceScenarios)

writeFileSync(
  join(fixtures, embeddingsFixtureName(model)),
  JSON.stringify({
    model,
    dims: toolVectors[0].length,
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
  `\n${model}: ${toolNames.length} tool + ${scenarios.toolScenarios.length} tool-scenario + ${scenarios.surfaceScenarios.length} surface-scenario vectors, ${toolVectors[0].length}d\n`,
)
