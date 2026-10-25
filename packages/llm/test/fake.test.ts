// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { createFakeGateway, FAKE_DEFAULT_PROBABILITY, fakeEmbedding } from '../src/fake.js'

describe('FakeGateway', () => {
  it('embeddings are deterministic and unit-norm', () => {
    const a1 = fakeEmbedding('hello')
    const a2 = fakeEmbedding('hello')
    expect(a1).toEqual(a2)
    expect(a1).toHaveLength(1536)
    const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 6)
  })

  it('different texts produce different vectors', () => {
    expect(fakeEmbedding('a')).not.toEqual(fakeEmbedding('b'))
  })

  it('records calls and serves canned completions per operation', async () => {
    const gw = createFakeGateway({ completions: { classify: 'note' } })
    const result = await gw.embed(['x', 'y'], 'memory_embed')
    expect(result.embeddings).toHaveLength(2)
    // Cost tracking: the fake reports a non-zero, deterministic
    // token count and the real default model so cost-rate lookups resolve.
    expect(result.usage.inputTokens).toBeGreaterThan(0)
    expect(result.model).toBe('text-embedding-3-large')
    const out = await gw.complete('p', 'classify')
    expect(out.text).toBe('note')
    // A completion bills BOTH directions, so the fake reports the pair — the
    // closer prices its `llm_usage` row from it.
    expect(out.usage.inputTokens).toBeGreaterThan(0)
    expect(out.usage.outputTokens).toBeGreaterThan(0)
    expect(out.model).toBe('gpt-4o-mini')
    expect((await gw.complete('p', 'other')).text).toBe('fake:other')
    expect(gw.calls.embed[0]?.operation).toBe('memory_embed')
    expect(gw.calls.complete).toHaveLength(2)
  })

  it('records decide calls and fails closed with a low default probability', async () => {
    const gw = createFakeGateway({
      decisions: { 'session.closer.decide': { done: { type: 'noul', probability: 0.97 } } },
    })
    const result = await gw.decide(
      {
        state: 's',
        questions: {
          done: { type: 'noul', instructions: 'i' },
          other: { type: 'noul', instructions: 'i' },
          pick: { type: 'choice', instructions: 'i', criteria: { a: null, b: null } },
        },
      },
      'session.closer.decide',
    )
    expect(result.answers.done).toEqual({ type: 'noul', probability: 0.97 })
    // Unregistered answers are LOW, so a threshold-gated write stays unwritten.
    expect(result.answers.other).toEqual({ type: 'noul', probability: FAKE_DEFAULT_PROBABILITY })
    expect(result.answers.pick).toMatchObject({ choice: 'a', confidence: FAKE_DEFAULT_PROBABILITY })
    expect(gw.calls.decide).toHaveLength(1)
    expect(gw.calls.decide[0]?.operation).toBe('session.closer.decide')
  })
})
