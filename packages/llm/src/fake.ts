// SPDX-License-Identifier: Apache-2.0
// FakeGateway (docs/concepts/testing.mdx LLM policy): deterministic, offline, instant.
// Embeddings are seeded-hash unit vectors — same text always maps to the
// same vector, similar texts do NOT map to similar vectors (this is a
// wiring fake, not a semantic model; semantic quality is the eval harness's
// job, never a unit test's).
import {
  type CompleteOptions,
  type CompletionResult,
  type DecideAnswer,
  type DecideQuestion,
  type DecideRequest,
  type DecideResult,
  EMBEDDING_DIMENSIONS,
  type EmbedResult,
  type Gateway,
} from './types.js'

/** Model name the fake reports — matches the real default so cost-rate lookups
 * resolve in tests (the fake is a wiring stand-in, not a cost source). */
export const FAKE_EMBEDDING_MODEL = 'text-embedding-3-large'

/** Deterministic, content-free token estimate for the fake: a non-zero count so
 * cost-tracking tests see real input tokens, derived from text length only
 * (~4 chars/token heuristic, floored at 1 per non-empty text). */
function fakeTokenCount(texts: readonly string[]): number {
  return texts.reduce((sum, t) => sum + Math.max(1, Math.ceil(t.length / 4)), 0)
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Deterministic PRNG (mulberry32) seeded from the text. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function fakeEmbedding(text: string, dims: number = EMBEDDING_DIMENSIONS): number[] {
  const rand = mulberry32(fnv1a(text))
  const v = Array.from({ length: dims }, () => rand() * 2 - 1)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

/** Model name the fake reports for completions — matches the real default so
 * cost-rate lookups resolve in tests. */
export const FAKE_COMPLETION_MODEL = 'gpt-4o-mini'

/** Model name the fake reports for decide(). Deliberately not a real model: no
 * judgment price is registered for it, so a priced-path test cannot pass by
 * accident on the fake. */
export const FAKE_DECIDE_MODEL = 'fake-judgment'

/**
 * The probability (and confidence) the fake answers with when no canned answer
 * is registered. LOW on purpose: a test that forgets to register an answer must
 * see "not confident", so any threshold-gated write stays unwritten (fail closed).
 */
export const FAKE_DEFAULT_PROBABILITY = 0.05

export interface FakeGatewayOptions {
  /** Canned completion per operation key; default echoes the operation. */
  completions?: Record<string, string>
  /** Canned decide() answers: operation → question name → answer. Any question
   * without one gets the fail-closed default ({@link FAKE_DEFAULT_PROBABILITY}). */
  decisions?: Record<string, Record<string, DecideAnswer>>
}

/** The fail-closed answer for a question with no canned answer. */
function defaultAnswer(question: DecideQuestion): DecideAnswer {
  const p = FAKE_DEFAULT_PROBABILITY
  if (question.type === 'noul') return { type: 'noul', probability: p }
  if (question.type === 'choice') {
    const choice = Object.keys(question.criteria)[0] ?? ''
    return { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } }
  }
  return { type: 'score', score: 0, confidence: p, probabilities: { '0': p } }
}

export function createFakeGateway(opts: FakeGatewayOptions = {}): Gateway & {
  calls: {
    embed: Array<{ texts: readonly string[]; operation: string }>
    complete: Array<{ prompt: string; operation: string; options?: CompleteOptions | undefined }>
    decide: Array<{ request: DecideRequest; operation: string }>
  }
} {
  const calls = {
    embed: [] as Array<{ texts: readonly string[]; operation: string }>,
    complete: [] as Array<{
      prompt: string
      operation: string
      options?: CompleteOptions | undefined
    }>,
    decide: [] as Array<{ request: DecideRequest; operation: string }>,
  }
  return {
    calls,
    embed(texts, operation): Promise<EmbedResult> {
      calls.embed.push({ texts, operation })
      return Promise.resolve({
        embeddings: texts.map((t) => fakeEmbedding(t)),
        usage: { inputTokens: fakeTokenCount(texts) },
        model: FAKE_EMBEDDING_MODEL,
      })
    },
    complete(prompt, operation, options): Promise<CompletionResult> {
      calls.complete.push({ prompt, operation, options })
      const text = opts.completions?.[operation] ?? `fake:${operation}`
      return Promise.resolve({
        text,
        usage: {
          inputTokens: fakeTokenCount([prompt]),
          outputTokens: fakeTokenCount([text]),
        },
        model: FAKE_COMPLETION_MODEL,
      })
    },
    decide(request, operation): Promise<DecideResult> {
      calls.decide.push({ request, operation })
      const canned = opts.decisions?.[operation] ?? {}
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([name, q]) => [
          name,
          canned[name] ?? defaultAnswer(q),
        ]),
      )
      return Promise.resolve({
        answers,
        usage: { inputTokens: fakeTokenCount([request.state]), outputTokens: 0 },
        model: FAKE_DECIDE_MODEL,
      })
    },
  }
}
