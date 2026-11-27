// SPDX-License-Identifier: Apache-2.0
// LongMemEval QA (#535): upstream's reader and judge prompts byte for byte,
// Batch request and output handling, and upstream's scoring.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  JUDGE_MAX_TOKENS,
  judgeLabel,
  judgePrompt,
  judgeRequest,
  parseBatchOutput,
  pyJsonDumps,
  qaScores,
  READER_MAX_TOKENS,
  readerPrompt,
  readerRequest,
  round4,
  UPSTREAM_JUDGE,
} from '../src/qa.mjs'

const parity = JSON.parse(
  readFileSync(new URL('../fixtures/qa-parity.json', import.meta.url), 'utf8'),
)

for (const { entry, hypothesis, direct, cot, judge } of parity.cases) {
  test(`prompts match upstream: ${entry.question_id}`, () => {
    assert.equal(readerPrompt(entry), direct, 'direct reader')
    assert.equal(readerPrompt(entry, { cot: true }), cot, 'step-by-step reader')
    assert.equal(judgePrompt(entry, hypothesis), judge, 'judge')
  })
}

test('pyJsonDumps writes what Python json.dumps writes', () => {
  assert.equal(pyJsonDumps({ a: [true, null, 3], b: 'x' }), '{"a": [true, null, 3], "b": "x"}')
  assert.equal(
    pyJsonDumps('é 🦘 \u007f \u0001 "\\'),
    '"\\u00e9 \\ud83e\\udd98 \\u007f \\u0001 \\"\\\\"',
  )
  assert.equal(pyJsonDumps([]), '[]')
  assert.equal(pyJsonDumps({}), '{}')
  assert.throws(() => pyJsonDumps(0.5), /non-integer/)
})

test('a history beyond the untruncated budget is refused, not silently cut', () => {
  const huge = {
    ...parity.cases[0].entry,
    haystack_sessions: [[{ role: 'user', content: 'x'.repeat(127000) }]],
  }
  assert.throws(() => readerPrompt(huge), /may need truncation/)
})

test('requests are /v1/chat/completions lines with upstream settings', () => {
  const { entry, hypothesis } = parity.cases[0]
  const reader = readerRequest(entry, { model: 'gpt-4o-2024-08-06', cot: true })
  assert.equal(reader.custom_id, entry.question_id)
  assert.equal(reader.url, '/v1/chat/completions')
  assert.deepEqual(
    { ...reader.body, messages: reader.body.messages.length },
    {
      model: 'gpt-4o-2024-08-06',
      messages: 1,
      n: 1,
      temperature: 0,
      max_tokens: READER_MAX_TOKENS.cot,
    },
  )
  assert.equal(readerRequest(entry, { model: 'm' }).body.max_tokens, READER_MAX_TOKENS.direct)
  assert.equal(READER_MAX_TOKENS.direct, 800, 'upstream caps direct answers at 800 too')
  assert.equal(judgeRequest(entry, hypothesis, { model: 'm' }).body.max_tokens, JUDGE_MAX_TOKENS)
})

test('a Batch output file parses into answers and errors by custom_id', () => {
  const ok = (id, content) =>
    JSON.stringify({
      custom_id: id,
      response: {
        status_code: 200,
        body: { choices: [{ message: { content } }], usage: { prompt_tokens: 9 } },
      },
      error: null,
    })
  const failed = JSON.stringify({
    custom_id: 'q3',
    response: null,
    error: { code: 'rate_limited' },
  })
  const refused = JSON.stringify({
    custom_id: 'q4',
    response: {
      status_code: 200,
      body: { choices: [{ message: { content: null, refusal: 'I cannot help' } }] },
    },
    error: null,
  })
  const results = parseBatchOutput(
    `${ok('q1', '  Yes.  ')}\n${ok('q2', 'no')}\n${failed}\n${refused}\n`,
  )
  assert.deepEqual(
    results.get('q4'),
    { error: 'refusal' },
    'null content is one error, not a crash',
  )
  assert.deepEqual(results.get('q1'), { content: 'Yes.', usage: { prompt_tokens: 9 } })
  assert.deepEqual(results.get('q3'), { error: 'rate_limited' })
  assert.equal(judgeLabel(results.get('q1').content), true, '"yes" anywhere, any case')
  assert.equal(judgeLabel(results.get('q2').content), false)
})

test('scores as print_qa_metrics.py: overall, task-averaged, abstention in its own type too', () => {
  const entries = parity.cases.map((c) => c.entry)
  const labels = new Map(
    entries.map((e) => [e.question_id, e.question_type !== 'temporal-reasoning']),
  )
  const scores = qaScores(entries, labels, { judge: UPSTREAM_JUDGE })
  assert.equal(scores.upstream_judge, true)
  assert.equal(qaScores(entries, labels, { judge: 'gpt-6-luna' }).upstream_judge, false)
  assert.throws(() => qaScores(entries, labels, {}), /needs the judge model/)
  assert.equal(scores.judged, 7)
  assert.equal(scores.overall_accuracy, +(6 / 7).toFixed(4))
  assert.deepEqual(scores.by_type['multi-session'], { n: 2, accuracy: 1 })
  assert.deepEqual(scores.abstention, { n: 1, accuracy: 1 })
  // Six types, temporal-reasoning at 0: the task average is 5/6.
  assert.equal(scores.task_averaged_accuracy, +(5 / 6).toFixed(4))
})

test('accuracies round as numpy does: half to even on the scaled value', () => {
  assert.equal(round4(3 / 96), 0.0312, 'an exact tie goes to the even digit')
  assert.equal(round4(5 / 96), 0.0521)
  assert.equal(round4(6 / 7), 0.8571)
  assert.equal(round4(1), 1)
})
