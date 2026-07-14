// SPDX-License-Identifier: Apache-2.0
// OpenAI-compatible gateway embed() VALIDATION tests. A gateway that returns the
// wrong row count or a wrong-width vector would poison every later cosine search
// if stored silently, so embed() fails loud at the boundary. The fetch is stubbed
// (no network) to return malformed payloads; the error message must carry
// counts/lengths ONLY (hard rule 6: no request texts, no vector contents).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenAIGateway,
  GatewayRequestError,
  InvalidEmbeddingResponseError,
} from '../src/openai.js'
import { EMBEDDING_DIMENSIONS } from '../src/types.js'

const CONFIG = { baseUrl: 'https://gw.test/v1', apiKey: 'sk-test' }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(jsonResponse(body))),
  )
}

function row(length: number) {
  return { embedding: Array.from({ length }, () => 0) }
}

afterEach(() => vi.unstubAllGlobals())

describe('createOpenAIGateway embed() response validation', () => {
  it('strips every trailing slash without changing the request path', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ data: [row(EMBEDDING_DIMENSIONS)] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const gw = createOpenAIGateway({ ...CONFIG, baseUrl: `${CONFIG.baseUrl}///` })

    await gw.embed(['hello'], 'memory_embed')

    expect(fetchMock).toHaveBeenCalledWith(`${CONFIG.baseUrl}/embeddings`, expect.any(Object))
  })

  it('accepts a well-formed response (right count, right dimensions)', async () => {
    stubFetch({ data: [row(EMBEDDING_DIMENSIONS), row(EMBEDDING_DIMENSIONS)] })
    const gw = createOpenAIGateway(CONFIG)
    const result = await gw.embed(['a', 'b'], 'memory_embed')
    expect(result.embeddings).toHaveLength(2)
    expect(result.embeddings[0]).toHaveLength(EMBEDDING_DIMENSIONS)
  })

  it('surfaces token usage and model for cost tracking (counts only, no content)', async () => {
    stubFetch({
      data: [row(EMBEDDING_DIMENSIONS)],
      usage: { prompt_tokens: 42 },
      model: 'text-embedding-3-large',
    })
    const gw = createOpenAIGateway(CONFIG)
    const result = await gw.embed(['hello'], 'memory_embed')
    expect(result.usage.inputTokens).toBe(42)
    expect(result.model).toBe('text-embedding-3-large')
  })

  it('defaults usage to 0 and falls back to the requested model when the gateway omits them', async () => {
    stubFetch({ data: [row(EMBEDDING_DIMENSIONS)] })
    const gw = createOpenAIGateway(CONFIG)
    const result = await gw.embed(['hello'], 'memory_embed')
    expect(result.usage.inputTokens).toBe(0)
    expect(result.model).toBe('text-embedding-3-large')
  })

  it('throws when the row count does not match the request count', async () => {
    stubFetch({ data: [row(EMBEDDING_DIMENSIONS)] }) // 1 row for 2 inputs
    const gw = createOpenAIGateway(CONFIG)
    await expect(gw.embed(['a', 'b'], 'memory_embed')).rejects.toBeInstanceOf(
      InvalidEmbeddingResponseError,
    )
  })

  it('throws when a returned vector has the wrong dimensionality', async () => {
    stubFetch({ data: [row(EMBEDDING_DIMENSIONS), row(8)] }) // second row too short
    const gw = createOpenAIGateway(CONFIG)
    await expect(gw.embed(['a', 'b'], 'memory_embed')).rejects.toBeInstanceOf(
      InvalidEmbeddingResponseError,
    )
  })

  it('throws when a row is missing the embedding field (length 0)', async () => {
    stubFetch({ data: [{}] }) // no `embedding` -> empty vector
    const gw = createOpenAIGateway(CONFIG)
    await expect(gw.embed(['a'], 'memory_embed')).rejects.toBeInstanceOf(
      InvalidEmbeddingResponseError,
    )
  })

  it('error message carries counts/lengths only — never request texts or vectors', async () => {
    stubFetch({ data: [row(8)] })
    const gw = createOpenAIGateway(CONFIG)
    const secret = 'super-secret-input-text'
    const err = await gw.embed([secret], 'memory_embed').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidEmbeddingResponseError)
    const message = (err as Error).message
    expect(message).not.toContain(secret)
    expect(message).toContain('8')
    expect(message).toContain(String(EMBEDDING_DIMENSIONS))
  })

  it('short-circuits an empty input without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gw = createOpenAIGateway(CONFIG)
    const result = await gw.embed([], 'memory_embed')
    expect(result.embeddings).toEqual([])
    expect(result.usage.inputTokens).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('createOpenAIGateway embed() HTTP failure', () => {
  it('raises GatewayRequestError carrying the HTTP status as a property', async () => {
    // The status property is what core classifyEmbedFailure persists as the
    // bounded code ("GatewayRequestError:400") — without it a deterministic
    // 400 and a transient 429 collapse into the same audit label.
    const body = 'Invalid input: "the secret request text"'
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body, { status: 400 }))),
    )
    const gw = createOpenAIGateway(CONFIG)
    const err = await gw.embed(['the secret request text'], 'memory_embed').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayRequestError)
    expect((err as GatewayRequestError).status).toBe(400)
    // Message names the status only — never the response body or request text.
    expect((err as Error).message).toBe('gateway embed failed with status 400')
  })
})
