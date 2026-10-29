// SPDX-License-Identifier: Apache-2.0
// Wiring test for the report-only forgetting eval harness. It runs the REAL
// runForgettingPass from the built @3ngram/core over the synthetic mirror with
// recorded fake answers: no network, no database, nothing written outside a
// temp dir. It pins the metrics shape, the zero-collapse count on the
// recurring-episodic slice, that dismissed verdicts are counted, and that the
// out file carries ids, counts and scores only (hard rule 6).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadGolden, runForgettingEval } from '../src/forgetting-eval.mjs'

const FORBIDDEN_KEYS = new Set(['content', 'topic'])

function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, into)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k)
      collectKeys(v, into)
    }
  }
  return into
}

test('runs the pass over the synthetic mirror and reports every metric', async () => {
  const outPath = join(mkdtempSync(join(tmpdir(), 'forgetting-eval-')), 'forgetting.json')
  const metrics = await runForgettingEval({ outPath })

  assert.equal(metrics.reportOnly, true)
  assert.equal(metrics.mode, 'fake')
  assert.equal(metrics.pass.skipped, 0)
  assert.equal(metrics.verdicts.total, metrics.pass.items)
  assert.deepEqual(Object.keys(metrics.splits), ['all', 'dev', 'heldout'])
  for (const split of Object.values(metrics.splits)) {
    assert.deepEqual(Object.keys(split.precision), [
      'archive',
      'supersede',
      'combined',
      'conflict',
      'byType',
    ])
    assert.equal(typeof split.keepRate.rate, 'number')
    assert.equal(split.ece.bins.length, 10)
    // The ADR bar: zero collapses on the recurring-episodic slice.
    assert.equal(split.falseCollapses.count, 0)
    assert.deepEqual(split.falseCollapses.memoryIds, [])
  }
  assert.equal(metrics.splits.all.falseCollapses.recurringEpisodic, 4)
  assert.equal(metrics.thresholds.archive.length, 10)
  assert.equal(metrics.thresholds.archive[0].threshold, 0.5)
  assert.equal(metrics.thresholds.conflict.at(-1).threshold, 0.95)

  // Dismissed verdicts (below threshold, not keep) are captured and counted, and
  // the pass's own dismissed count includes them plus the keeps.
  assert.ok(metrics.verdicts.dismissed > 0)
  assert.equal(metrics.pass.dismissed, metrics.verdicts.dismissed + metrics.verdicts.keep)
  assert.equal(metrics.pass.proposed, metrics.verdicts.proposed)

  // The mirror has one wrong archive on the still-valid slice: precision < 1 proves scoring.
  assert.equal(metrics.splits.all.precision.archive.precision, 0.75)
  assert.equal(metrics.splits.all.precision.supersede.precision, 1)
  assert.equal(metrics.splits.all.keepRate.rate, 0.75)

  const written = JSON.parse(readFileSync(outPath, 'utf8'))
  assert.deepEqual(written, metrics)
  const keys = collectKeys(written)
  for (const key of FORBIDDEN_KEYS) assert.ok(!keys.has(key), `out file must not carry "${key}"`)
})

test('loadGolden rejects a bad schema and a missing file', () => {
  assert.throws(() => loadGolden('/nonexistent/golden.json'), /not found/)
  assert.throws(
    () => loadGolden(new URL('../package.json', import.meta.url).pathname),
    /version must be 1/,
  )
})
