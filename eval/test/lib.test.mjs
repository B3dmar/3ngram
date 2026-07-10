// SPDX-License-Identifier: Apache-2.0
// Offline unit tests for the shared ranker/normalizer (#37).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeQuestions, parseFlag, rankSessions, scoreQuestion } from '../src/lib.mjs'

const SESSIONS = [
  { session_id: 's1', turns: [{ role: 'user', content: 'I picked PostgreSQL for the project.' }] },
  { session_id: 's2', turns: [{ role: 'user', content: 'The weather is nice today.' }] },
]

test('parseFlag reads the space-separated form (--name value)', () => {
  assert.equal(parseFlag(['--retriever', 'real'], 'retriever', 'lexical'), 'real')
  assert.equal(parseFlag(['--model', 'openai-large-1536'], 'model', 'def'), 'openai-large-1536')
})

test('parseFlag reads the equals form (--name=value) — the #122 fix', () => {
  assert.equal(parseFlag(['--retriever=real'], 'retriever', 'lexical'), 'real')
  assert.equal(parseFlag(['--model=openai-large-1536'], 'model', 'def'), 'openai-large-1536')
})

test('parseFlag: equals and space forms both select the same value', () => {
  const fromEquals = parseFlag(['--retriever=real'], 'retriever', 'lexical')
  const fromSpace = parseFlag(['--retriever', 'real'], 'retriever', 'lexical')
  assert.equal(fromEquals, 'real')
  assert.equal(fromSpace, fromEquals)
})

test('parseFlag returns the fallback when the flag is absent', () => {
  assert.equal(parseFlag(['--json'], 'retriever', 'lexical'), 'lexical')
  assert.equal(parseFlag([], 'retriever', undefined), undefined)
})

test('parseFlag: equals form wins over a later space form, ignores the next flag', () => {
  assert.equal(parseFlag(['--retriever=real', '--retriever', 'lexical'], 'retriever', 'd'), 'real')
  // a bare flag followed by another flag is not consumed as a value
  assert.equal(parseFlag(['--retriever', '--json'], 'retriever', 'lexical'), 'lexical')
})

test('parseFlag: an explicit blank equals value is empty string, not the fallback', () => {
  assert.equal(parseFlag(['--retriever='], 'retriever', 'lexical'), '')
})

test('rankSessions ranks the overlapping session first, ties by id', () => {
  const ranked = rankSessions('Which database did I pick for the project?', SESSIONS)
  assert.equal(ranked[0].session_id, 's1')
  assert.ok(ranked[0].score >= ranked[1].score)
})

test('scoreQuestion reports recall hit and reciprocal rank', () => {
  const q = {
    question: 'Which database did I pick for the project?',
    answer_session_ids: ['s1'],
    haystack_sessions: SESSIONS,
  }
  const { hit, rr } = scoreQuestion(q, 5)
  assert.equal(hit, true)
  assert.equal(rr, 1)
})

test('normalizeQuestions accepts the official array shape', () => {
  const official = [
    {
      question_id: 'q1',
      question: 'x',
      answer_session_ids: ['a'],
      haystack_session_ids: ['a', 'b'],
      haystack_sessions: [[{ role: 'user', content: 'one' }], [{ role: 'user', content: 'two' }]],
    },
  ]
  const [q] = normalizeQuestions(official)
  assert.equal(q.haystack_sessions[0].session_id, 'a')
  assert.deepEqual(q.haystack_sessions[0].turns, [{ role: 'user', content: 'one' }])
})

test('normalizeQuestions passes through the subset shape', () => {
  const [q] = normalizeQuestions({
    questions: [{ question: 'x', answer_session_ids: ['s1'], haystack_sessions: SESSIONS }],
  })
  assert.equal(q.haystack_sessions[0].session_id, 's1')
})
