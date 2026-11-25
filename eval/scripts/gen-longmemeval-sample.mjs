// SPDX-License-Identifier: Apache-2.0
// Generator for eval/fixtures/longmemeval-s-sample-50.json (#449): the pinned,
// stratified LongMemEval-S sample for scoring the real retriever on real questions.
//
// It reads the verified, pinned upstream file through download.mjs (the
// gitignored cache, fetched when absent) and writes question IDS ONLY: no
// question, answer or session text is ever committed. The selection is
// deterministic (src/sample.mjs): the same release, quotas and seed always give
// the same ids, so a regenerated fixture that differs means one of those moved.
// Regenerating changes what the lane scores; say so in the PR.
//
//   node eval/scripts/gen-longmemeval-sample.mjs [--seed 449] [--out <path>]
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDataset } from '../src/download.mjs'
import { parseFlag } from '../src/lib.mjs'
import { SAMPLE_ABSTENTION, SAMPLE_QUOTAS, selectSample } from '../src/sample.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SAMPLE_PATH = join(here, '../fixtures/longmemeval-s-sample-50.json')
export const DEFAULT_SEED = 449

/** The fixture body: provenance, the selection rule and the ids. Content-free by construction. */
export function buildSampleFixture(instances, { sha256, bytes, seed }) {
  return {
    description:
      'Pinned, stratified LongMemEval-S sample for scoring the real retriever on real questions (#449): longmemeval.mjs --download --sample. Question ids only; the upstream dataset is never committed. Regenerate with eval/scripts/gen-longmemeval-sample.mjs.',
    dataset: { name: 'longmemeval_s', sha256, bytes },
    seed,
    quotas: SAMPLE_QUOTAS,
    abstention: SAMPLE_ABSTENTION,
    question_ids: selectSample(instances, { seed }),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const seed = Number(parseFlag(args, 'seed', String(DEFAULT_SEED)))
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer')
  const out = parseFlag(args, 'out', DEFAULT_SAMPLE_PATH)
  const { path, sha256, bytes } = await ensureDataset()
  const instances = JSON.parse(readFileSync(path, 'utf8'))
  const fixture = buildSampleFixture(instances, { sha256, bytes, seed })
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
  process.stderr.write(`wrote ${fixture.question_ids.length} ids to ${out}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
