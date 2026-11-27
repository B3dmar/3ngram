// SPDX-License-Identifier: Apache-2.0
// The BM25 retriever: exact parity with rank_bm25 0.2.2 BM25Okapi, which
// LongMemEval's published BM25 baseline uses, plus its corpus and tie rules.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { bm25Retriever, bm25Scores, rankByScore, spaceTokens, userTurnsText } from '../src/bm25.mjs'

const parity = JSON.parse(
  readFileSync(new URL('../fixtures/bm25-parity.json', import.meta.url), 'utf8'),
)

for (const { name, docs, query, scores } of parity.cases) {
  test(`matches rank_bm25: ${name}`, () => {
    const got = bm25Scores(docs.map(spaceTokens), spaceTokens(query))
    assert.equal(got.length, scores.length)
    for (const [i, value] of got.entries()) {
      assert.equal(value, scores[i], `doc ${i}: ${value} != ${scores[i]}`)
    }
  })
}

test('splitting on single spaces keeps empty tokens and case, as Python split(" ") does', () => {
  assert.deepEqual(spaceTokens('a  B c'), ['a', '', 'B', 'c'])
})

test('the session key is the user turns only, joined by single spaces', () => {
  const session = {
    turns: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'never indexed' },
      { role: 'user', content: 'second' },
    ],
  }
  assert.equal(userTurnsText(session), 'first second')
})

test('ties rank the later index first, as a reversed stable ascending sort does', () => {
  assert.deepEqual(rankByScore([0.5, 0, 0.5, 1, 0]), [3, 2, 0, 4, 1])
})

test('every haystack entry is ranked, duplicates included', async () => {
  const s = (id, text) => ({ session_id: id, turns: [{ role: 'user', content: text }] })
  const ranked = await bm25Retriever.rankSessions('quokka project', [
    s('d1', 'unrelated chatter'),
    s('d1', 'unrelated chatter'),
    s('answer_a', 'the quokka project shipped'),
  ])
  assert.deepEqual(
    ranked.map((r) => r.session_id),
    ['answer_a', 'd1', 'd1'],
  )
})
