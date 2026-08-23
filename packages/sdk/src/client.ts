// SPDX-License-Identifier: Apache-2.0
// ThreengramClient — a thin typed client over the EXISTING REST /api/v1 surface
// (apps/server/src/rest/router.ts; docs/concepts/architecture.mdx "one core, N transports"). It is a
// client of REST, NOT of packages/core (layering apps -> core -> db is upheld:
// the SDK never imports core/db). EVERY input/output type comes from
// @3ngram/schema — the SDK invents NO shape, so the single validation boundary
// (hard rule 2) holds across MCP, REST, and SDK alike.
//
// AUTH: REST is the C3 API-key chain (NOT OAuth bearer), so the configured
// `apiKey` rides as the `X-API-Key` header on EVERY request. Config is EXPLICIT
// only — no env/flag fallback (that is the CLI's job, Track C).
//
// TRANSPORT: the Node 20+ global `fetch` — NO HTTP dependency is added. A non-2xx
// response becomes a ThreengramApiError (.status + .reason from the `{ error }`
// body); a fetch rejection becomes a ThreengramNetworkError.
import type {
  CommitmentStatus,
  FactsQueryArgs,
  FactsToolOutput,
  RememberToolArgsV2,
  RememberToolOutputV2,
  ResolveToolOutput,
  RestErrorResponse,
  ReviseToolArgs,
  ReviseToolOutput,
  SearchQueryArgs,
  SearchRestResponseV2,
} from '@3ngram/schema'
import { restErrorResponseSchema } from '@3ngram/schema'
import { ThreengramApiError, ThreengramNetworkError } from './errors.js'

/** Explicit client configuration. No env/flag fallback — the caller supplies both. */
export interface ThreengramClientConfig {
  /** REST origin, e.g. `https://api.example.com` (no trailing `/api/v1`). */
  baseUrl: string
  /** API key sent as the `X-API-Key` header on every request (C3 key chain). */
  apiKey: string
}

/**
 * Search options: everything except `query` from the wider, caller-side
 * {@link SearchQueryArgs} (server-defaulted `limit` stays optional for callers).
 */
export type SearchOptions = Omit<SearchQueryArgs, 'query'>

/**
 * Revise body: the successor write WITHOUT `predecessorId`. The predecessor is
 * the URL arg of {@link ThreengramClient.revise}, and the REST router overwrites
 * any body `predecessorId` with the path id anyway ("the URL wins"), so requiring
 * it in the body would be redundant.
 */
export type ReviseBody = Omit<ReviseToolArgs, 'predecessorId'>

/** The `fetch` surface the client depends on — injectable for tests (no network). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Strip trailing path separators in linear time for arbitrary caller input. */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

/**
 * Typed client over REST `/api/v1`. Five methods mirror the routes 1:1; every
 * argument and return type is sourced from @3ngram/schema.
 */
export class ThreengramClient {
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #fetch: FetchLike

  constructor(config: ThreengramClientConfig, fetchImpl?: FetchLike) {
    this.#baseUrl = stripTrailingSlashes(config.baseUrl)
    this.#apiKey = config.apiKey
    this.#fetch = fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** POST /api/v1/memories — write a memory (commitmentId present only for commitments). */
  remember(input: RememberToolArgsV2): Promise<RememberToolOutputV2> {
    return this.#send<RememberToolOutputV2>('POST', '/api/v1/memories', input)
  }

  /** POST /api/v1/search — semantic search over the wider query+filters body. */
  search(query: string, opts?: SearchOptions): Promise<SearchRestResponseV2> {
    const body: SearchQueryArgs = { query, ...opts }
    return this.#send<SearchRestResponseV2>('POST', '/api/v1/search', body)
  }

  /** GET /api/v1/facts — currently-valid facts; filters ride as the querystring. */
  getFacts(filters?: FactsQueryArgs): Promise<FactsToolOutput> {
    const path = `/api/v1/facts${factsQuery(filters)}`
    return this.#send<FactsToolOutput>('GET', path)
  }

  /**
   * POST /api/v1/memories/:id/revise — supersede a predecessor with a successor write.
   * `predecessorId` is the path arg ONLY; it is merged into the body internally
   * (the REST router does the same — "the URL wins", router.ts), so callers never
   * duplicate it in {@link ReviseBody}.
   */
  revise(predecessorId: string, input: ReviseBody): Promise<ReviseToolOutput> {
    const path = `/api/v1/memories/${encodeURIComponent(predecessorId)}/revise`
    return this.#send<ReviseToolOutput>('POST', path, { ...input, predecessorId })
  }

  /** POST /api/v1/memories/:id/resolve — transition the commitment riding a memory. */
  resolve(
    memoryId: string,
    status: CommitmentStatus,
    opts?: { sessionRunId?: string },
  ): Promise<ResolveToolOutput> {
    const path = `/api/v1/memories/${encodeURIComponent(memoryId)}/resolve`
    return this.#send<ResolveToolOutput>('POST', path, { status, ...opts })
  }

  /** Issue one request: attach the key header, body, and map both failure shapes. */
  async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        'X-API-Key': this.#apiKey,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
    const response = await this.#dispatch(`${this.#baseUrl}${path}`, init)
    if (!response.ok) {
      const failure = await errorOf(response)
      throw new ThreengramApiError(response.status, failure.error, failure.detail)
    }
    return (await response.json()) as T
  }

  /** Run the injected fetch; a transport rejection becomes a ThreengramNetworkError. */
  async #dispatch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init)
    } catch (cause) {
      throw new ThreengramNetworkError('3ngram REST transport failed', cause)
    }
  }
}

/** Parse the stable error body; fall back safely when a nonconforming peer responds. */
async function errorOf(response: Response): Promise<RestErrorResponse> {
  try {
    const parsed = restErrorResponseSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : { error: 'unknown' }
  } catch {
    return { error: 'unknown' }
  }
}

/** Build the `/api/v1/facts` querystring — subject/predicate/limit + FLAT asOf coords. */
function factsQuery(filters: FactsQueryArgs | undefined): string {
  if (filters === undefined) return ''
  const params = new URLSearchParams()
  if (filters.subject !== undefined) params.set('subject', filters.subject)
  if (filters.predicate !== undefined) params.set('predicate', filters.predicate)
  if (filters.limit !== undefined) params.set('limit', String(filters.limit))
  if (filters.asOf?.validAt !== undefined) params.set('validAt', filters.asOf.validAt)
  if (filters.asOf?.asKnownAt !== undefined) params.set('asKnownAt', filters.asOf.asKnownAt)
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}
