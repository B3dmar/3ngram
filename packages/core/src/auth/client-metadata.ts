// SPDX-License-Identifier: Apache-2.0
// OAuth Client ID Metadata Document discovery.
//
// SECURITY BOUNDARY:
// - validate the HTTPS client_id and every redirect
// - resolve DNS first, reject every non-public answer, and connect to a pinned IP
//   so DNS rebinding cannot redirect the socket after validation
// - never forward credentials
// - cap redirects, response bytes, and per-hop time
// - cache only valid documents, respecting shared-cache response directives
//
// This module is transport-agnostic at its public seam: callers resolve a
// client_id to schema-validated metadata. The pinned HTTPS and DNS functions are
// injectable so tests perform no network access.
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import {
  type ClientIdMetadataDocument,
  clientIdMetadataDocumentSchema,
  clientIdMetadataUrlSchema,
} from '@3ngram/schema'
import * as ipaddr from 'ipaddr.js'

const MAX_DOCUMENT_BYTES = 5 * 1024
const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const MAX_CACHE_TTL_MS = 60 * 60_000
const DEFAULT_MAX_CACHE_ENTRIES = 512
const DEFAULT_MAX_IN_FLIGHT = 64

export type ClientMetadataFailure =
  | 'invalid_client_id'
  | 'unsafe_address'
  | 'dns_failure'
  | 'fetch_failure'
  | 'capacity_exceeded'
  | 'too_many_redirects'
  | 'invalid_response'
  | 'invalid_document'

/** Content-free failure: safe to classify in metrics without logging a URL. */
export class ClientMetadataError extends Error {
  readonly reason: ClientMetadataFailure

  constructor(reason: ClientMetadataFailure) {
    super(reason)
    this.name = 'ClientMetadataError'
    this.reason = reason
  }
}

export interface ClientMetadataAddress {
  address: string
  family: 4 | 6
}

export interface ClientMetadataHttpResponse {
  status: number
  headers: Headers
  body: AsyncIterable<Uint8Array>
  /** Close an unread redirect/error body without retaining its socket. */
  dispose(): void
}

export type ClientMetadataHostnameResolver = (
  hostname: string,
) => Promise<readonly ClientMetadataAddress[]>

export type ClientMetadataPinnedGet = (
  url: URL,
  target: ClientMetadataAddress,
  signal: AbortSignal,
) => Promise<ClientMetadataHttpResponse>

export interface ClientMetadataFetchResult {
  document: unknown
  headers: Headers
}

export type ClientMetadataDocumentFetcher = (clientId: string) => Promise<ClientMetadataFetchResult>

export interface ClientMetadataFetchOptions {
  resolveHostname?: ClientMetadataHostnameResolver
  get?: ClientMetadataPinnedGet
  timeoutMs?: number
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Resolve both hostnames and literal IPs without changing the requested host. */
const resolveHostnameDefault: ClientMetadataHostnameResolver = async (hostname) => {
  const unwrapped = hostnameWithoutBrackets(hostname)
  if (ipaddr.isValid(unwrapped)) {
    const family: 4 | 6 = ipaddr.parse(unwrapped).kind() === 'ipv4' ? 4 : 6
    return [{ address: unwrapped, family }]
  }
  const answers = await lookup(unwrapped, { all: true, verbatim: true })
  return answers.map((answer) => {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new ClientMetadataError('dns_failure')
    }
    return { address: answer.address, family: answer.family }
  })
}

/** Public global unicast only; private, loopback, link-local, and reserved fail closed. */
export function isPublicClientMetadataAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  return ipaddr.process(address).range() === 'unicast'
}

/**
 * Require every DNS answer to be public, then pin the first. Rejecting a mixed
 * public/private answer avoids resolver-order dependent policy.
 *
 * The two ipaddr calls below are deliberately different and must stay that way:
 * - isPublicClientMetadataAddress() uses process(), which UNMAPS ::ffff:a.b.c.d
 *   to a.b.c.d. That is the security boundary — a mapped loopback/private answer
 *   has to be classified by its effective v4 range, or ::ffff:127.0.0.1 walks
 *   straight through the public-unicast check.
 * - the family agreement check uses parse(), which preserves the WIRE form. A
 *   resolver reports ::ffff:a.b.c.d as family 6, so comparing against the
 *   unmapped kind ('ipv4' -> 4) made a self-consistent answer look forged and
 *   failed every CIMD fetch closed with unsafe_address before opening a socket.
 */
async function resolvePublicTarget(
  url: URL,
  resolver: ClientMetadataHostnameResolver,
): Promise<ClientMetadataAddress> {
  let addresses: readonly ClientMetadataAddress[]
  try {
    addresses = await resolver(url.hostname)
  } catch {
    throw new ClientMetadataError('dns_failure')
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        !isPublicClientMetadataAddress(address) ||
        (ipaddr.parse(address).kind() === 'ipv4' ? 4 : 6) !== family,
    )
  ) {
    throw new ClientMetadataError('unsafe_address')
  }
  return addresses[0] as ClientMetadataAddress
}

/** Apply the per-hop budget to DNS as well as the subsequent HTTPS exchange. */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ClientMetadataError('fetch_failure')
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new ClientMetadataError('fetch_failure'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function responseHeaders(headers: NodeJS.Dict<string | string[]>): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item)
    } else if (value !== undefined) {
      result.set(name, value)
    }
  }
  return result
}

/** HTTPS GET that connects to the already-validated IP and verifies TLS for the original host. */
const pinnedHttpsGet: ClientMetadataPinnedGet = (url, target, signal) =>
  new Promise((resolve, reject) => {
    const tlsHostname = hostnameWithoutBrackets(url.hostname)
    const request = httpsRequest(
      {
        method: 'GET',
        hostname: target.address,
        family: target.family,
        port: url.port === '' ? 443 : Number.parseInt(url.port, 10),
        path: `${url.pathname}${url.search}`,
        headers: {
          accept: 'application/json, application/*+json',
          host: url.host,
          'user-agent': '3ngram-client-metadata',
        },
        // Never pool a connection across distinct client_id hostnames that
        // happen to resolve to the same IP.
        agent: false,
        signal,
        ...(ipaddr.isValid(tlsHostname) ? {} : { servername: tlsHostname }),
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: responseHeaders(response.headers),
          body: response,
          dispose: () => response.destroy(),
        })
      },
    )
    request.once('error', () => reject(new ClientMetadataError('fetch_failure')))
    request.end()
  })

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function hasJsonContentType(headers: Headers): boolean {
  const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return contentType === 'application/json' || contentType?.endsWith('+json') === true
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of body) {
    if (signal.aborted) throw new ClientMetadataError('fetch_failure')
    length += chunk.byteLength
    if (length > MAX_DOCUMENT_BYTES) throw new ClientMetadataError('invalid_response')
    chunks.push(chunk)
  }
  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function parseJsonBody(body: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return JSON.parse(text) as unknown
  } catch {
    throw new ClientMetadataError('invalid_response')
  }
}

/**
 * Fetch a client metadata JSON value through the SSRF-safe pinned transport.
 * Structural validation and exact client_id matching happen in the resolver so
 * injected fetchers cannot bypass the same boundary.
 */
export async function fetchClientMetadataDocument(
  clientId: string,
  options: ClientMetadataFetchOptions = {},
): Promise<ClientMetadataFetchResult> {
  const resolver = options.resolveHostname ?? resolveHostnameDefault
  const get = options.get ?? pinnedHttpsGet
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let current = clientId

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const parsed = clientIdMetadataUrlSchema.safeParse(current)
    if (!parsed.success) throw new ClientMetadataError('invalid_client_id')
    const url = new URL(parsed.data)
    const signal = AbortSignal.timeout(timeoutMs)
    const target = await withAbort(resolvePublicTarget(url, resolver), signal)
    let response: ClientMetadataHttpResponse
    try {
      response = await get(url, target, signal)
    } catch (error) {
      if (error instanceof ClientMetadataError) throw error
      throw new ClientMetadataError('fetch_failure')
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location')
      response.dispose()
      if (location === null) throw new ClientMetadataError('invalid_response')
      if (redirects === MAX_REDIRECTS) throw new ClientMetadataError('too_many_redirects')
      try {
        current = new URL(location, url).href
      } catch {
        throw new ClientMetadataError('invalid_response')
      }
      continue
    }

    if (response.status !== 200 || !hasJsonContentType(response.headers)) {
      response.dispose()
      throw new ClientMetadataError('invalid_response')
    }
    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
      response.dispose()
      throw new ClientMetadataError('invalid_response')
    }
    let body: Uint8Array
    try {
      body = await readBoundedBody(response.body, signal)
    } catch (error) {
      response.dispose()
      if (error instanceof ClientMetadataError) throw error
      throw new ClientMetadataError('fetch_failure')
    }
    return { document: parseJsonBody(body), headers: response.headers }
  }

  throw new ClientMetadataError('too_many_redirects')
}

interface CacheEntry {
  document: ClientIdMetadataDocument
  expiresAt: number
}

export interface ClientMetadataResolverOptions {
  fetchDocument?: ClientMetadataDocumentFetcher
  now?: () => number
  maxEntries?: number
  maxInFlight?: number
  defaultTtlMs?: number
  maxTtlMs?: number
}

function cacheControlDirectives(value: string | null): Map<string, string | true> {
  const directives = new Map<string, string | true>()
  if (value === null) return directives
  for (const part of value.split(',')) {
    const [rawName, ...rawValue] = part.trim().split('=')
    if (rawName === undefined || rawName === '') continue
    const name = rawName.toLowerCase()
    const value = rawValue.join('=').trim().replace(/^"|"$/g, '')
    directives.set(name, value === '' ? true : value)
  }
  return directives
}

function secondsDirective(value: string | true | undefined): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  return Number.parseInt(value, 10)
}

/** Shared-cache lifetime: honor explicit directives, then Expires, then a bounded heuristic. */
function cacheLifetimeMs(
  headers: Headers,
  now: number,
  defaultTtlMs: number,
  maxTtlMs: number,
): number {
  const directives = cacheControlDirectives(headers.get('cache-control'))
  const vary = headers.get('vary')
  if (
    directives.has('no-store') ||
    directives.has('no-cache') ||
    directives.has('private') ||
    vary?.split(',').some((value) => value.trim() === '*') === true
  ) {
    return 0
  }

  const seconds =
    secondsDirective(directives.get('s-maxage')) ?? secondsDirective(directives.get('max-age'))
  let lifetime =
    seconds === undefined
      ? expiryLifetimeMs(headers, now, defaultTtlMs)
      : Math.max(0, seconds * 1_000)
  const age = secondsDirective(headers.get('age') ?? undefined) ?? 0
  lifetime = Math.max(0, lifetime - age * 1_000)
  return Math.min(lifetime, maxTtlMs)
}

function expiryLifetimeMs(headers: Headers, now: number, fallback: number): number {
  const expires = Date.parse(headers.get('expires') ?? '')
  if (Number.isNaN(expires)) return fallback
  const date = Date.parse(headers.get('date') ?? '')
  return Math.max(0, expires - (Number.isNaN(date) ? now : date))
}

function cloneDocument(document: ClientIdMetadataDocument): ClientIdMetadataDocument {
  return {
    ...document,
    redirect_uris: [...document.redirect_uris],
    grant_types: [...document.grant_types],
    response_types: [...document.response_types],
  }
}

/**
 * Bounded, request-deduplicating resolver. Failed fetches and invalid documents
 * are never cached. Cached values are cloned so callers cannot mutate policy.
 */
export class ClientMetadataResolver {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<ClientIdMetadataDocument>>()
  private readonly fetchDocument: ClientMetadataDocumentFetcher
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly maxInFlight: number
  private readonly defaultTtlMs: number
  private readonly maxTtlMs: number

  constructor(options: ClientMetadataResolverOptions = {}) {
    this.fetchDocument = options.fetchDocument ?? fetchClientMetadataDocument
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.maxTtlMs = options.maxTtlMs ?? MAX_CACHE_TTL_MS
  }

  async resolve(clientId: string): Promise<ClientIdMetadataDocument> {
    if (!clientIdMetadataUrlSchema.safeParse(clientId).success) {
      throw new ClientMetadataError('invalid_client_id')
    }
    const cached = this.cache.get(clientId)
    if (cached !== undefined && cached.expiresAt > this.now()) {
      this.cache.delete(clientId)
      this.cache.set(clientId, cached)
      return cloneDocument(cached.document)
    }
    if (cached !== undefined) this.cache.delete(clientId)

    const active = this.inFlight.get(clientId)
    if (active !== undefined) return cloneDocument(await active)
    if (this.inFlight.size >= this.maxInFlight) {
      throw new ClientMetadataError('capacity_exceeded')
    }
    const pending = this.load(clientId)
    this.inFlight.set(clientId, pending)
    try {
      return cloneDocument(await pending)
    } finally {
      this.inFlight.delete(clientId)
    }
  }

  private async load(clientId: string): Promise<ClientIdMetadataDocument> {
    let fetched: ClientMetadataFetchResult
    try {
      fetched = await this.fetchDocument(clientId)
    } catch (error) {
      if (error instanceof ClientMetadataError) throw error
      throw new ClientMetadataError('fetch_failure')
    }
    const parsed = clientIdMetadataDocumentSchema.safeParse(fetched.document)
    if (!parsed.success || parsed.data.client_id !== clientId) {
      throw new ClientMetadataError('invalid_document')
    }
    const lifetime = cacheLifetimeMs(fetched.headers, this.now(), this.defaultTtlMs, this.maxTtlMs)
    if (lifetime > 0 && this.maxEntries > 0) {
      this.insertCache(clientId, parsed.data, lifetime)
    }
    return parsed.data
  }

  private insertCache(
    clientId: string,
    document: ClientIdMetadataDocument,
    lifetime: number,
  ): void {
    const now = this.now()
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key)
    }
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.cache.set(clientId, { document, expiresAt: now + lifetime })
  }
}
