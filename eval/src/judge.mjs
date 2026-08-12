// SPDX-License-Identifier: Apache-2.0
// --judge slice: model-judged answer-synthesis over the golden set.
//
// ADVISORY ONLY: this never gates a PR or the blocking golden-set
// gate (run.mjs + floors.json are untouched). For each question it retrieves
// sessions with the swappable lexical ranker (lib.mjs rankSessions, the
// Phase 1B #77 stand-in), synthesizes an answer from the top-k retrieved
// context, then asks an LLM judge whether the answer matches the gold answer.
//
// Two gateways, one Gateway interface (operation-keyed
// complete(prompt, operation) — mirrors packages/llm):
//   - createFakeJudgeGateway(): deterministic, offline, zero-network. This is
//     the PR-CI / unit-test path. It mirrors the packages/llm FakeGateway
//     contract (no live model, no lockfile/build coupling for the eval pkg).
//   - createGatewayFromEnv(): OpenAI-compatible HTTP gateway pointed at
//     LLM_GATEWAY_URL (self-host "bring your own gateway"), authed
//     with LLM_GATEWAY_API_KEY. Returns null when the secret is absent so the
//     nightly lane SKIPS live calls instead of failing — never a silent
//     network dependency in the default path.

import { normalizeQuestions, rankSessions, sessionText } from './lib.mjs'

export const SYNTH_OPERATION = 'longmemeval-answer-synthesis'
export const JUDGE_OPERATION = 'longmemeval-answer-judge'

/** Env var carrying the live-model secret. Skip-when-absent gates on this. */
export const GATEWAY_API_KEY_ENV = 'LLM_GATEWAY_API_KEY'

/** Build the answer-synthesis prompt from the top-k retrieved sessions. */
export function buildSynthesisPrompt(question, sessions) {
  const context = sessions.map((s, i) => `[session ${i + 1}]\n${sessionText(s)}`).join('\n\n')
  return [
    'You are answering a question using only the retrieved conversation context.',
    "If the context does not contain the answer, reply exactly: I don't know.",
    '',
    `Question: ${question}`,
    '',
    'Context:',
    context,
    '',
    'Answer concisely:',
  ].join('\n')
}

/** Build the judge prompt comparing a synthesized answer to the gold answer. */
export function buildJudgePrompt(question, gold, candidate) {
  return [
    'You are grading whether a candidate answer is correct.',
    'Reply with exactly "yes" if the candidate matches the reference answer in',
    'meaning, otherwise reply exactly "no".',
    '',
    `Question: ${question}`,
    `Reference answer: ${gold}`,
    `Candidate answer: ${candidate}`,
    '',
    'Correct (yes/no):',
  ].join('\n')
}

/** Parse a judge completion into a boolean verdict. */
export function parseVerdict(completion) {
  return /^\s*yes\b/i.test(completion ?? '')
}

/**
 * Deterministic offline judge gateway. Mirrors the packages/llm FakeGateway
 * Gateway interface (embed/complete keyed by operation). Synthesis echoes the
 * gold answer carried inline; the judge does a normalized substring match. No
 * network, no model — semantic quality is the live nightly lane's job.
 *
 * `golds` maps question text -> gold answer so the fake can synthesize a
 * plausible-but-deterministic answer without a real model.
 */
export function createFakeJudgeGateway(golds = new Map()) {
  const calls = { embed: [], complete: [] }
  const norm = (s) =>
    (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim()
  return {
    calls,
    embed(texts, operation) {
      calls.embed.push({ texts, operation })
      return Promise.resolve(texts.map(() => []))
    },
    complete(prompt, operation) {
      calls.complete.push({ prompt, operation })
      if (operation === SYNTH_OPERATION) {
        for (const [question, gold] of golds) {
          if (prompt.includes(question)) return Promise.resolve(gold)
        }
        return Promise.resolve("I don't know.")
      }
      // Judge: extract reference + candidate lines, normalized substring match.
      const ref = norm(/Reference answer: (.*)/.exec(prompt)?.[1])
      const cand = norm(/Candidate answer: (.*)/.exec(prompt)?.[1])
      const match = ref.length > 0 && (cand.includes(ref) || ref.includes(cand))
      return Promise.resolve(match ? 'yes' : 'no')
    },
  }
}

/**
 * OpenAI-compatible HTTP gateway. Returns null when the secret env
 * var is absent — the caller treats null as "skip the live lane".
 */
export function createGatewayFromEnv(env = process.env) {
  const apiKey = env[GATEWAY_API_KEY_ENV]
  if (!apiKey) return null
  // `||` (not `??`) for BOTH: CI exports LLM_GATEWAY_URL from an optional secret
  // and LLM_JUDGE_MODEL from an optional Actions variable, so either arrives as ''
  // when unset — treat empty string as unset. With `??` the model line shipped that
  // empty string as the requested model, the same #122 class of bug
  // tool-selection-model.mjs already documents at its own createGatewayFromEnv.
  const baseUrl = (env.LLM_GATEWAY_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = env.LLM_JUDGE_MODEL || 'gpt-4o-mini'
  return {
    embed() {
      return Promise.reject(new Error('embed not used by --judge'))
    },
    async complete(prompt, _operation) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`gateway error: ${res.status} ${res.statusText}`)
      const data = await res.json()
      return data.choices?.[0]?.message?.content ?? ''
    },
  }
}

/**
 * Run the model-judged answer-synthesis slice over a dataset with an injected
 * gateway. Returns an advisory result object (never throws on a wrong answer).
 */
export async function runJudge(dataset, gateway, { k = 5, fixture = 'unknown' } = {}) {
  const questions = normalizeQuestions(dataset)
  let correct = 0
  const perType = {}
  for (const q of questions) {
    const ranked = rankSessions(q.question, q.haystack_sessions)
    const topIds = new Set(ranked.slice(0, k).map((r) => r.session_id))
    const retrieved = q.haystack_sessions.filter((s) => topIds.has(s.session_id))
    const synthesized = await gateway.complete(
      buildSynthesisPrompt(q.question, retrieved),
      SYNTH_OPERATION,
    )
    const verdict = await gateway.complete(
      buildJudgePrompt(q.question, q.answer, synthesized),
      JUDGE_OPERATION,
    )
    const isCorrect = parseVerdict(verdict)
    if (isCorrect) correct++
    perType[q.question_type] ??= { n: 0, correct: 0 }
    perType[q.question_type].n++
    if (isCorrect) perType[q.question_type].correct++
  }
  const n = questions.length || 1
  return {
    harness: 'longmemeval-judge',
    tier: 'advisory',
    fixture,
    k,
    questions: questions.length,
    metrics: { answer_accuracy: +(correct / n).toFixed(4) },
    by_question_type: Object.fromEntries(
      Object.entries(perType).map(([t, v]) => [t, +(v.correct / v.n).toFixed(4)]),
    ),
  }
}
