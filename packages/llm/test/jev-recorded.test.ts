// SPDX-License-Identifier: Apache-2.0
// Jev decide() against a RECORDED live response (issue #225). The fixture holds
// the verbatim body of one POST /v1/systemone call made on 2026-10-25 with the
// synthetic contract-fixture request and the pinned model (see its _meta). These
// tests run #349's wire guards on it, and pin that the live answer shapes match
// the SDK-derived contract fixture key for key, so a vendor-side shape change
// shows up here as a diff instead of as a closer outage. fetch is stubbed.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJevGateway, isFloatingModelAlias, parseDecideResponse } from '../src/jev.js'
import { GatewayRequestError } from '../src/openai.js'
import type { DecideRequest } from '../src/types.js'

type Wire = { answers: Record<string, Record<string, unknown>>; usage: Record<string, unknown> }
type Fixture = { request: DecideRequest; response: Record<string, unknown> }

function load(name: string): Fixture & { _meta: Record<string, unknown> } {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'))
}

const recorded = load('jev-systemone-recorded.json')
const derived = load('jev-systemone.json')
const PINNED = recorded._meta.requestedModel as string

function stub(body: unknown, status = 200) {
  const mock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('recorded Jev /v1/systemone response', () => {
  it('was recorded against a pinned version, not an alias', () => {
    expect(PINNED).toBe('jev-1.14.0')
    expect(isFloatingModelAlias(PINNED)).toBe(false)
    expect(recorded.response.model).toBe(PINNED)
  })

  it('passes the wire guards and maps to typed answers, usage and model', () => {
    const result = parseDecideResponse(recorded.request, recorded.response)
    expect(result.model).toBe('jev-1.14.0')
    expect(result.usage).toEqual({ inputTokens: 433, outputTokens: 70 })
    expect(result.answers.c1).toEqual({ type: 'noul', probability: 0.75 })
    expect(result.answers.kind).toEqual({
      type: 'choice',
      choice: 'code',
      confidence: 0.45,
      probabilities: { code: 0.63, docs: 0.17, other: 0.2 },
    })
    expect(result.answers.effort).toEqual({
      type: 'score',
      score: 0.99,
      confidence: 0.98,
      probabilities: { '0': 0.01, '1': 0.99, '2': 0 },
    })
  })

  it('round-trips through the gateway with the pin on the wire', async () => {
    const mock = stub(recorded.response)
    const gateway = createJevGateway({ apiKey: 'k-secret', model: PINNED })
    const result = await gateway.decide(recorded.request, 'session.closer.decide')
    expect(result.model).toBe(PINNED)
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(JSON.parse(init.body as string)).toEqual({ ...recorded.request, model: PINNED })
  })

  it('has the same answer and usage keys as the SDK-derived contract fixture', () => {
    // Same synthetic request in both fixtures, so the shapes are comparable 1:1.
    expect(recorded.request).toEqual(derived.request)
    const live = recorded.response as unknown as Wire
    const contract = derived.response as unknown as Wire
    expect(Object.keys(live).sort()).toEqual(Object.keys(contract).sort())
    expect(Object.keys(live.usage).sort()).toEqual(Object.keys(contract.usage).sort())
    for (const name of Object.keys(contract.answers)) {
      expect(Object.keys(live.answers[name] ?? {}).sort()).toEqual(
        Object.keys(contract.answers[name] ?? {}).sort(),
      )
    }
  })

  it('surfaces the recorded unknown-model 400 as a status-only GatewayRequestError', async () => {
    stub(recorded._meta.unknownModelBody, recorded._meta.unknownModelStatus as number)
    const gateway = createJevGateway({ apiKey: 'k-secret', model: 'jev-0.0.1' })
    const error = await gateway.decide(recorded.request, 'op').catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(GatewayRequestError)
    expect((error as GatewayRequestError).status).toBe(400)
    expect(error.message).not.toMatch(/Unknown model|api_usage_error|k-secret/)
  })
})
