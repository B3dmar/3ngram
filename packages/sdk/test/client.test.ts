// SPDX-License-Identifier: Apache-2.0
// Unit tests for ThreengramClient — NO network. A stub fetch records the request
// (method, URL, headers, body) and returns a canned Response, so each test
// asserts the wire shape the REST surface expects AND that success/error/network
// outcomes map to the right return value or typed error.

import { describe, expect, it } from 'vitest'
import {
  ThreengramApiError,
  ThreengramClient,
  type ThreengramClientConfig,
  ThreengramNetworkError,
} from '../src/index.js'

const CONFIG: ThreengramClientConfig = {
  baseUrl: 'https://api.example.com',
  apiKey: 'k_test_123',
}

interface RecordedCall {
  url: string
  method: string
  headers: Headers
  body: unknown
}

/** A stub fetch that records the call and returns a canned JSON response. */
function stubFetch(
  status: number,
  payload: unknown,
): {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetch: fetchImpl, calls }
}

/** The single recorded call, asserting exactly one request was issued. */
function only(calls: RecordedCall[]): RecordedCall {
  expect(calls).toHaveLength(1)
  const [call] = calls
  if (call === undefined) throw new Error('no call recorded')
  return call
}

describe('ThreengramClient request shape', () => {
  it('remember POSTs /api/v1/memories with the X-API-Key header and JSON body', async () => {
    const payload = {
      memory: {
        id: crypto.randomUUID(),
        memoryType: 'note',
        topic: 't',
        scope: 'personal',
        project: null,
      },
      embedded: 'pending',
    }
    const { fetch, calls } = stubFetch(201, payload)
    const client = new ThreengramClient(CONFIG, fetch)
    const input = { memoryType: 'note', topic: 't', content: 'hello' } as never

    const result = await client.remember(input)

    const call = only(calls)
    expect(call.method).toBe('POST')
    expect(call.url).toBe('https://api.example.com/api/v1/memories')
    expect(call.headers.get('X-API-Key')).toBe('k_test_123')
    expect(call.headers.get('Content-Type')).toBe('application/json')
    expect(call.body).toEqual(input)
    expect(result).toEqual(payload)
  })

  it('search POSTs /api/v1/search with query + opts merged into the body', async () => {
    const payload = { hits: [], count: 0 }
    const { fetch, calls } = stubFetch(200, payload)
    const client = new ThreengramClient(CONFIG, fetch)

    const result = await client.search('vector db', { limit: 10, scope: 'work' as never })

    const call = only(calls)
    expect(call.method).toBe('POST')
    expect(call.url).toBe('https://api.example.com/api/v1/search')
    expect(call.body).toEqual({ query: 'vector db', limit: 10, scope: 'work' })
    expect(result).toEqual(payload)
  })

  it('getFacts GETs /api/v1/facts with filters as a querystring incl. flat asOf', async () => {
    const payload = { facts: [], count: 0 }
    const { fetch, calls } = stubFetch(200, payload)
    const client = new ThreengramClient(CONFIG, fetch)

    await client.getFacts({
      subject: 'seb',
      limit: 20,
      asOf: { validAt: '2026-01-01T00:00:00.000Z', asKnownAt: '2026-02-01T00:00:00.000Z' },
    } as never)

    const call = only(calls)
    expect(call.method).toBe('GET')
    const url = new URL(call.url)
    expect(url.pathname).toBe('/api/v1/facts')
    expect(url.searchParams.get('subject')).toBe('seb')
    expect(url.searchParams.get('limit')).toBe('20')
    expect(url.searchParams.get('validAt')).toBe('2026-01-01T00:00:00.000Z')
    expect(url.searchParams.get('asKnownAt')).toBe('2026-02-01T00:00:00.000Z')
    expect(call.body).toBeUndefined()
  })

  it('getFacts with no filters GETs the bare /api/v1/facts path', async () => {
    const { fetch, calls } = stubFetch(200, { facts: [], count: 0 })
    const client = new ThreengramClient(CONFIG, fetch)

    await client.getFacts()

    expect(only(calls).url).toBe('https://api.example.com/api/v1/facts')
  })

  it('revise POSTs /api/v1/memories/:id/revise with the predecessor in the path', async () => {
    const id = crypto.randomUUID()
    const payload = {
      memory: {
        id: crypto.randomUUID(),
        memoryType: 'note',
        topic: 't',
        scope: 'personal',
        project: null,
      },
      embedded: 'off',
    }
    const { fetch, calls } = stubFetch(200, payload)
    const client = new ThreengramClient(CONFIG, fetch)
    const input = {
      memoryType: 'note',
      topic: 't',
      content: 'v2',
      edgeIntent: 'supersedes',
    } as never

    const result = await client.revise(id, input)

    const call = only(calls)
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`https://api.example.com/api/v1/memories/${id}/revise`)
    expect(call.body).toEqual({ ...input, predecessorId: id })
    expect(result).toEqual(payload)
  })

  it('resolve POSTs /api/v1/memories/:id/resolve with only the status in the body', async () => {
    const id = crypto.randomUUID()
    const payload = { commitmentId: crypto.randomUUID(), status: 'resolved' }
    const { fetch, calls } = stubFetch(200, payload)
    const client = new ThreengramClient(CONFIG, fetch)

    const result = await client.resolve(id, 'resolved')

    const call = only(calls)
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`https://api.example.com/api/v1/memories/${id}/resolve`)
    expect(call.body).toEqual({ status: 'resolved' })
    expect(result).toEqual(payload)
  })

  it('resolve forwards optional sessionRunId in the body', async () => {
    const id = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const { fetch, calls } = stubFetch(200, { commitmentId: id, status: 'resolved' })
    const client = new ThreengramClient(CONFIG, fetch)

    await client.resolve(id, 'resolved', { sessionRunId: runId })

    expect(only(calls).body).toEqual({ status: 'resolved', sessionRunId: runId })
  })

  it('strips trailing slashes from baseUrl so paths never double up', async () => {
    const { fetch, calls } = stubFetch(200, { hits: [], count: 0 })
    const client = new ThreengramClient({ ...CONFIG, baseUrl: 'https://api.example.com///' }, fetch)

    await client.search('x')

    expect(only(calls).url).toBe('https://api.example.com/api/v1/search')
  })
})

describe('ThreengramClient error mapping', () => {
  it('throws ThreengramApiError with .status and .reason on a non-2xx response', async () => {
    const { fetch } = stubFetch(404, { error: 'not_found' })
    const client = new ThreengramClient(CONFIG, fetch)

    await expect(client.resolve(crypto.randomUUID(), 'resolved')).rejects.toMatchObject({
      name: 'ThreengramApiError',
      status: 404,
      reason: 'not_found',
    })
  })

  it('maps a 503 embedding_unavailable from search to ThreengramApiError', async () => {
    const { fetch } = stubFetch(503, { error: 'embedding_unavailable' })
    const client = new ThreengramClient(CONFIG, fetch)

    const error = await client.search('x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ThreengramApiError)
    expect((error as ThreengramApiError).status).toBe(503)
    expect((error as ThreengramApiError).reason).toBe('embedding_unavailable')
  })

  it('preserves optional recovery detail on ThreengramApiError', async () => {
    const detail = 'registered scopes: personal, work'
    const { fetch } = stubFetch(400, { error: 'invalid_input', detail })
    const client = new ThreengramClient(CONFIG, fetch)

    await expect(client.search('x')).rejects.toMatchObject({
      status: 400,
      reason: 'invalid_input',
      detail,
    })
  })

  it('falls back to reason "unknown" when the error body has no error code', async () => {
    const { fetch } = stubFetch(409, { not_the_error_key: 'x' })
    const client = new ThreengramClient(CONFIG, fetch)

    await expect(client.resolve(crypto.randomUUID(), 'open')).rejects.toMatchObject({
      status: 409,
      reason: 'unknown',
    })
  })

  it('throws ThreengramNetworkError when fetch itself rejects', async () => {
    const cause = new TypeError('fetch failed')
    const failing = () => Promise.reject(cause)
    const client = new ThreengramClient(CONFIG, failing)

    const error = await client.search('x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ThreengramNetworkError)
    expect((error as ThreengramNetworkError).cause).toBe(cause)
  })
})
