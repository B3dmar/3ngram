// SPDX-License-Identifier: Apache-2.0
// LongMemEval's own retrieval metrics and gold rules (#516): hand-computed
// cases, then parity with values upstream's Python produced.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  dcg,
  evaluateRetrieval,
  hasUserTarget,
  ndcgAny,
  upstreamGold,
  upstreamMetrics,
} from '../src/retrieval-metrics.mjs'

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} != ${expected}`)

test('DCG weighs ranks 1 and 2 the same, then 1/log2(rank), as upstream does', () => {
  close(dcg([1, 1, 1], 3), 1 + 1 + 1 / Math.log2(3), 'three relevant')
  close(dcg([0, 1], 2), 1, 'rank 2 is undiscounted')
  close(dcg([0, 0, 0, 1, 1], 3), 0, 'cut at k')
})

test('multi-gold: recall_all needs every gold session inside k', () => {
  const corpus = ['g1', 'd1', 'g2', 'd2', 'd3', 'd4', 'g3', 'd5']
  const gold = new Set(['g1', 'g2', 'g3'])
  const at5 = evaluateRetrieval(corpus, gold, corpus, 5)
  assert.equal(at5.recall_any, 1)
  assert.equal(at5.recall_all, 0, 'g3 sits at rank 7')
  assert.equal(evaluateRetrieval(corpus, gold, corpus, 10).recall_all, 1)
  // Actual DCG@5: ranks 1 and 3 = 1 + 1/log2(3); ideal: three gold at ranks 1-3.
  close(at5.ndcg_any, (1 + 1 / Math.log2(3)) / (2 + 1 / Math.log2(3)), 'ndcg@5')
})

test('gold below k scores zero; ideal DCG counts every gold session', () => {
  const ranked = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'g1']
  assert.deepEqual(evaluateRetrieval(ranked, new Set(['g1']), ranked, 5), {
    recall_any: 0,
    recall_all: 0,
    ndcg_any: 0,
  })
  // Gold at ranks 1, 2 and 4: actual 1 + 1 + 1/log2(4); ideal 1 + 1 + 1/log2(3).
  const several = ['g1', 'g2', 'd1', 'g3', 'd2']
  close(
    ndcgAny(several, new Set(['g1', 'g2', 'g3']), several, 5),
    2.5 / (2 + 1 / Math.log2(3)),
    'ideal over three gold',
  )
})

test('upstreamMetrics keys recall_all and ndcg_any at 5 and 10', () => {
  assert.deepEqual(Object.keys(upstreamMetrics(['a'], ['a'], ['a'])), [
    'session_recall_all_at_5',
    'session_ndcg_any_at_5',
    'session_recall_all_at_10',
    'session_ndcg_any_at_10',
  ])
})

const parity = JSON.parse(
  readFileSync(new URL('../fixtures/upstream-retrieval-parity.json', import.meta.url), 'utf8'),
)

test('parity fixture covers every rule upstream applies', () => {
  assert.ok(parity.cases.length >= 10)
  assert.ok(
    parity.cases.some((c) => !c.expected.scored),
    'a skipped question',
  )
})

for (const { name, haystack_sessions, ranked, expected } of parity.cases) {
  test(`matches upstream: ${name}`, () => {
    const question = { haystack_sessions }
    assert.equal(hasUserTarget(question), expected.scored, 'skip rule')
    if (!expected.scored) return
    const gold = upstreamGold(question)
    assert.deepEqual([...gold].sort(), expected.gold, 'gold rule')
    const corpus = haystack_sessions.map((s) => s.session_id)
    for (const k of [5, 10]) {
      const got = evaluateRetrieval(ranked, new Set(gold), corpus, k)
      for (const [metric, value] of Object.entries(expected[`at_${k}`])) {
        close(got[metric], value, `${metric}@${k}`)
      }
    }
  })
}
