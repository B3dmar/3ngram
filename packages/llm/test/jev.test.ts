// SPDX-License-Identifier: Apache-2.0
// Jev decide() contract tests (issue #225). fetch is stubbed — no network. The
// fixture is a CONTRACT fixture built from @typesafe-ai/sdk@0.7.0's published
// types, not a recorded response (see its _meta). Every error path must carry
// counts/kinds only: never state, instructions, labels, the key or the body.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJevGateway, InvalidDecideError, MAX_DECIDE_STATE_CHARS } from '../src/jev.js'
import { GatewayRequestError, NotImplementedError } from '../src/openai.js'
import type { DecideRequest } from '../src/types.js'

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/jev-systemone.json', import.meta.url), 'utf8'),
) as { request: DecideRequest; response: Record<string, unknown> }

const CONFIG = { baseUrl: 'https://jev.test/', apiKey: 'k-secret', model: 'jev-pinned-1' }
const SECRET_STATE = 'tenant-secret-text'

function stub(body: unknown, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const mock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(text, { status })),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The fixture response, loosely typed so a test can corrupt any part of it. */
type WireAnswer = Record<string, unknown> & { probabilities: Record<string, unknown> }
type Wire = { answers: Record<string, WireAnswer>; model?: unknown; usage?: unknown }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createJevGateway decide()', () => {
  it('posts the pinned model, Bearer auth and wire questions to /v1/systemone', async () => {
    const mock = stub(fixture.response)
    await createJevGateway(CONFIG).decide(fixture.request, 'session.closer.decide')
    const [url, init] = mock.mock.calls[0] ?? []
    expect(url).toBe('https://jev.test/v1/systemone')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer k-secret')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ ...fixture.request, model: 'jev-pinned-1' })
  })

  it('maps the contract response to typed answers, usage and model', async () => {
    stub(fixture.response)
    const result = await createJevGateway(CONFIG).decide(fixture.request, 'op')
    expect(result.model).toBe('jev-contract-fixture')
    expect(result.answers.c1).toEqual({ type: 'noul', probability: 0.91 })
    expect(result.answers.kind).toMatchObject({ type: 'choice', choice: 'code', confidence: 0.8 })
    expect(result.answers.effort).toMatchObject({ type: 'score', score: 1.2, confidence: 0.7 })
    // Output is free; a null output count reads 0, not "unpriced".
    expect(result.usage).toEqual({ inputTokens: 212, outputTokens: 0 })
  })

  it('leaves usage absent (unpriced, never $0) when the input count is null', async () => {
    const response = clone(fixture.response)
    response.usage = { input_tokens: null, output_tokens: null }
    stub(response)
    const result = await createJevGateway(CONFIG).decide(fixture.request, 'op')
    expect(result.usage).toBeUndefined()
  })

  it.each([
    ['a missing answer', (r: Wire) => delete r.answers.c1],
    ['an unasked answer', (r: Wire) => (r.answers.extra = { type: 'noul', noul: 0.5 })],
    ['a type mismatch', (r: Wire) => (r.answers.c1 = { type: 'score', score: 1 })],
    ['a probability above 1', (r: Wire) => (r.answers.c1.noul = 1.5)],
    ['a NaN-like probability', (r: Wire) => (r.answers.c1.noul = 'high')],
    ['an unknown choice label', (r: Wire) => (r.answers.kind.choice = 'nope')],
    ['an unknown probability label', (r: Wire) => (r.answers.kind.probabilities.zzz = 0.1)],
    ['a score past the rubric', (r: Wire) => (r.answers.effort.score = 3)],
    ['a missing model', (r: Wire) => delete r.model],
  ])('rejects %s without echoing content', async (_name, mutate) => {
    const response = clone(fixture.response) as unknown as Wire
    mutate(response)
    stub(response)
    const error = await rejection(createJevGateway(CONFIG).decide(fixture.request, 'op'))
    expect(error).toBeInstanceOf(InvalidDecideError)
    expect(error.message).not.toMatch(/retry fix|Code change|k-secret|code|nope/)
  })

  it('wraps a non-2xx as GatewayRequestError carrying the status only', async () => {
    stub({ error: `echo ${SECRET_STATE}` }, 429)
    const error = await rejection(createJevGateway(CONFIG).decide(fixture.request, 'op'))
    expect(error).toBeInstanceOf(GatewayRequestError)
    expect((error as GatewayRequestError).status).toBe(429)
    expect(error.message).not.toContain(SECRET_STATE)
  })

  it('reports a non-JSON body by length, never its text', async () => {
    stub(`<html>${SECRET_STATE}</html>`)
    const error = await rejection(createJevGateway(CONFIG).decide(fixture.request, 'op'))
    expect(error).toBeInstanceOf(InvalidDecideError)
    expect(error.message).not.toContain(SECRET_STATE)
  })

  it('makes exactly one attempt (no retries) on failure', async () => {
    const mock = stub({}, 503)
    await rejection(createJevGateway(CONFIG).decide(fixture.request, 'op'))
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('rejects out-of-bounds requests before any network call', async () => {
    const mock = stub(fixture.response)
    const gw = createJevGateway(CONFIG)
    const tooLong = { ...fixture.request, state: 'x'.repeat(MAX_DECIDE_STATE_CHARS + 1) }
    expect(await rejection(gw.decide(tooLong, 'op'))).toBeInstanceOf(InvalidDecideError)
    expect(await rejection(gw.decide({ state: 's', questions: {} }, 'op'))).toBeInstanceOf(
      InvalidDecideError,
    )
    const badScore: DecideRequest = {
      state: 's',
      questions: { q: { type: 'score', instructions: 'i', criteria: ['only one'] } },
    }
    expect(await rejection(gw.decide(badScore, 'op'))).toBeInstanceOf(InvalidDecideError)
    expect(mock).not.toHaveBeenCalled()
  })

  it('aborts a call that outlives the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )
    const gw = createJevGateway({ ...CONFIG, timeoutMs: 5 })
    expect((await rejection(gw.decide(fixture.request, 'op'))).message).toBe('aborted')
  })

  it('does not implement embed or complete', async () => {
    const gw = createJevGateway(CONFIG)
    expect(await rejection(gw.embed(['x'], 'op'))).toBeInstanceOf(NotImplementedError)
    expect(await rejection(gw.complete('x', 'op'))).toBeInstanceOf(NotImplementedError)
  })
})
