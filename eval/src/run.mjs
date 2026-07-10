// SPDX-License-Identifier: Apache-2.0
// Deterministic golden-set eval (blocking slice). Pure in-memory
// cosine over committed cached embeddings — no network, no DB, no models.
// Exact-cosine is the retrieval upper bound; HNSW-approximation parity is
// proven by the db integration suite (hnsw-parity.int.test.ts).
//
// Usage: node eval/src/run.mjs [--model openai-large-1536] [--record]
//   --record  write floors.json from this run (ratchet baseline)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFlag } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures')
const args = process.argv.slice(2)
// Shared parser handles both `--model openai-large-1536` and `--model=…` (#122).
const model = parseFlag(args, 'model', 'openai-large-1536')
const record = args.includes('--record')

const memories = JSON.parse(readFileSync(join(fixtures, 'golden-set.json'), 'utf8'))
const queries = JSON.parse(readFileSync(join(fixtures, 'queries.json'), 'utf8'))
const emb = JSON.parse(readFileSync(join(fixtures, `embeddings-${model}.json`), 'utf8'))

const superseded = new Set(memories.filter((m) => m.replaces).map((m) => m.replaces))

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Supersession-aware retrieval default (docs/concepts/memory-model.mdx): superseded memories are
// excluded from current-time results. K matches the planned search default.
const K = 5
function retrieve(qVec, { includeSuperseded = false } = {}) {
  const scored = memories
    .filter((m) => includeSuperseded || !superseded.has(m.id))
    .map((m) => ({ id: m.id, score: cosine(qVec, emb.memories[m.id]) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, K)
}

// Abstention threshold: calibrated as the midpoint between the highest
// abstention-query top-1 score and the mean answerable top-1 score; the
// calibrated value is frozen into floors.json by --record.
const results = { model, slices: {} }
const top1 = { abstention: [], answerable: [] }

let retrievalHits = 0
let retrievalTotal = 0
let mrr = 0
for (const [qi, q] of queries.entries()) {
  const hits = retrieve(emb.queries[qi])
  if (q.slice === 'abstention') {
    top1.abstention.push(hits[0].score)
    continue
  }
  top1.answerable.push(hits[0].score)
  if (q.slice === 'retrieval' || q.slice === 'supersession') {
    retrievalTotal++
    const rank = hits.findIndex((h) => q.expected.includes(h.id))
    if (rank !== -1) {
      retrievalHits++
      mrr += 1 / (rank + 1)
    }
  }
}

// supersession correctness: successor must rank above any forbidden
// (superseded) memory when superseded rows are INCLUDED in the candidate set —
// proves ranking, not just filtering.
let supOk = 0
const supQueries = queries.map((q, i) => [q, i]).filter(([q]) => q.slice === 'supersession')
for (const [q, qi] of supQueries) {
  const hits = retrieve(emb.queries[qi], { includeSuperseded: true })
  const succRank = hits.findIndex((h) => q.expected.includes(h.id))
  const predRank = hits.findIndex((h) => q.forbidden.includes(h.id))
  if (succRank !== -1 && (predRank === -1 || succRank < predRank)) supOk++
}

// τ discipline (PR #35/#36 review): gate runs score against the FROZEN
// floors.recorded.tau — recalibrating from the candidate run would let a
// degraded embedding set move its own threshold and still pass. τ is only
// (re)computed when recording floors (or when no floors exist yet).
const floorsPath = join(fixtures, 'floors.json')
const priorFloors =
  !record && existsSync(floorsPath) ? JSON.parse(readFileSync(floorsPath, 'utf8')) : null
let tau
if (priorFloors?.recorded?.tau !== undefined) {
  tau = priorFloors.recorded.tau
} else {
  const maxAbst = Math.max(...top1.abstention)
  const meanAns = top1.answerable.reduce((a, b) => a + b, 0) / top1.answerable.length
  tau = (maxAbst + meanAns) / 2
}
const abstOk = top1.abstention.filter((s) => s < tau).length
const ansOk = top1.answerable.filter((s) => s >= tau).length

results.slices = {
  recall_at_5: +(retrievalHits / retrievalTotal).toFixed(4),
  mrr_at_5: +(mrr / retrievalTotal).toFixed(4),
  supersession_correct: +(supOk / supQueries.length).toFixed(4),
  abstention_precision: +(abstOk / top1.abstention.length).toFixed(4),
  answerable_above_tau: +(ansOk / top1.answerable.length).toFixed(4),
  tau: +tau.toFixed(4),
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)

if (record) {
  writeFileSync(floorsPath, JSON.stringify({ model, recorded: results.slices }, null, 2))
  process.stdout.write(`floors recorded for ${model}\n`)
} else if (priorFloors) {
  const floors = priorFloors
  if (floors.model !== model) {
    process.stderr.write(`floors are for ${floors.model}, run model is ${model}\n`)
    process.exit(2)
  }
  const failures = []
  for (const [k, floor] of Object.entries(floors.recorded)) {
    if (k === 'tau') continue
    if (results.slices[k] < floor) failures.push(`${k}: ${results.slices[k]} < floor ${floor}`)
  }
  if (failures.length) {
    process.stderr.write(`EVAL GATE FAIL\n${failures.join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write('eval gate: PASS (all slices at or above floors)\n')
}
