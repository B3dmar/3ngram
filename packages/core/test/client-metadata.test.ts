// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest'
import {
  type ClientMetadataDocumentFetcher,
  ClientMetadataError,
  type ClientMetadataHostnameResolver,
  type ClientMetadataHttpResponse,
  type ClientMetadataPinnedGet,
  ClientMetadataResolver,
  fetchClientMetadataDocument,
  isPublicClientMetadataAddress,
} from '../src/auth/client-metadata.js'

const clientId = 'https://client.example/oauth/client.json'

function document(id = clientId): Record<string, unknown> {
  return {
    client_id: id,
    client_name: 'Example MCP Client',
    redirect_uris: ['http://127.0.0.1:4321/callback'],
  }
}

async function* body(value: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value)
}

function response(
  status: number,
  value: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): ClientMetadataHttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: body(JSON.stringify(value)),
    dispose: vi.fn(),
  }
}

function publicResolver(address = '8.8.8.8'): ClientMetadataHostnameResolver {
  return async () => [{ address, family: 4 }]
}

async function expectReason(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ reason })
}

describe('isPublicClientMetadataAddress', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
  ])('accepts public unicast %s', (address) => {
    expect(isPublicClientMetadataAddress(address)).toBe(true)
  })

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('rejects non-public %s', (address) => {
    expect(isPublicClientMetadataAddress(address)).toBe(false)
  })
})

describe('fetchClientMetadataDocument', () => {
  it('pins a public DNS answer into the HTTPS request', async () => {
    const get = vi.fn<ClientMetadataPinnedGet>(async (_url, target) => {
      expect(target).toEqual({ address: '8.8.8.8', family: 4 })
      return response(200, document())
    })
    await expect(
      fetchClientMetadataDocument(clientId, {
        resolveHostname: publicResolver('8.8.8.8'),
        get,
      }),
    ).resolves.toMatchObject({ document: document() })
    expect(get).toHaveBeenCalledOnce()
  })

  it('rejects private or mixed DNS answers before opening a request', async () => {
    const get = vi.fn<ClientMetadataPinnedGet>()
    const resolveHostname: ClientMetadataHostnameResolver = async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]
    await expectReason(
      fetchClientMetadataDocument(clientId, { resolveHostname, get }),
      'unsafe_address',
    )
    expect(get).not.toHaveBeenCalled()
  })

  // Regression: a resolver reports ::ffff:a.b.c.d as family 6. The agreement
  // check compared that against the UNMAPPED kind ('ipv4' -> 4), so a perfectly
  // self-consistent answer looked forged and EVERY CIMD fetch failed closed with
  // unsafe_address before a socket was opened — a silent 400 invalid_client.
  it('accepts an IPv4-mapped IPv6 answer reported as family 6', async () => {
    const get = vi.fn<ClientMetadataPinnedGet>(async (_url, target) => {
      expect(target).toEqual({ address: '::ffff:8.8.8.8', family: 6 })
      return response(200, document())
    })
    const resolveHostname: ClientMetadataHostnameResolver = async () => [
      { address: '::ffff:8.8.8.8', family: 6 },
    ]
    await expect(
      fetchClientMetadataDocument(clientId, { resolveHostname, get }),
    ).resolves.toMatchObject({ document: document() })
    expect(get).toHaveBeenCalledOnce()
  })

  // The mirror of the above: unmapping stays the SECURITY check, so a mapped
  // loopback answer must still fail closed even though its family agrees.
  it('still rejects an IPv4-mapped private answer reported as family 6', async () => {
    const get = vi.fn<ClientMetadataPinnedGet>()
    const resolveHostname: ClientMetadataHostnameResolver = async () => [
      { address: '::ffff:127.0.0.1', family: 6 },
    ]
    await expectReason(
      fetchClientMetadataDocument(clientId, { resolveHostname, get }),
      'unsafe_address',
    )
    expect(get).not.toHaveBeenCalled()
  })

  it('revalidates and re-pins every redirect target', async () => {
    const resolveHostname = vi.fn<ClientMetadataHostnameResolver>(async (hostname) => [
      { address: hostname === 'client.example' ? '8.8.8.8' : '1.1.1.1', family: 4 },
    ])
    const get = vi
      .fn<ClientMetadataPinnedGet>()
      .mockResolvedValueOnce(response(302, {}, { location: 'https://cdn.example/client.json' }))
      .mockResolvedValueOnce(response(200, document()))

    await fetchClientMetadataDocument(clientId, { resolveHostname, get })

    expect(resolveHostname).toHaveBeenNthCalledWith(1, 'client.example')
    expect(resolveHostname).toHaveBeenNthCalledWith(2, 'cdn.example')
    expect(get.mock.calls[0]?.[1]).toEqual({ address: '8.8.8.8', family: 4 })
    expect(get.mock.calls[1]?.[1]).toEqual({ address: '1.1.1.1', family: 4 })
  })

  it('rejects a redirect downgrade to HTTP', async () => {
    const get = vi
      .fn<ClientMetadataPinnedGet>()
      .mockResolvedValueOnce(response(302, {}, { location: 'http://client.example/client.json' }))
    await expectReason(
      fetchClientMetadataDocument(clientId, { resolveHostname: publicResolver(), get }),
      'invalid_client_id',
    )
  })

  it('rejects oversized, non-JSON, and non-success responses', async () => {
    const cases = [
      response(200, 'x', {
        'content-type': 'application/json',
        'content-length': String(5 * 1024 + 1),
      }),
      response(200, document(), { 'content-type': 'text/html' }),
      response(404, document()),
    ]
    for (const item of cases) {
      const get: ClientMetadataPinnedGet = async () => item
      await expectReason(
        fetchClientMetadataDocument(clientId, {
          resolveHostname: publicResolver(),
          get,
        }),
        'invalid_response',
      )
    }
  })

  it('aborts a request after the timeout budget', async () => {
    const get: ClientMetadataPinnedGet = (_url, _target, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await expectReason(
      fetchClientMetadataDocument(clientId, {
        resolveHostname: publicResolver(),
        get,
        timeoutMs: 5,
      }),
      'fetch_failure',
    )
  })

  it('applies the timeout budget to DNS resolution', async () => {
    const resolveHostname: ClientMetadataHostnameResolver = () => new Promise(() => {})
    const get = vi.fn<ClientMetadataPinnedGet>()
    await expectReason(
      fetchClientMetadataDocument(clientId, {
        resolveHostname,
        get,
        timeoutMs: 5,
      }),
      'fetch_failure',
    )
    expect(get).not.toHaveBeenCalled()
  })
})

describe('ClientMetadataResolver', () => {
  it('validates the document and requires an exact client_id self-match', async () => {
    const fetchDocument: ClientMetadataDocumentFetcher = async () => ({
      document: document('https://CLIENT.example/oauth/client.json'),
      headers: new Headers(),
    })
    await expectReason(
      new ClientMetadataResolver({ fetchDocument }).resolve(clientId),
      'invalid_document',
    )
  })

  it('caches valid metadata for max-age and returns mutation-safe clones', async () => {
    let now = 1_000
    const fetchDocument = vi.fn<ClientMetadataDocumentFetcher>(async () => ({
      document: document(),
      headers: new Headers({ 'cache-control': 'public, max-age=10' }),
    }))
    const resolver = new ClientMetadataResolver({ fetchDocument, now: () => now })

    const first = await resolver.resolve(clientId)
    first.redirect_uris.push('https://mutated.example/callback')
    now = 10_999
    const cached = await resolver.resolve(clientId)
    expect(cached.redirect_uris).toEqual(['http://127.0.0.1:4321/callback'])
    expect(fetchDocument).toHaveBeenCalledOnce()

    now = 11_001
    await resolver.resolve(clientId)
    expect(fetchDocument).toHaveBeenCalledTimes(2)
  })

  it.each([
    'no-store',
    'no-cache',
    'private, max-age=600',
  ])('does not cache a %s response', async (cacheControl) => {
    const fetchDocument = vi.fn<ClientMetadataDocumentFetcher>(async () => ({
      document: document(),
      headers: new Headers({ 'cache-control': cacheControl }),
    }))
    const resolver = new ClientMetadataResolver({ fetchDocument })
    await resolver.resolve(clientId)
    await resolver.resolve(clientId)
    expect(fetchDocument).toHaveBeenCalledTimes(2)
  })

  it('does not cache invalid metadata or failed fetches', async () => {
    const invalid = vi.fn<ClientMetadataDocumentFetcher>(async () => ({
      document: { client_id: clientId },
      headers: new Headers({ 'cache-control': 'max-age=600' }),
    }))
    const invalidResolver = new ClientMetadataResolver({ fetchDocument: invalid })
    await expectReason(invalidResolver.resolve(clientId), 'invalid_document')
    await expectReason(invalidResolver.resolve(clientId), 'invalid_document')
    expect(invalid).toHaveBeenCalledTimes(2)

    const failed = vi.fn<ClientMetadataDocumentFetcher>(async () => {
      throw new Error('unavailable')
    })
    const failedResolver = new ClientMetadataResolver({ fetchDocument: failed })
    await expectReason(failedResolver.resolve(clientId), 'fetch_failure')
    await expectReason(failedResolver.resolve(clientId), 'fetch_failure')
    expect(failed).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent fetches for one client_id', async () => {
    let release: ((value: ReturnType<typeof document>) => void) | undefined
    const pending = new Promise<ReturnType<typeof document>>((resolve) => {
      release = resolve
    })
    const fetchDocument = vi.fn<ClientMetadataDocumentFetcher>(async () => ({
      document: await pending,
      headers: new Headers({ 'cache-control': 'max-age=60' }),
    }))
    const resolver = new ClientMetadataResolver({ fetchDocument })
    const first = resolver.resolve(clientId)
    const second = resolver.resolve(clientId)
    release?.(document())
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fetchDocument).toHaveBeenCalledOnce()
  })

  it('evicts the oldest entry at the configured cache cap', async () => {
    const otherId = 'https://other.example/oauth/client.json'
    const fetchDocument = vi.fn<ClientMetadataDocumentFetcher>(async (id) => ({
      document: document(id),
      headers: new Headers({ 'cache-control': 'max-age=60' }),
    }))
    const resolver = new ClientMetadataResolver({ fetchDocument, maxEntries: 1 })
    await resolver.resolve(clientId)
    await resolver.resolve(otherId)
    await resolver.resolve(clientId)
    expect(fetchDocument).toHaveBeenCalledTimes(3)
  })

  it('bounds concurrent fetches across distinct client ids', async () => {
    const otherId = 'https://other.example/oauth/client.json'
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchDocument: ClientMetadataDocumentFetcher = async (id) => {
      await barrier
      return {
        document: document(id),
        headers: new Headers({ 'cache-control': 'max-age=60' }),
      }
    }
    const resolver = new ClientMetadataResolver({ fetchDocument, maxInFlight: 1 })
    const first = resolver.resolve(clientId)
    await expectReason(resolver.resolve(otherId), 'capacity_exceeded')
    release?.()
    await expect(first).resolves.toMatchObject({ client_id: clientId })
  })

  it('rejects an invalid client_id before calling the fetcher', async () => {
    const fetchDocument = vi.fn<ClientMetadataDocumentFetcher>()
    await expectReason(
      new ClientMetadataResolver({ fetchDocument }).resolve('http://127.0.0.1/client.json'),
      'invalid_client_id',
    )
    expect(fetchDocument).not.toHaveBeenCalled()
  })

  it('exposes content-free classified errors', () => {
    const error = new ClientMetadataError('unsafe_address')
    expect(error.message).toBe('unsafe_address')
    expect(JSON.stringify(error)).not.toContain(clientId)
  })
})
