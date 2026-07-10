// SPDX-License-Identifier: Apache-2.0
// Offline unit tests for the --judge plumbing (#37). No network, no live model:
// the fake gateway mirrors the packages/llm Gateway interface.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildJudgePrompt,
  buildSynthesisPrompt,
  createFakeJudgeGateway,
  createGatewayFromEnv,
  GATEWAY_API_KEY_ENV,
  JUDGE_OPERATION,
  parseVerdict,
  runJudge,
  SYNTH_OPERATION,
} from '../src/judge.mjs'

const DATASET = {
  questions: [
    {
      question_id: 'q1',
      question_type: 'single-session-user',
      question: 'Which database did I pick?',
      answer: 'PostgreSQL',
      answer_session_ids: ['s1'],
      haystack_sessions: [
        { session_id: 's1', turns: [{ role: 'user', content: 'I picked PostgreSQL.' }] },
        { session_id: 's2', turns: [{ role: 'user', content: 'Unrelated chatter.' }] },
      ],
    },
    {
      question_id: 'q2',
      question_type: 'multi-session',
      question: 'What city did I move to?',
      answer: 'Berlin',
      answer_session_ids: ['s3'],
      haystack_sessions: [
        { session_id: 's3', turns: [{ role: 'user', content: 'I moved to Berlin.' }] },
      ],
    },
  ],
}

test('parseVerdict reads yes/no robustly', () => {
  assert.equal(parseVerdict('yes'), true)
  assert.equal(parseVerdict('  Yes, correct'), true)
  assert.equal(parseVerdict('no'), false)
  assert.equal(parseVerdict(''), false)
  assert.equal(parseVerdict(undefined), false)
})

test('prompts embed question, gold, candidate and context', () => {
  const synth = buildSynthesisPrompt('Q?', [
    { session_id: 's1', turns: [{ role: 'user', content: 'ctx' }] },
  ])
  assert.match(synth, /Question: Q\?/)
  assert.match(synth, /ctx/)
  const judge = buildJudgePrompt('Q?', 'gold', 'cand')
  assert.match(judge, /Reference answer: gold/)
  assert.match(judge, /Candidate answer: cand/)
})

test('fake gateway scores correct answers and is operation-keyed', async () => {
  const golds = new Map(DATASET.questions.map((q) => [q.question, q.answer]))
  const gateway = createFakeJudgeGateway(golds)
  const result = await runJudge(DATASET, gateway, { k: 5, fixture: 'unit' })
  assert.equal(result.harness, 'longmemeval-judge')
  assert.equal(result.tier, 'advisory')
  assert.equal(result.questions, 2)
  assert.equal(result.metrics.answer_accuracy, 1)
  assert.equal(result.by_question_type['single-session-user'], 1)
  // Two operations per question: synthesis + judge.
  const ops = gateway.calls.complete.map((c) => c.operation)
  assert.equal(ops.filter((o) => o === SYNTH_OPERATION).length, 2)
  assert.equal(ops.filter((o) => o === JUDGE_OPERATION).length, 2)
})

test('fake gateway abstains when gold is unknown (no false positive)', async () => {
  const gateway = createFakeJudgeGateway(new Map()) // no golds -> "I don't know."
  const result = await runJudge(DATASET, gateway, { k: 5, fixture: 'unit' })
  assert.equal(result.metrics.answer_accuracy, 0)
})

test('createGatewayFromEnv skips when the secret is absent', () => {
  const env = {}
  assert.equal(createGatewayFromEnv(env), null)
})

test('createGatewayFromEnv returns a gateway when the secret is set', () => {
  const env = { [GATEWAY_API_KEY_ENV]: 'sk-test', LLM_GATEWAY_URL: 'https://gw.example/v1' }
  const gateway = createGatewayFromEnv(env)
  assert.ok(gateway)
  assert.equal(typeof gateway.complete, 'function')
})
