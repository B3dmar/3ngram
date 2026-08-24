// SPDX-License-Identifier: Apache-2.0
// REST /api/v1 CONTRACT tests (no DB, no network): every route schema-validates
// its input (400 on bad payloads), 401s without a valid X-API-Key, happy-paths
// against a stubbed core, and maps typed core errors to the documented HTTP
// status (docs/concepts/architecture.mdx). Mocking @3ngram/core + the api-key
// resolver lets us assert the THIN-ADAPTER contract — the router passes validated
// args to core, shapes the JSON mirror of the MCP tool IO, and maps errors —
// without a Postgres dependency.
//
// The router is mounted on a fresh express app with express.json() and the SAME
// generic error handler shape app.ts uses (so a malformed-JSON body surfaces as
// the documented 400, not a 500), driven over a listening server with fetch.
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { fakeEmbedding } from '@3ngram/llm'
import express, { type Response as ExpressResponse, type NextFunction, type Request } from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// The REAL ZodError: the triage routes no longer pre-parse, so a rejected body
// reaches the mapper as a throw FROM core, and only the real class matches the
// `instanceof` ladder in rest/errors.ts.
import { ZodError } from 'zod'
import { decodeCursor, encodeCursor, searchFingerprint } from '../src/cursor.js'
import { SERVER_VERSION } from '../src/version.js'

// --- core memory tools (the thin adapter's target) ---
const remember = vi.fn()
const search = vi.fn()
const searchDashboardPage = vi.fn()
const getFacts = vi.fn()
const revise = vi.fn()
const resolveByMemoryId = vi.fn()
const archiveMemory = vi.fn()
const briefing = vi.fn()
// --- dashboard reads/admin ---
const listMemories = vi.fn()
const listMemoryFacets = vi.fn()
const getMemoryById = vi.fn()
const getMemoryHistory = vi.fn()
const listProposals = vi.fn()
const applyProposal = vi.fn()
const rejectProposal = vi.fn()
const listScopes = vi.fn()
const listSessionEvents = vi.fn()
// --- hook-facing session lifecycle (issue #166 step 5a) ---
const openAgentSession = vi.fn()
const closeAgentSession = vi.fn()
const heartbeatAgentSession = vi.fn()
const getAgentSession = vi.fn()
// --- the Stop-nudge handshake (issue #166 step 7a) ---
const beginAgentSessionTriage = vi.fn()
const completeAgentSessionTriage = vi.fn()
const describeEnvironment = vi.fn()
const getCurrentUser = vi.fn()
const exportUserData = vi.fn()
const deleteAccount = vi.fn()
const resolveRetrievalPolicy = vi.fn()

// Real typed error classes so the rest/errors.ts instanceof mapping is exercised
// end to end (the router catches a core throw and the mapper picks the status).
class DuplicateMemoryError extends Error {
  readonly contentHash: string
  constructor(contentHash: string) {
    super('duplicate')
    this.name = 'DuplicateMemoryError'
    this.contentHash = contentHash
  }
}
class PredecessorNotFoundError extends Error {
  readonly predecessorId: string
  constructor(predecessorId: string) {
    super('not found')
    this.name = 'PredecessorNotFoundError'
    this.predecessorId = predecessorId
  }
}
class CommitmentNotFoundError extends Error {
  readonly commitmentId: string
  constructor(commitmentId: string) {
    super('not found')
    this.name = 'CommitmentNotFoundError'
    this.commitmentId = commitmentId
  }
}
class InvalidCommitmentTransitionError extends Error {
  readonly from: string
  readonly to: string
  constructor(from: string, to: string) {
    super('illegal')
    this.name = 'InvalidCommitmentTransitionError'
    this.from = from
    this.to = to
  }
}
class IllegalCommitmentTransitionError extends InvalidCommitmentTransitionError {}
class InvalidEmbeddingError extends Error {}
class MissingSelectorError extends Error {}
function formatUnscopedRetrievalDetail(registeredScopes: readonly string[]): string {
  const prefix =
    "this account requires an explicit retrieval scope (retrieval-scope mode 'require') — "
  if (registeredScopes.length === 0) {
    return `${prefix}no scopes are registered yet — register one with configure_scope`
  }
  const shown = registeredScopes.slice(0, 8)
  const omitted = registeredScopes.length - shown.length
  return `${prefix}registered scopes: ${shown.join(', ')}${omitted > 0 ? `; +${omitted} more omitted` : ''}`
}
class UnscopedRetrievalError extends Error {
  readonly registeredScopes: readonly string[]
  constructor(registeredScopes: readonly string[]) {
    super(formatUnscopedRetrievalDetail(registeredScopes))
    this.name = 'UnscopedRetrievalError'
    this.registeredScopes = registeredScopes
  }
}
function applyPolicyToScopeFilter(
  policy: { mode: string; defaultScope?: string; registeredScopes?: readonly string[] } | undefined,
  requestedScope: string | undefined,
) {
  if (requestedScope !== undefined) return { scope: requestedScope, appliedScope: null }
  if (policy?.mode === 'default') {
    return { scope: policy.defaultScope, appliedScope: policy.defaultScope ?? null }
  }
  if (policy?.mode === 'require') throw new UnscopedRetrievalError(policy.registeredScopes ?? [])
  return { scope: undefined, appliedScope: null }
}
class NotCommitmentMemoryError extends Error {}
class PredecessorAlreadySupersededError extends Error {
  readonly predecessorId = 'x'
}
class EdgeConflictError extends Error {}
class CommitmentExistsError extends Error {
  readonly memoryId = 'x'
}
class ScopeNameConflictError extends Error {
  readonly scopeName = 'x'
}
class ScopeNotFoundError extends Error {
  readonly scopeName = 'x'
}
class ProposalNotFoundError extends Error {
  readonly proposalId = 'x'
}
class MemoryNotFoundError extends Error {
  readonly memoryId = 'x'
}
class EpisodicSupersessionError extends Error {}
class SuccessorNotLiveError extends Error {}
// Over-budget denial: carries the bounded operation key only.
class BudgetExceededError extends Error {
  readonly operation = 'memory.embed'
}
// Access denial: bounded access kind only.
class AccessDeniedError extends Error {
  readonly access: 'read' | 'write' = 'write'
}
class ResourceLimitExceededError extends Error {
  constructor(readonly resource: 'live_memories' | 'active_mcp_clients') {
    super('resource limit reached')
    this.name = 'ResourceLimitExceededError'
  }
}
class UnknownSessionRunError extends Error {
  readonly sessionRunId: string
  constructor(sessionRunId: string) {
    super('session run is not owned by this tenant')
    this.name = 'UnknownSessionRunError'
    this.sessionRunId = sessionRunId
  }
}
class AgentSessionNotFoundError extends Error {
  readonly agent: string
  readonly sessionId: string
  constructor(key: { agent: string; sessionId: string }) {
    super('no agent session for this natural key')
    this.name = 'AgentSessionNotFoundError'
    this.agent = key.agent
    this.sessionId = key.sessionId
  }
}
class AgentSessionParamsConflictError extends Error {
  readonly agent: string
  readonly sessionId: string
  constructor(key: { agent: string; sessionId: string }) {
    super('agent session already opened with different parameters')
    this.name = 'AgentSessionParamsConflictError'
    this.agent = key.agent
    this.sessionId = key.sessionId
  }
}
class AgentSessionTriageConflictError extends Error {
  readonly agent: string
  readonly sessionId: string
  readonly attemptId: string
  constructor(key: { agent: string; sessionId: string }, attemptId: string) {
    super('triage attempt is not the current one')
    this.name = 'AgentSessionTriageConflictError'
    this.agent = key.agent
    this.sessionId = key.sessionId
    this.attemptId = attemptId
  }
}
const getBudgetStatus = vi.fn()

// ASYNC factory so the ONE real export this suite needs can be pulled through
// importActual. The debrief registrar moved from apps/server into @3ngram/core
// (the worker's closer renders the same words, and apps must not import apps),
// and these cases assert on the prompt's actual TEXT — a stub would assert
// nothing. Everything else stays mocked.
vi.mock('@3ngram/core', async () => ({
  ...(await vi.importActual<{ renderDebriefPrompt: unknown }>('@3ngram/core')),
  applyPolicyToScopeFilter,
  remember,
  search,
  searchDashboardPage,
  getFacts,
  revise,
  resolveByMemoryId,
  archiveMemory,
  briefing,
  exportUserData,
  getBudgetStatus,
  BudgetExceededError,
  AccessDeniedError,
  ResourceLimitExceededError,
  listMemories,
  listMemoryFacets,
  getMemoryById,
  getMemoryHistory,
  listProposals,
  applyProposal,
  rejectProposal,
  listScopes,
  listSessionEvents,
  openAgentSession,
  closeAgentSession,
  heartbeatAgentSession,
  getAgentSession,
  beginAgentSessionTriage,
  completeAgentSessionTriage,
  AgentSessionNotFoundError,
  AgentSessionParamsConflictError,
  AgentSessionTriageConflictError,
  describeEnvironment,
  getCurrentUser,
  deleteAccount,
  DuplicateMemoryError,
  PredecessorNotFoundError,
  PredecessorAlreadySupersededError,
  EdgeConflictError,
  CommitmentNotFoundError,
  CommitmentExistsError,
  InvalidCommitmentTransitionError,
  IllegalCommitmentTransitionError,
  InvalidEmbeddingError,
  MissingSelectorError,
  NotCommitmentMemoryError,
  UnknownSessionRunError,
  resolveRetrievalPolicy,
  formatUnscopedRetrievalDetail,
  UnscopedRetrievalError,
  ScopeNameConflictError,
  ScopeNotFoundError,
  ProposalNotFoundError,
  MemoryNotFoundError,
  EpisodicSupersessionError,
  SuccessorNotLiveError,
}))

// --- api-key + session resolvers: a valid key/token resolves to a fixed tenant,
// else undefined. The combined /api/v1 gate tries the api key first,
// then the session bearer — both are stubbed here so the contract suite can drive
// EITHER auth path without a DB. ---
const authenticateApiKey = vi.fn<(key: string) => Promise<string | undefined>>()
const touchApiKeyLastUsed = vi.fn<(userId: string, key: string) => Promise<void>>()
const authenticateToken = vi.fn<(token: string) => Promise<string | undefined>>()
vi.mock('@3ngram/core/auth', () => ({
  authenticateApiKey,
  touchApiKeyLastUsed,
  authenticateToken,
}))

// Valid v4 UUIDs (z.uuid() enforces the version/variant nibbles).
const TENANT = crypto.randomUUID()
const VALID_KEY = '3ng_test_secret'
const VALID_TOKEN = 'session-bearer-token'
const NEW_ID = crypto.randomUUID()
const COMMIT_ID = crypto.randomUUID()

const { restRouter } = await import('../src/rest/router.js')
const { requestContext } = await import('../src/middleware/request-context.js')

let server: Server
let baseUrl: string

function buildApp(
  gateway: Parameters<typeof restRouter>[0]['gateway'],
  budget?: Parameters<typeof restRouter>[0]['budget'],
  access?: Parameters<typeof restRouter>[0]['access'],
): express.Express {
  const app = express()
  // requestContext establishes the AsyncLocalStorage context apiKeyAuth's
  // bindContext writes into (the real app mounts it first; mirror that here).
  app.use(requestContext)
  app.use(express.json())
  app.use(restRouter({ gateway, budget, access }))
  // Mirror app.ts: a malformed JSON body is a 400, not a 500.
  app.use((err: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    res.status(500).json({ error: 'internal_error' })
  })
  return app
}

const fakeGateway = {
  embed: vi.fn(async (texts: string[]) => texts.map((t) => fakeEmbedding(t))),
}

beforeAll(async () => {
  // A gateway is configured for the contract suite (search needs one); individual
  // tests that assert the no-gateway 503 spin up their own app.
  server = buildApp(fakeGateway as unknown as Parameters<typeof restRouter>[0]['gateway']).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
})

// A valid key resolves to the fixed tenant before EVERY test (reset clears
// implementations); individual tests override authenticateApiKey for the 401 path.
beforeEach(() => {
  vi.clearAllMocks()
  authenticateApiKey.mockResolvedValue(TENANT)
  touchApiKeyLastUsed.mockResolvedValue()
  // A valid session bearer resolves to the SAME fixed tenant, so a route's
  // happy-path assertions hold identically under either auth path.
  authenticateToken.mockResolvedValue(TENANT)
  // Retrieval-scope policy (issue #47): default to 'off' so every shipped
  // route assertion holds byte-identically; policy tests override per-case.
  resolveRetrievalPolicy.mockResolvedValue({ mode: 'off' })
})

interface CallOptions {
  method?: string
  key?: string | undefined
  token?: string | undefined
  body?: unknown
}

async function call(path: string, opts: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.key !== undefined) headers['x-api-key'] = opts.key
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

describe('REST /api/v1 auth (X-API-Key OR session Bearer, issue #194)', () => {
  const ALL_ROUTES: Array<[string, string]> = [
    ['POST', '/api/v1/memories'],
    ['GET', '/api/v1/memories'],
    ['GET', '/api/v1/memories/facets'],
    ['GET', `/api/v1/memories/${NEW_ID}`],
    ['POST', '/api/v1/search'],
    ['POST', '/api/v1/dashboard/search'],
    ['GET', '/api/v1/facts'],
    ['GET', '/api/v1/briefing?kind=all'],
    ['POST', `/api/v1/memories/${NEW_ID}/revise`],
    ['POST', `/api/v1/memories/${NEW_ID}/resolve`],
    ['POST', `/api/v1/memories/${NEW_ID}/archive`],
    ['GET', '/api/v1/proposals'],
    ['POST', `/api/v1/proposals/${NEW_ID}/apply`],
    ['POST', `/api/v1/proposals/${NEW_ID}/reject`],
    ['GET', `/api/v1/agent-sessions/${NEW_ID}/events`],
    ['POST', '/api/v1/agent-sessions/open'],
    ['POST', '/api/v1/agent-sessions/close'],
    ['POST', '/api/v1/agent-sessions/heartbeat'],
    ['POST', '/api/v1/agent-sessions/triage/begin'],
    ['POST', '/api/v1/agent-sessions/triage/complete'],
    ['GET', '/api/v1/prompts/debrief'],
    ['GET', '/api/v1/scopes'],
    ['GET', '/api/v1/stats'],
    ['GET', '/api/v1/me'],
    ['GET', '/api/v1/budget'],
    ['GET', '/api/v1/export'],
    ['GET', '/api/v1/version'],
    ['DELETE', '/api/v1/account'],
  ]

  it('401s every route with NO credential (neither X-API-Key nor Bearer)', async () => {
    for (const [method, path] of ALL_ROUTES) {
      const res = await call(path, { method, body: method === 'GET' ? undefined : {} })
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
    expect(remember).not.toHaveBeenCalled()
    expect(resolveRetrievalPolicy).not.toHaveBeenCalled()
  })

  it('401s an unknown/revoked key (api-key resolver returns undefined)', async () => {
    authenticateApiKey.mockResolvedValue(undefined)
    const res = await call('/api/v1/facts', { key: 'bad' })
    expect(res.status).toBe(401)
  })

  it('401s an unknown/expired session Bearer (session resolver returns undefined)', async () => {
    authenticateToken.mockResolvedValue(undefined)
    const res = await call('/api/v1/facts', { token: 'expired' })
    expect(res.status).toBe(401)
  })

  it('ACCEPTS a valid X-API-Key (binds the key tenant)', async () => {
    getCurrentUser.mockResolvedValue({ id: TENANT, email: 'seb@test.local' })
    const res = await call('/api/v1/me', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(getCurrentUser).toHaveBeenCalledWith(TENANT)
  })

  it('ACCEPTS a valid session Bearer (binds the session tenant, no X-API-Key)', async () => {
    getCurrentUser.mockResolvedValue({ id: TENANT, email: 'seb@test.local' })
    const res = await call('/api/v1/me', { token: VALID_TOKEN })
    expect(res.status).toBe(200)
    expect(getCurrentUser).toHaveBeenCalledWith(TENANT)
    // The api-key resolver was NOT consulted (no X-API-Key header present).
    expect(authenticateApiKey).not.toHaveBeenCalled()
    expect(authenticateToken).toHaveBeenCalledWith(VALID_TOKEN)
  })

  it('a present-but-invalid X-API-Key is a definitive 401 (no fallthrough to Bearer)', async () => {
    authenticateApiKey.mockResolvedValue(undefined)
    // Supply BOTH a bad key and a valid token: the bad key wins (definitive 401).
    const res = await call('/api/v1/me', { key: 'bad', token: VALID_TOKEN })
    expect(res.status).toBe(401)
    expect(authenticateToken).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/memories (remember)', () => {
  it('happy path: validates, calls core under the key tenant, echoes the normalized write', async () => {
    remember.mockResolvedValue({
      id: NEW_ID,
      embed: { settled: Promise.resolve(true) },
    })
    const res = await call('/api/v1/memories', {
      method: 'POST',
      key: VALID_KEY,
      body: { memoryType: 'note', topic: 'rest', content: 'remember over rest' },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { memory: { id: string; scope: string }; embedded: string }
    expect(body.memory.id).toBe(NEW_ID)
    expect(body.embedded).toBe('pending')
    // core called with the authenticated tenant + the user_api actor kind.
    expect(remember).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ memoryType: 'note', topic: 'rest' }),
      'user_api',
      expect.anything(),
    )
  })

  it('echoes factIds when the body carries facts, and omits the key otherwise', async () => {
    const factIds = [crypto.randomUUID()]
    remember.mockResolvedValue({ id: NEW_ID, factIds, embed: { settled: Promise.resolve(true) } })
    const withFacts = await call('/api/v1/memories', {
      method: 'POST',
      key: VALID_KEY,
      body: {
        memoryType: 'fact',
        topic: 'training',
        content: 'squat session',
        facts: [{ subject: 'lift.back_squat', predicate: 'top_set.weight_kg', value: '98' }],
      },
    })
    expect(withFacts.status).toBe(201)
    expect((await withFacts.json()) as { factIds: string[] }).toMatchObject({ factIds })

    // No facts -> the key is absent entirely, so the shipped response shape is
    // byte-identical for every existing caller.
    remember.mockResolvedValue({ id: NEW_ID, embed: { settled: Promise.resolve(true) } })
    const without = await call('/api/v1/memories', {
      method: 'POST',
      key: VALID_KEY,
      body: { memoryType: 'note', topic: 'rest', content: 'no facts here' },
    })
    expect('factIds' in ((await without.json()) as object)).toBe(false)
  })

  it('400s a malformed fact at the REST boundary without calling core', async () => {
    const res = await call('/api/v1/memories', {
      method: 'POST',
      key: VALID_KEY,
      body: {
        memoryType: 'fact',
        topic: 't',
        content: 'c',
        facts: [{ subject: 's', predicate: 'p', value: 'v', validTo: '2026-01-01T00:00:00.000Z' }],
      },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_input' })
    expect(remember).not.toHaveBeenCalled()
  })

  it('400s a payload missing required fields (schema boundary)', async () => {
    const res = await call('/api/v1/memories', {
      method: 'POST',
      key: VALID_KEY,
      body: { topic: 'no type or content' },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_input' })
    expect(remember).not.toHaveBeenCalled()
  })

  it('409s a duplicate memory (typed conflict -> HTTP)', async () => {
    remember.mockRejectedValue(new DuplicateMemoryError('deadbeef'))
    const res = await call('/api/v1/memories', {
      method: 'POST',
      key: VALID_KEY,
      body: { memoryType: 'note', topic: 't', content: 'dup' },
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'duplicate_memory' })
  })

  it('409s a live-memory resource denial with a stable reason', async () => {
    remember.mockRejectedValue(new ResourceLimitExceededError('live_memories'))
    const res = await call('/api/v1/memories', {
      method: 'POST',
      key: VALID_KEY,
      body: { memoryType: 'note', topic: 't', content: 'at cap' },
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'resource_limit_exceeded' })
  })

  it('surfaces the commitmentId for a commitment-type write', async () => {
    remember.mockResolvedValue({
      id: NEW_ID,
      commitmentId: COMMIT_ID,
      embed: { settled: Promise.resolve(true) },
    })
    const res = await call('/api/v1/memories', {
      method: 'POST',
      key: VALID_KEY,
      body: { memoryType: 'commitment', topic: 'ship', content: 'open the PR' },
    })
    expect(res.status).toBe(201)
    expect((await res.json()).commitmentId).toBe(COMMIT_ID)
  })
})

describe('POST /api/v1/search', () => {
  it('happy path: mirrors the public MCP search response contract', async () => {
    search.mockResolvedValue({
      hits: [
        {
          id: NEW_ID,
          memoryType: 'commitment',
          topic: 't',
          content: 'hit',
          contentLength: 'hit'.length,
          truncated: false,
          score: 0.9,
          commitmentStatus: 'waiting',
        },
      ],
      appliedScope: null,
    })
    const res = await call('/api/v1/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, scope: 'work', memoryType: 'commitment' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      hits: Array<{
        content?: string
        contentLength?: number
        truncated?: boolean
        commitmentStatus?: string
      }>
      count: number
      hasMore?: boolean
    }
    expect(body).not.toHaveProperty('hasMore')
    expect(body.count).toBe(body.hits.length)
    expect(body.count).toBe(1)
    expect(body.hits[0]).toMatchObject({ content: 'hit', contentLength: 3, truncated: false })
    expect(body.hits[0]).not.toHaveProperty('commitmentStatus')
    expect(search).toHaveBeenCalledWith(
      TENANT,
      'find me',
      expect.objectContaining({ gateway: expect.anything() }),
      expect.objectContaining({
        limit: 1,
        filters: expect.objectContaining({ scope: 'work', memoryType: 'commitment' }),
      }),
    )
  })

  it('400s public-search offset/cursor because continuation lives on the dashboard route', async () => {
    for (const body of [
      { query: 'find me', offset: 25 },
      { query: 'find me', cursor: 'opaque' },
    ]) {
      const res = await call('/api/v1/search', { method: 'POST', key: VALID_KEY, body })
      expect(res.status).toBe(400)
    }
    expect(search).not.toHaveBeenCalled()
  })

  it('400s an empty query (schema boundary)', async () => {
    const res = await call('/api/v1/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: '' },
    })
    expect(res.status).toBe(400)
    expect(search).not.toHaveBeenCalled()
  })

  it('400s an unknown filter key (strict schema rejects, never a silent drop)', async () => {
    const res = await call('/api/v1/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'x', bogusFilter: 'leak' },
    })
    expect(res.status).toBe(400)
  })

  it('503s when no embedding gateway is configured', async () => {
    const noGwApp = buildApp(undefined).listen(0)
    await new Promise<void>((resolve) => noGwApp.once('listening', resolve))
    const addr = noGwApp.address()
    if (addr === null || typeof addr === 'string') throw new Error('expected a TCP address')
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': VALID_KEY },
      body: JSON.stringify({ query: 'x' }),
    })
    expect(res.status).toBe(503)
    await new Promise<void>((resolve) => noGwApp.close(() => resolve()))
  })

  it('preserves retrieval-policy recovery detail in a 400 response', async () => {
    resolveRetrievalPolicy.mockResolvedValue({
      mode: 'require',
      registeredScopes: ['personal', 'work'],
    })
    search.mockRejectedValue(new UnscopedRetrievalError(['personal', 'work']))

    const res = await call('/api/v1/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me' },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'invalid_input',
      detail:
        "this account requires an explicit retrieval scope (retrieval-scope mode 'require') — registered scopes: personal, work",
    })
  })

  it('bounds retrieval-policy recovery detail in a 400 response', async () => {
    const registeredScopes = Array.from({ length: 100 }, (_, index) => `scope-${index}`)
    resolveRetrievalPolicy.mockResolvedValue({ mode: 'require', registeredScopes })
    search.mockRejectedValue(new UnscopedRetrievalError(registeredScopes))

    const res = await call('/api/v1/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me' },
    })

    const body = (await res.json()) as { error: string; detail: string }
    expect(res.status).toBe(400)
    expect(body.detail.length).toBeLessThanOrEqual(512)
    expect(body.detail).toContain('+92 more omitted')
  })
})

describe('POST /api/v1/dashboard/search', () => {
  const FROZEN_IDS = [NEW_ID, '33333333-3333-4333-8333-333333333333']

  it('first page: returns the envelope and freezes the ordering into a v2 cursor', async () => {
    searchDashboardPage.mockResolvedValue({
      hits: [
        {
          id: NEW_ID,
          memoryType: 'commitment',
          topic: 't',
          content: 'hit',
          contentLength: 'hit'.length,
          truncated: false,
          score: 0.9,
          commitmentStatus: 'waiting',
        },
      ],
      frozen: { ids: FROZEN_IDS, scores: [0.9, 0.8], policyScope: null },
      nextOffset: 1,
      hasMore: true,
    })
    const res = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, scope: 'work', memoryType: 'commitment' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      hits: Array<{ contentLength?: number; truncated?: boolean; commitmentStatus?: string }>
      count: number
      hasMore: boolean
      nextCursor?: string
    }
    expect(body.count).toBe(body.hits.length)
    expect(body.count).toBe(1)
    expect(body.hasMore).toBe(true)
    expect(body.hits[0]?.commitmentStatus).toBe('waiting')
    expect(body.hits[0]).not.toHaveProperty('contentLength')
    expect(body.hits[0]).not.toHaveProperty('truncated')
    // nextCursor carries the frozen ordering + the next offset + the
    // fingerprint binding it to this query/filter set.
    expect(body.nextCursor).toBeDefined()
    expect(decodeCursor(body.nextCursor as string)).toEqual({
      v: 2,
      ids: FROZEN_IDS,
      scores: [0.9, 0.8],
      off: 1,
      fp: searchFingerprint('find me', { memoryType: 'commitment', scope: 'work' }),
      policyScope: null,
    })
    expect(searchDashboardPage).toHaveBeenCalledWith(
      TENANT,
      'find me',
      expect.objectContaining({ gateway: expect.anything() }),
      expect.objectContaining({
        limit: 1,
        filters: expect.objectContaining({ scope: 'work', memoryType: 'commitment' }),
      }),
    )
    // First page (no cursor) -> no frozen ordering passed to core.
    expect(searchDashboardPage.mock.calls[0]?.[3]).not.toHaveProperty('frozen')
  })

  it('continuation: decodes the v2 cursor and pages by position within the frozen ordering', async () => {
    searchDashboardPage.mockResolvedValue({
      hits: [{ id: FROZEN_IDS[1], memoryType: 'note', topic: 'next', content: 'n', score: 0.8 }],
      frozen: { ids: FROZEN_IDS, scores: [0.9, 0.8], policyScope: null },
      nextOffset: 2,
      hasMore: false,
    })
    const cursor = encodeCursor({ v: 2, ids: FROZEN_IDS, scores: [0.9, 0.8], off: 1 })
    const res = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, cursor },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hasMore: boolean; nextCursor?: string }
    expect(body.hasMore).toBe(false)
    // End of the window -> no further cursor.
    expect(body.nextCursor).toBeUndefined()
    expect(searchDashboardPage).toHaveBeenCalledWith(
      TENANT,
      'find me',
      expect.objectContaining({ gateway: expect.anything() }),
      expect.objectContaining({ frozen: { ids: FROZEN_IDS, scores: [0.9, 0.8], off: 1 } }),
    )
  })

  it('stale v1 cursor restarts at page 1 (no frozen ordering, not a 400)', async () => {
    searchDashboardPage.mockResolvedValue({
      hits: [],
      frozen: { ids: [], scores: [], policyScope: null },
      nextOffset: 1,
      hasMore: false,
    })
    const v1 = encodeCursor({ s: 1.5, id: '22222222-2222-4222-8222-222222222222' } as never)
    const res = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, cursor: v1 },
    })
    expect(res.status).toBe(200)
    expect(searchDashboardPage.mock.calls.at(-1)?.[3]).not.toHaveProperty('frozen')
  })

  it('continuation with the SAME query accepts a fingerprint-bound cursor', async () => {
    searchDashboardPage.mockResolvedValue({
      hits: [],
      frozen: { ids: FROZEN_IDS, scores: [0.9, 0.8], policyScope: null },
      nextOffset: 2,
      hasMore: false,
    })
    const fp = searchFingerprint('find me', {})
    const cursor = encodeCursor({ v: 2, ids: FROZEN_IDS, scores: [0.9, 0.8], off: 1, fp })
    const res = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, cursor },
    })
    expect(res.status).toBe(200)
    expect(searchDashboardPage.mock.calls.at(-1)?.[3]).toHaveProperty('frozen')
  })

  it('binds a cursor to the effective policy scope and rejects policy changes', async () => {
    searchDashboardPage.mockResolvedValue({
      hits: [],
      frozen: { ids: FROZEN_IDS, scores: [0.9, 0.8], policyScope: 'work' },
      nextOffset: 1,
      hasMore: true,
      appliedScope: 'work',
    })
    resolveRetrievalPolicy.mockResolvedValue({ mode: 'default', defaultScope: 'work' })
    const first = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1 },
    })
    const cursor = ((await first.json()) as { nextCursor: string }).nextCursor
    expect(decodeCursor(cursor)).toMatchObject({
      fp: searchFingerprint('find me', {}, 'work', true),
      policyScope: 'work',
    })

    vi.clearAllMocks()
    authenticateApiKey.mockResolvedValue(TENANT)
    touchApiKeyLastUsed.mockResolvedValue()
    resolveRetrievalPolicy.mockResolvedValue({ mode: 'default', defaultScope: 'work' })
    const samePolicy = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, cursor },
    })
    expect(samePolicy.status).toBe(200)
    expect(searchDashboardPage.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        frozen: expect.objectContaining({ off: 1, policyScope: 'work' }),
      }),
    )

    vi.clearAllMocks()
    authenticateApiKey.mockResolvedValue(TENANT)
    touchApiKeyLastUsed.mockResolvedValue()
    resolveRetrievalPolicy.mockResolvedValue({ mode: 'default', defaultScope: 'personal' })
    const replay = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, cursor },
    })
    expect(replay.status).toBe(400)
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('rejects policy-default and explicit-scope cursor provenance changes', async () => {
    searchDashboardPage.mockResolvedValue({
      hits: [],
      frozen: { ids: FROZEN_IDS, scores: [0.9, 0.8], policyScope: 'work' },
      nextOffset: 1,
      hasMore: true,
      appliedScope: 'work',
    })
    resolveRetrievalPolicy.mockResolvedValue({ mode: 'default', defaultScope: 'work' })
    const first = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1 },
    })
    const policyCursor = ((await first.json()) as { nextCursor: string }).nextCursor

    vi.clearAllMocks()
    authenticateApiKey.mockResolvedValue(TENANT)
    touchApiKeyLastUsed.mockResolvedValue()
    resolveRetrievalPolicy.mockResolvedValue({ mode: 'default', defaultScope: 'work' })
    const explicitReplay = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, scope: 'work', cursor: policyCursor },
    })
    expect(explicitReplay.status).toBe(400)
    expect(searchDashboardPage).not.toHaveBeenCalled()

    const explicitCursor = encodeCursor({
      v: 2,
      ids: FROZEN_IDS,
      scores: [0.9, 0.8],
      off: 1,
      fp: searchFingerprint('find me', { scope: 'work' }, 'work'),
      policyScope: null,
    })
    const policyReplay = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, cursor: explicitCursor },
    })
    expect(policyReplay.status).toBe(400)
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('400s a cursor replayed against a CHANGED query/filters (typed mismatch, never a silent re-page)', async () => {
    const fp = searchFingerprint('find me', {})
    const cursor = encodeCursor({ v: 2, ids: FROZEN_IDS, scores: [0.9, 0.8], off: 1, fp })
    // Changed query text.
    const changedQuery = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'something else', limit: 1, cursor },
    })
    expect(changedQuery.status).toBe(400)
    expect(((await changedQuery.json()) as { error: string }).error).toBe('invalid_input')
    // Same query, changed filter set.
    const changedFilters = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', limit: 1, scope: 'work', cursor },
    })
    expect(changedFilters.status).toBe(400)
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('400s a malformed cursor (garbled token is client input, not a crash)', async () => {
    const res = await call('/api/v1/dashboard/search', {
      method: 'POST',
      key: VALID_KEY,
      body: { query: 'find me', cursor: '!!!not-base64-json!!!' },
    })
    expect(res.status).toBe(400)
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/facts', () => {
  it('happy path: passes subject/limit, returns the fact envelope', async () => {
    getFacts.mockResolvedValue([
      {
        id: NEW_ID,
        subject: 'seb',
        predicate: 'prefers',
        value: 'rg',
        confidence: 0.8,
        validFrom: new Date('2026-01-01T00:00:00Z'),
        validTo: null,
        recordedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ])
    const res = await call('/api/v1/facts?subject=seb&limit=10', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { facts: unknown[]; count: number }
    expect(body.count).toBe(body.facts.length)
    expect(getFacts).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ subject: 'seb', limit: 10 }),
    )
  })

  it('400s a non-positive limit (schema boundary)', async () => {
    const res = await call('/api/v1/facts?limit=0', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(getFacts).not.toHaveBeenCalled()
  })

  it('forwards validAt as a bi-temporal asOf coordinate (Date) to core', async () => {
    getFacts.mockResolvedValue([])
    const res = await call('/api/v1/facts?subject=seb&validAt=2021-06-01T00:00:00.000Z', {
      key: VALID_KEY,
    })
    expect(res.status).toBe(200)
    expect(getFacts).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        subject: 'seb',
        asOf: { validAt: new Date('2021-06-01T00:00:00.000Z') },
      }),
    )
  })

  it('forwards asKnownAt as a transaction-time asOf coordinate (Date) to core', async () => {
    getFacts.mockResolvedValue([])
    const res = await call('/api/v1/facts?asKnownAt=2023-06-01T00:00:00.000Z', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(getFacts).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ asOf: { asKnownAt: new Date('2023-06-01T00:00:00.000Z') } }),
    )
  })

  it('forwards both coordinates when supplied together', async () => {
    getFacts.mockResolvedValue([])
    const res = await call(
      '/api/v1/facts?validAt=2021-06-01T00:00:00.000Z&asKnownAt=2023-06-01T00:00:00.000Z',
      { key: VALID_KEY },
    )
    expect(res.status).toBe(200)
    expect(getFacts).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        asOf: {
          validAt: new Date('2021-06-01T00:00:00.000Z'),
          asKnownAt: new Date('2023-06-01T00:00:00.000Z'),
        },
      }),
    )
  })

  it('omits asOf entirely (current-facts default) when neither coordinate is given', async () => {
    getFacts.mockResolvedValue([])
    const res = await call('/api/v1/facts?subject=seb', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const [, opts] = getFacts.mock.calls[0] as [string, Record<string, unknown>]
    expect(opts).not.toHaveProperty('asOf')
  })

  it('400s a malformed asOf coordinate (z.iso.datetime boundary, never a silent drop)', async () => {
    const res = await call('/api/v1/facts?validAt=not-a-date', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(getFacts).not.toHaveBeenCalled()
  })

  // get_facts range read (from/to flat query keys reshaped into {range:{from?,to?}}
  // before the SAME factsQueryInputV2Schema parse — mirrors the asOf reshape
  // above).
  it('forwards from/to as a range window (Date) to core', async () => {
    getFacts.mockResolvedValue([])
    const res = await call(
      '/api/v1/facts?subject=seb&from=2020-01-01T00:00:00.000Z&to=2022-01-01T00:00:00.000Z',
      { key: VALID_KEY },
    )
    expect(res.status).toBe(200)
    expect(getFacts).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        subject: 'seb',
        range: {
          from: new Date('2020-01-01T00:00:00.000Z'),
          to: new Date('2022-01-01T00:00:00.000Z'),
        },
      }),
    )
  })

  it('accepts an open-ended range (from-only or to-only)', async () => {
    getFacts.mockResolvedValue([])
    const fromOnly = await call('/api/v1/facts?from=2020-01-01T00:00:00.000Z', {
      key: VALID_KEY,
    })
    expect(fromOnly.status).toBe(200)
    expect(getFacts).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ range: { from: new Date('2020-01-01T00:00:00.000Z') } }),
    )
  })

  it('omits range entirely (current-facts default) when neither from nor to is given', async () => {
    getFacts.mockResolvedValue([])
    const res = await call('/api/v1/facts?subject=seb', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const [, opts] = getFacts.mock.calls[0] as [string, Record<string, unknown>]
    expect(opts).not.toHaveProperty('range')
  })

  it('400s range together with asOf (mutually exclusive time-travel modes)', async () => {
    const res = await call(
      '/api/v1/facts?from=2020-01-01T00:00:00.000Z&validAt=2021-01-01T00:00:00.000Z',
      { key: VALID_KEY },
    )
    expect(res.status).toBe(400)
    expect(getFacts).not.toHaveBeenCalled()
  })

  it('400s an inverted range (from later than to) — issue #58 precedent: reject, not clamp', async () => {
    const res = await call(
      '/api/v1/facts?from=2022-01-01T00:00:00.000Z&to=2020-01-01T00:00:00.000Z',
      { key: VALID_KEY },
    )
    expect(res.status).toBe(400)
    expect(getFacts).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/briefing', () => {
  // A complete briefingToolOutputSchema-shaped payload (empty sections) the
  // stubbed core returns; the route serializes it verbatim (thin transport).
  const emptySection = { count: 0, items: [] }
  const BRIEFING = {
    selector: { kind: 'all' as const },
    mode: 'brief' as const,
    generatedAt: '2026-06-10T00:00:00.000Z',
    commitments: emptySection,
    overdue: emptySection,
    blockers: emptySection,
    staleCandidates: emptySection,
    recentDecisions: emptySection,
    preferences: emptySection,
  }

  it('happy path: parses the selector + mode, calls core under the key tenant, returns the briefing shape', async () => {
    briefing.mockResolvedValue(BRIEFING)
    const res = await call('/api/v1/briefing?kind=all', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const body = (await res.json()) as typeof BRIEFING
    expect(body.selector).toEqual({ kind: 'all' })
    expect(body.mode).toBe('brief')
    expect(body).toHaveProperty('commitments')
    expect(body).toHaveProperty('overdue')
    expect(body).toHaveProperty('preferences')
    // core called with the authenticated tenant, the parsed selector, and an
    // injected `now` Date read at the transport edge (not in core).
    expect(briefing).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ selector: { kind: 'all' }, mode: 'brief', now: expect.any(Date) }),
    )
  })

  it('honors a scope selector + full mode through the query string', async () => {
    briefing.mockResolvedValue({
      ...BRIEFING,
      selector: { kind: 'scope', scope: 'work' },
      mode: 'full',
    })
    const res = await call('/api/v1/briefing?kind=scope&scope=work&mode=full', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(briefing).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ selector: { kind: 'scope', scope: 'work' }, mode: 'full' }),
    )
  })

  it('honors a project selector through the query string', async () => {
    briefing.mockResolvedValue({ ...BRIEFING, selector: { kind: 'project', project: 'acme' } })
    const res = await call('/api/v1/briefing?kind=project&project=acme', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(briefing).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ selector: { kind: 'project', project: 'acme' } }),
    )
  })

  // --- selector V2 (issue #46): kind=scope_project + includeUnscoped ---

  it('honors a scope_project selector, defaulting includeUnscoped to false', async () => {
    const selector = {
      kind: 'scope_project' as const,
      scope: 'work',
      project: 'acme',
      includeUnscoped: false,
    }
    briefing.mockResolvedValue({ ...BRIEFING, selector })
    const res = await call('/api/v1/briefing?kind=scope_project&scope=work&project=acme', {
      key: VALID_KEY,
    })
    expect(res.status).toBe(200)
    // The schema default rides into core: includeUnscoped is ALWAYS explicit
    // past the boundary (strict passthrough, never an implicit widen).
    expect(briefing).toHaveBeenCalledWith(TENANT, expect.objectContaining({ selector }))
  })

  it('coerces includeUnscoped=true|false from the querystring, 400s anything else', async () => {
    const selector = {
      kind: 'scope_project' as const,
      scope: 'work',
      project: 'acme',
      includeUnscoped: true,
    }
    briefing.mockResolvedValue({ ...BRIEFING, selector })
    const on = await call(
      '/api/v1/briefing?kind=scope_project&scope=work&project=acme&includeUnscoped=true',
      { key: VALID_KEY },
    )
    expect(on.status).toBe(200)
    expect(briefing).toHaveBeenCalledWith(TENANT, expect.objectContaining({ selector }))
    // Only the literal strings true/false coerce; anything else must be a 400
    // at the schema boundary, never a silent false.
    const bogus = await call(
      '/api/v1/briefing?kind=scope_project&scope=work&project=acme&includeUnscoped=yes',
      { key: VALID_KEY },
    )
    expect(bogus.status).toBe(400)
  })

  it('400s scope_project missing its project and includeUnscoped on a bare variant', async () => {
    // The intersection needs both halves.
    const half = await call('/api/v1/briefing?kind=scope_project&scope=work', { key: VALID_KEY })
    expect(half.status).toBe(400)
    // The shipped bare project variant is NOT widened (strict union member).
    const smuggle = await call('/api/v1/briefing?kind=project&project=acme&includeUnscoped=true', {
      key: VALID_KEY,
    })
    expect(smuggle.status).toBe(400)
    expect(briefing).not.toHaveBeenCalled()
  })

  it('400s a missing selector kind (no-firehose schema boundary)', async () => {
    const res = await call('/api/v1/briefing', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_input' })
    expect(briefing).not.toHaveBeenCalled()
  })

  it('400s a scope selector missing its scope value (strict discriminated union)', async () => {
    const res = await call('/api/v1/briefing?kind=scope', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(briefing).not.toHaveBeenCalled()
  })

  it('400s an invalid mode enum (schema boundary)', async () => {
    const res = await call('/api/v1/briefing?kind=all&mode=bogus', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(briefing).not.toHaveBeenCalled()
  })

  it('maps a MissingSelectorError thrown by core to a 400 (taxonomy parity)', async () => {
    briefing.mockRejectedValue(new MissingSelectorError('no selector'))
    const res = await call('/api/v1/briefing?kind=all', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_input' })
  })

  // --- bounds V2 (issue #45): sections + sectionLimit through the querystring ---

  it('plumbs comma-separated sections and sectionLimit through to core', async () => {
    briefing.mockResolvedValue(BRIEFING)
    const res = await call(
      '/api/v1/briefing?kind=all&sections=commitments,overdue&sectionLimit=50',
      {
        key: VALID_KEY,
      },
    )
    expect(res.status).toBe(200)
    expect(briefing).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        selector: { kind: 'all' },
        sections: ['commitments', 'overdue'],
        sectionLimit: 50,
      }),
    )
  })

  it('accepts repeated sections params (qs array form)', async () => {
    briefing.mockResolvedValue(BRIEFING)
    const res = await call('/api/v1/briefing?kind=all&sections=blockers&sections=preferences', {
      key: VALID_KEY,
    })
    expect(res.status).toBe(200)
    expect(briefing).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ sections: ['blockers', 'preferences'] }),
    )
  })

  it('400s an unknown or duplicated section name (single V2 schema boundary)', async () => {
    for (const qs of ['sections=bogus', 'sections=overdue,overdue']) {
      const res = await call(`/api/v1/briefing?kind=all&${qs}`, { key: VALID_KEY })
      expect(res.status).toBe(400)
      expect(briefing).not.toHaveBeenCalled()
    }
  })

  it('400s an out-of-range, fractional, or non-numeric sectionLimit', async () => {
    for (const qs of [
      'sectionLimit=0',
      'sectionLimit=101',
      'sectionLimit=2.5',
      'sectionLimit=abc',
    ]) {
      const res = await call(`/api/v1/briefing?kind=all&${qs}`, { key: VALID_KEY })
      expect(res.status).toBe(400)
      expect(briefing).not.toHaveBeenCalled()
    }
  })

  it('legacy params stay byte-stable: no V2 knobs reach core and the payload is verbatim', async () => {
    briefing.mockResolvedValue(BRIEFING)
    const res = await call('/api/v1/briefing?kind=all&mode=brief', { key: VALID_KEY })
    expect(res.status).toBe(200)
    // EXACT argument match (not objectContaining): a legacy query must produce
    // exactly the V1 core call — no sections/sectionLimit keys ride along.
    // The injected retrievalPolicy (issue #47) is the ONE addition every
    // briefing call now carries — resolved per request, 'off' by default.
    expect(briefing).toHaveBeenCalledWith(TENANT, {
      selector: { kind: 'all' },
      mode: 'brief',
      now: expect.any(Date),
      retrievalPolicy: { mode: 'off' },
    })
    expect(JSON.stringify(await res.json())).toBe(JSON.stringify(BRIEFING))
  })
})

describe('POST /api/v1/memories/:id/revise', () => {
  it('happy path: merges :id as predecessorId, calls core, echoes the successor', async () => {
    revise.mockResolvedValue({ id: COMMIT_ID, embed: { settled: Promise.resolve(true) } })
    const res = await call(`/api/v1/memories/${NEW_ID}/revise`, {
      method: 'POST',
      key: VALID_KEY,
      body: { memoryType: 'note', topic: 't', content: 'corrected', edgeIntent: 'supersedes' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).memory.id).toBe(COMMIT_ID)
    expect(revise).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ predecessorId: NEW_ID, edgeIntent: 'supersedes' }),
      'user_api',
      expect.anything(),
    )
  })

  it('404s an unknown predecessor (typed not_found -> HTTP)', async () => {
    revise.mockRejectedValue(new PredecessorNotFoundError(NEW_ID))
    const res = await call(`/api/v1/memories/${NEW_ID}/revise`, {
      method: 'POST',
      key: VALID_KEY,
      body: { memoryType: 'note', topic: 't', content: 'x', edgeIntent: 'supersedes' },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })
})

describe('POST /api/v1/memories/:id/resolve', () => {
  it('happy path: merges :id as memoryId, transitions, echoes the new status', async () => {
    resolveByMemoryId.mockResolvedValue({ id: COMMIT_ID, status: 'resolved' })
    const res = await call(`/api/v1/memories/${NEW_ID}/resolve`, {
      method: 'POST',
      key: VALID_KEY,
      body: { status: 'resolved' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ commitmentId: COMMIT_ID, status: 'resolved' })
    expect(resolveByMemoryId).toHaveBeenCalledWith(
      TENANT,
      NEW_ID,
      'resolved',
      'user_api',
      undefined,
    )
  })

  it('409s an illegal FSM transition (invalid_transition -> HTTP)', async () => {
    resolveByMemoryId.mockRejectedValue(new InvalidCommitmentTransitionError('resolved', 'expired'))
    const res = await call(`/api/v1/memories/${NEW_ID}/resolve`, {
      method: 'POST',
      key: VALID_KEY,
      body: { status: 'expired' },
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'invalid_transition' })
  })

  it('404s a memory with no commitment (typed not_found -> HTTP)', async () => {
    resolveByMemoryId.mockRejectedValue(new CommitmentNotFoundError(NEW_ID))
    const res = await call(`/api/v1/memories/${NEW_ID}/resolve`, {
      method: 'POST',
      key: VALID_KEY,
      body: { status: 'resolved' },
    })
    expect(res.status).toBe(404)
  })

  it('400s an invalid status enum (schema boundary)', async () => {
    const res = await call(`/api/v1/memories/${NEW_ID}/resolve`, {
      method: 'POST',
      key: VALID_KEY,
      body: { status: 'bogus' },
    })
    expect(res.status).toBe(400)
    expect(resolveByMemoryId).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/memories/:id/archive', () => {
  it('happy path: archives the memory, echoes {id, status:"archived"}', async () => {
    archiveMemory.mockResolvedValue({ id: NEW_ID, status: 'archived' })
    const res = await call(`/api/v1/memories/${NEW_ID}/archive`, {
      method: 'POST',
      key: VALID_KEY,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: NEW_ID, status: 'archived' })
    expect(archiveMemory).toHaveBeenCalledWith(TENANT, NEW_ID, 'user_api', undefined)
  })

  it('404s an unknown id (typed MemoryNotFoundError -> not_found)', async () => {
    archiveMemory.mockRejectedValue(new MemoryNotFoundError())
    const res = await call(`/api/v1/memories/${NEW_ID}/archive`, {
      method: 'POST',
      key: VALID_KEY,
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('404s an ALREADY-ARCHIVED memory (core guard excludes archived rows)', async () => {
    // The db guard matches status='active' only, so a second archive is the
    // same typed miss as an unknown id — not a silent 200.
    archiveMemory.mockRejectedValue(new MemoryNotFoundError())
    const res = await call(`/api/v1/memories/${NEW_ID}/archive`, {
      method: 'POST',
      key: VALID_KEY,
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('404s a malformed (non-uuid) id WITHOUT calling core', async () => {
    const res = await call('/api/v1/memories/not-a-uuid/archive', {
      method: 'POST',
      key: VALID_KEY,
    })
    expect(res.status).toBe(404)
    expect(archiveMemory).not.toHaveBeenCalled()
  })

  it('401s without a credential (auth required)', async () => {
    const res = await call(`/api/v1/memories/${NEW_ID}/archive`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(archiveMemory).not.toHaveBeenCalled()
  })

  it('forwards optional sessionRunId from the body', async () => {
    archiveMemory.mockResolvedValue({ id: NEW_ID, status: 'archived' })
    const res = await call(`/api/v1/memories/${NEW_ID}/archive`, {
      method: 'POST',
      key: VALID_KEY,
      body: { sessionRunId: NEW_ID },
    })
    expect(res.status).toBe(200)
    expect(archiveMemory).toHaveBeenCalledWith(TENANT, NEW_ID, 'user_api', NEW_ID)
  })
})

describe('GET /api/v1/memories (list)', () => {
  it('happy path: parses paging+filters, returns the identity-only envelope with total', async () => {
    listMemories.mockResolvedValue({
      memories: [
        {
          id: NEW_ID,
          memoryType: 'commitment',
          topic: 'a',
          project: '3ngram',
          scope: 'work',
          status: 'active',
          commitmentStatus: 'resolved',
          recordedAt: new Date('2025-01-01T00:00:00Z'),
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
      total: 7,
    })
    const res = await call('/api/v1/memories?limit=10&offset=0&type=commitment&scope=work', {
      key: VALID_KEY,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      memories: Array<{
        id: string
        content?: string
        status: string
        commitmentStatus?: string
        recordedAt: string
        createdAt: string
      }>
      count: number
      total: number
    }
    expect(body.count).toBe(body.memories.length)
    expect(body.total).toBe(7)
    expect(body.memories[0]?.status).toBe('active')
    expect(body.memories[0]?.commitmentStatus).toBe('resolved')
    // identity-only: no content leaks into the list (hard rule 6).
    expect(body.memories[0]).not.toHaveProperty('content')
    // leads with recorded_at (bi-temporal real history); created_at stays secondary.
    expect(body.memories[0]?.recordedAt).toBe('2025-01-01T00:00:00.000Z')
    expect(body.memories[0]?.createdAt).toBe('2026-06-01T00:00:00.000Z')
    expect(listMemories).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ limit: 10, offset: 0, memoryType: 'commitment', scope: 'work' }),
    )
  })

  it('400s an over-cap limit (schema boundary)', async () => {
    const res = await call('/api/v1/memories?limit=9999', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(listMemories).not.toHaveBeenCalled()
  })

  it('400s an invalid type filter enum (schema boundary)', async () => {
    const res = await call('/api/v1/memories?type=bogus', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(listMemories).not.toHaveBeenCalled()
  })

  it('passes a multi-project array to core via repeated ?project= params (issue #342)', async () => {
    listMemories.mockResolvedValue({ memories: [], total: 0 })
    const res = await call('/api/v1/memories?project=alpha&project=beta', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(listMemories).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ project: ['alpha', 'beta'] }),
    )
  })

  it('passes repeated ?memoryTypes= params to core as an array (filters V2, #48)', async () => {
    listMemories.mockResolvedValue({ memories: [], total: 0 })
    const res = await call('/api/v1/memories?memoryTypes=decision&memoryTypes=fact', {
      key: VALID_KEY,
    })
    expect(res.status).toBe(200)
    expect(listMemories).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ memoryTypes: ['decision', 'fact'] }),
    )
  })

  it('passes a single ?memoryTypes= param to core as a string (filters V2, #48)', async () => {
    listMemories.mockResolvedValue({ memories: [], total: 0 })
    const res = await call('/api/v1/memories?memoryTypes=note', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(listMemories).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ memoryTypes: 'note' }),
    )
  })

  it('coerces recordedAfter/recordedBefore ISO params to Dates for core (filters V2, #48)', async () => {
    listMemories.mockResolvedValue({ memories: [], total: 0 })
    const res = await call(
      '/api/v1/memories?recordedAfter=2026-01-01T00:00:00Z&recordedBefore=2026-02-01T00:00:00Z',
      { key: VALID_KEY },
    )
    expect(res.status).toBe(200)
    expect(listMemories).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        recordedAfter: new Date('2026-01-01T00:00:00Z'),
        recordedBefore: new Date('2026-02-01T00:00:00Z'),
      }),
    )
  })

  it('threads the V2 axes COMBINED with the existing filters (filters V2, #48)', async () => {
    listMemories.mockResolvedValue({ memories: [], total: 0 })
    const res = await call(
      '/api/v1/memories?memoryTypes=decision&memoryTypes=fact&recordedAfter=2026-01-01T00:00:00Z&scope=work&project=alpha&status=active',
      { key: VALID_KEY },
    )
    expect(res.status).toBe(200)
    expect(listMemories).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        memoryTypes: ['decision', 'fact'],
        recordedAfter: new Date('2026-01-01T00:00:00Z'),
        scope: 'work',
        project: 'alpha',
        status: 'active',
      }),
    )
  })

  it('400s memoryTypes combined with type (mutually exclusive, #48)', async () => {
    const res = await call('/api/v1/memories?type=decision&memoryTypes=fact', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(listMemories).not.toHaveBeenCalled()
  })

  it('400s an invalid memoryTypes element and a malformed recorded bound (schema boundary)', async () => {
    const bogusType = await call('/api/v1/memories?memoryTypes=bogus', { key: VALID_KEY })
    expect(bogusType.status).toBe(400)
    const bogusDate = await call('/api/v1/memories?recordedAfter=last-tuesday', { key: VALID_KEY })
    expect(bogusDate.status).toBe(400)
    expect(listMemories).not.toHaveBeenCalled()
  })

  it('400s an inverted recorded range — MCP parity, never an empty 200 (issue #58)', async () => {
    const inverted = await call(
      '/api/v1/memories?recordedAfter=2026-02-01T00:00:00Z&recordedBefore=2026-01-01T00:00:00Z',
      { key: VALID_KEY },
    )
    expect(inverted.status).toBe(400)
    expect(listMemories).not.toHaveBeenCalled()
  })

  it('400s a sub-millisecond recorded bound instead of silently truncating it (issue #58)', async () => {
    const subMs = await call('/api/v1/memories?recordedAfter=2026-01-01T00:00:00.123456Z', {
      key: VALID_KEY,
    })
    expect(subMs.status).toBe(400)
    // Millisecond precision stays accepted end-to-end.
    listMemories.mockResolvedValue({ memories: [], total: 0 })
    const ms = await call('/api/v1/memories?recordedAfter=2026-01-01T00:00:00.123Z', {
      key: VALID_KEY,
    })
    expect(ms.status).toBe(200)
    expect(listMemories).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ recordedAfter: new Date('2026-01-01T00:00:00.123Z') }),
    )
  })
})

describe('GET /api/v1/memories/facets (issue #342)', () => {
  it('returns the distinct scopes and projects from live memories', async () => {
    listMemoryFacets.mockResolvedValue({ scopes: ['personal', 'work'], projects: ['alpha'] })
    const res = await call('/api/v1/memories/facets', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scopes: string[]; projects: string[] }
    expect(body.scopes).toEqual(['personal', 'work'])
    expect(body.projects).toEqual(['alpha'])
    expect(listMemoryFacets).toHaveBeenCalledWith(TENANT)
  })

  it('returns empty arrays when the tenant has no live memories', async () => {
    listMemoryFacets.mockResolvedValue({ scopes: [], projects: [] })
    const res = await call('/api/v1/memories/facets', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scopes: string[]; projects: string[] }
    expect(body.scopes).toHaveLength(0)
    expect(body.projects).toHaveLength(0)
  })

  it('does NOT match "facets" as an :id param (route order guard)', async () => {
    // If facets were registered after /:id, the :id handler would try to UUID-parse
    // "facets" and return 404. This test confirms the facets route wins.
    listMemoryFacets.mockResolvedValue({ scopes: [], projects: [] })
    const res = await call('/api/v1/memories/facets', { key: VALID_KEY })
    expect(res.status).toBe(200)
    // The facets core function was called — not the inspect handler.
    expect(listMemoryFacets).toHaveBeenCalled()
    expect(getMemoryById).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/memories/:id/history', () => {
  it('happy path: returns identity-only lineage and audit metadata', async () => {
    const predecessorId = crypto.randomUUID()
    const edgeId = crypto.randomUUID()
    getMemoryHistory.mockResolvedValue({
      memory: {
        id: NEW_ID,
        memoryType: 'note',
        topic: 'current topic',
        project: null,
        scope: 'work',
        status: 'active',
        validFrom: new Date('2026-06-01T00:00:00Z'),
        validTo: null,
        recordedAt: new Date('2026-05-01T00:00:00Z'),
        createdAt: new Date('2026-06-01T00:00:00Z'),
        isCurrent: true,
        lifecycleState: 'current',
      },
      lineage: {
        nodes: [
          {
            id: NEW_ID,
            memoryType: 'note',
            topic: 'current topic',
            project: null,
            scope: 'work',
            status: 'active',
            validFrom: new Date('2026-06-01T00:00:00Z'),
            validTo: null,
            recordedAt: new Date('2026-05-01T00:00:00Z'),
            createdAt: new Date('2026-06-01T00:00:00Z'),
            isCurrent: true,
            lifecycleState: 'current',
          },
        ],
        edges: [
          {
            id: edgeId,
            fromId: NEW_ID,
            toId: predecessorId,
            edgeType: 'supersedes',
            createdBy: 'user_api',
            createdAt: new Date('2026-06-02T00:00:00Z'),
          },
        ],
        truncated: false,
      },
      directRelationships: { predecessors: [], successors: [], truncated: false },
      auditEvents: [
        {
          id: crypto.randomUUID(),
          eventKind: 'create',
          actorKind: 'user_api',
          createdAt: new Date('2026-06-01T00:00:00Z'),
          payloadMetadata: { present: true, jsonType: 'object', byteLength: 20 },
        },
      ],
      eventsTruncated: false,
      sections: { lineage: 'ok', events: 'ok' },
    })

    const res = await call(`/api/v1/memories/${NEW_ID}/history`, { key: VALID_KEY })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      memory: { id: string; content?: string; recordedAt: string }
      lineage: { edges: Array<{ createdAt: string }> }
      auditEvents: Array<{ payloadMetadata: { byteLength: number }; payload?: unknown }>
      sections: { lineage: string; events: string }
    }
    expect(body.memory.id).toBe(NEW_ID)
    expect(body.memory).not.toHaveProperty('content')
    expect(body.memory.recordedAt).toBe('2026-05-01T00:00:00.000Z')
    expect(body.lineage.edges[0]?.createdAt).toBe('2026-06-02T00:00:00.000Z')
    expect(body.auditEvents[0]?.payloadMetadata.byteLength).toBe(20)
    expect(body.auditEvents[0]).not.toHaveProperty('payload')
    expect(body.sections).toEqual({ lineage: 'ok', events: 'ok' })
    expect(getMemoryHistory).toHaveBeenCalledWith(TENANT, NEW_ID)
  })

  it('partial failure: returns 200 with sections.events = unavailable (FR-003a)', async () => {
    getMemoryHistory.mockResolvedValue({
      memory: {
        id: NEW_ID,
        memoryType: 'note',
        topic: 'current topic',
        project: null,
        scope: 'work',
        status: 'active',
        validFrom: new Date('2026-06-01T00:00:00Z'),
        validTo: null,
        recordedAt: new Date('2026-05-01T00:00:00Z'),
        createdAt: new Date('2026-06-01T00:00:00Z'),
        isCurrent: true,
        lifecycleState: 'current',
      },
      lineage: {
        nodes: [
          {
            id: NEW_ID,
            memoryType: 'note',
            topic: 'current topic',
            project: null,
            scope: 'work',
            status: 'active',
            validFrom: new Date('2026-06-01T00:00:00Z'),
            validTo: null,
            recordedAt: new Date('2026-05-01T00:00:00Z'),
            createdAt: new Date('2026-06-01T00:00:00Z'),
            isCurrent: true,
            lifecycleState: 'current',
          },
        ],
        edges: [],
        truncated: false,
      },
      directRelationships: { predecessors: [], successors: [], truncated: false },
      auditEvents: [],
      eventsTruncated: false,
      sections: { lineage: 'ok', events: 'unavailable' },
      sectionErrors: { events: 'Error' },
    })

    const res = await call(`/api/v1/memories/${NEW_ID}/history`, { key: VALID_KEY })
    // A readable memory degrades to 200 (no 500) — the root-cause guarantee.
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      lineage: { nodes: Array<{ id: string }> }
      auditEvents: unknown[]
      sections: { lineage: string; events: string }
      sectionErrors?: unknown
    }
    expect(body.sections).toEqual({ lineage: 'ok', events: 'unavailable' })
    expect(body.lineage.nodes).toHaveLength(1)
    expect(body.auditEvents).toEqual([])
    // The content-free diagnostic stays server-side; it is not on the wire body.
    expect(body).not.toHaveProperty('sectionErrors')
  })

  it('404s an absent/cross-tenant id (typed not_found -> HTTP)', async () => {
    getMemoryHistory.mockRejectedValue(new MemoryNotFoundError('missing'))
    const res = await call(`/api/v1/memories/${NEW_ID}/history`, { key: VALID_KEY })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('404s a malformed id at the boundary', async () => {
    const res = await call('/api/v1/memories/not-a-uuid/history', { key: VALID_KEY })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(getMemoryHistory).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/memories/:id (inspect)', () => {
  it('happy path: returns the full memory row (content included)', async () => {
    getMemoryById.mockResolvedValue({
      id: NEW_ID,
      memoryType: 'note',
      topic: 't',
      content: 'the body',
      scope: 'work',
      project: null,
      status: 'active',
      commitmentStatus: 'waiting',
      tags: ['x'],
      validFrom: new Date('2026-06-01T00:00:00Z'),
      validTo: null,
      recordedAt: new Date('2025-01-01T00:00:00Z'),
      createdAt: new Date('2026-06-01T00:00:00Z'),
    })
    const res = await call(`/api/v1/memories/${NEW_ID}`, { key: VALID_KEY })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      content: string
      project: string | null
      status: string
      commitmentStatus?: string
      recordedAt: string
      createdAt: string
    }
    expect(body.id).toBe(NEW_ID)
    expect(body.content).toBe('the body')
    expect(body.project).toBeNull()
    expect(body.status).toBe('active')
    expect(body.commitmentStatus).toBe('waiting')
    // detail leads with recorded_at; created_at stays secondary metadata.
    expect(body.recordedAt).toBe('2025-01-01T00:00:00.000Z')
    expect(body.createdAt).toBe('2026-06-01T00:00:00.000Z')
    expect(getMemoryById).toHaveBeenCalledWith(TENANT, NEW_ID)
  })

  it('404s an absent/cross-tenant id (typed not_found -> HTTP)', async () => {
    getMemoryById.mockRejectedValue(new MemoryNotFoundError('missing'))
    const res = await call(`/api/v1/memories/${NEW_ID}`, { key: VALID_KEY })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('404s a malformed (non-UUID) id at the boundary (never a uuid-cast 500)', async () => {
    const res = await call('/api/v1/memories/not-a-uuid', { key: VALID_KEY })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(getMemoryById).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/proposals (list)', () => {
  it('happy path: passes status/limit, returns the proposal envelope', async () => {
    listProposals.mockResolvedValue([
      {
        id: NEW_ID,
        fromId: NEW_ID,
        toId: COMMIT_ID,
        edgeType: 'supersedes',
        memoryType: 'note',
        similarity: 0.91,
        rationale: null,
        status: 'proposed',
        decidedAt: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ])
    const res = await call('/api/v1/proposals?status=proposed&limit=10', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { proposals: unknown[]; count: number }
    expect(body.count).toBe(body.proposals.length)
    expect(listProposals).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ status: 'proposed', limit: 10 }),
    )
  })

  it('400s an invalid status enum (schema boundary)', async () => {
    const res = await call('/api/v1/proposals?status=bogus', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(listProposals).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/proposals/:id/apply', () => {
  it('happy path: applies under the user_api actor, echoes the new status', async () => {
    applyProposal.mockResolvedValue({ id: NEW_ID, status: 'applied' })
    const res = await call(`/api/v1/proposals/${NEW_ID}/apply`, { method: 'POST', key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: NEW_ID, status: 'applied' })
    expect(applyProposal).toHaveBeenCalledWith(TENANT, NEW_ID, 'user_api')
  })

  it('404s a missing/decided proposal (typed not_found -> HTTP)', async () => {
    applyProposal.mockRejectedValue(new ProposalNotFoundError())
    const res = await call(`/api/v1/proposals/${NEW_ID}/apply`, { method: 'POST', key: VALID_KEY })
    expect(res.status).toBe(404)
  })

  it('409s a stale-successor apply (typed conflict -> HTTP)', async () => {
    applyProposal.mockRejectedValue(new SuccessorNotLiveError())
    const res = await call(`/api/v1/proposals/${NEW_ID}/apply`, { method: 'POST', key: VALID_KEY })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'conflict' })
  })

  it('404s a malformed (non-UUID) id at the boundary (never a uuid-cast 500)', async () => {
    const res = await call('/api/v1/proposals/not-a-uuid/apply', { method: 'POST', key: VALID_KEY })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(applyProposal).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/proposals/:id/reject', () => {
  it('happy path (no body): rejects, echoes the new status', async () => {
    rejectProposal.mockResolvedValue({ id: NEW_ID, status: 'rejected' })
    const res = await call(`/api/v1/proposals/${NEW_ID}/reject`, { method: 'POST', key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: NEW_ID, status: 'rejected' })
    expect(rejectProposal).toHaveBeenCalledWith(TENANT, NEW_ID)
  })

  it('happy path with an optional rationale (validated, not yet persisted)', async () => {
    rejectProposal.mockResolvedValue({ id: NEW_ID, status: 'rejected' })
    const res = await call(`/api/v1/proposals/${NEW_ID}/reject`, {
      method: 'POST',
      key: VALID_KEY,
      body: { rationale: 'not similar enough' },
    })
    expect(res.status).toBe(200)
    expect(rejectProposal).toHaveBeenCalledWith(TENANT, NEW_ID)
  })

  it('400s an unknown body key (strict schema)', async () => {
    const res = await call(`/api/v1/proposals/${NEW_ID}/reject`, {
      method: 'POST',
      key: VALID_KEY,
      body: { bogus: 'leak' },
    })
    expect(res.status).toBe(400)
    expect(rejectProposal).not.toHaveBeenCalled()
  })

  it('404s a missing/decided proposal (typed not_found -> HTTP)', async () => {
    rejectProposal.mockRejectedValue(new ProposalNotFoundError())
    const res = await call(`/api/v1/proposals/${NEW_ID}/reject`, { method: 'POST', key: VALID_KEY })
    expect(res.status).toBe(404)
  })

  it('404s a malformed (non-UUID) id at the boundary (never a uuid-cast 500)', async () => {
    const res = await call('/api/v1/proposals/not-a-uuid/reject', {
      method: 'POST',
      key: VALID_KEY,
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(rejectProposal).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/stats', () => {
  it('happy path: surfaces the bounded count aggregates (stats half only)', async () => {
    describeEnvironment.mockResolvedValue({
      scopes: [{ id: 'x', name: 'work', aliases: [] }],
      stats: {
        memoriesByType: { note: 3 },
        activeMemories: 3,
        supersededMemories: 1,
        archivedMemories: 2,
        commitmentsByStatus: { open: 2 },
      },
    })
    const res = await call('/api/v1/stats', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      memoriesByType: { note: 3 },
      activeMemories: 3,
      supersededMemories: 1,
      archivedMemories: 2,
      commitmentsByStatus: { open: 2 },
    })
    // archivedMemories is present and is a number.
    expect(typeof body.archivedMemories).toBe('number')
    // The scopes half is NOT leaked through /stats.
    expect(body).not.toHaveProperty('scopes')
    expect(describeEnvironment).toHaveBeenCalledWith(TENANT)
  })
})

describe('GET /api/v1/me', () => {
  it('happy path under X-API-Key: returns {id,email}', async () => {
    getCurrentUser.mockResolvedValue({ id: TENANT, email: 'seb@test.local' })
    const res = await call('/api/v1/me', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: TENANT, email: 'seb@test.local' })
    expect(getCurrentUser).toHaveBeenCalledWith(TENANT)
  })

  it('happy path under a session Bearer: returns {id,email}', async () => {
    getCurrentUser.mockResolvedValue({ id: TENANT, email: 'seb@test.local' })
    const res = await call('/api/v1/me', { token: VALID_TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: TENANT, email: 'seb@test.local' })
  })
})

describe('GET /api/v1/version (deploy verification)', () => {
  it('happy path under X-API-Key: returns the running build version', async () => {
    const res = await call('/api/v1/version', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: SERVER_VERSION })
  })

  it('happy path under a session Bearer', async () => {
    const res = await call('/api/v1/version', { token: VALID_TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: SERVER_VERSION })
  })

  // The POINT of the endpoint is that a deploy probe can trust it. A version
  // that can drift from the published package version would let a probe confirm
  // a rollout that never happened, so assert against package.json itself rather
  // than against SERVER_VERSION (which would be tautological).
  it('reports exactly the apps/server package version — cannot skew at a release', async () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const res = await call('/api/v1/version', { key: VALID_KEY })
    expect(await res.json()).toEqual({ version: manifest.version })
  })
})

describe('GET /api/v1/export (GDPR portability, spec 015)', () => {
  const sampleExport = () => ({
    account: {
      id: TENANT,
      email: 'seb@test.local',
      emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    },
    memories: [
      {
        id: NEW_ID,
        memoryType: 'note',
        topic: 'export topic',
        content: 'export content',
        scope: 'personal',
        project: null,
        status: 'active',
        tags: ['t1'],
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: null,
        recordedAt: new Date('2026-01-01T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    facts: [
      {
        id: COMMIT_ID,
        memoryId: NEW_ID,
        subject: 's',
        predicate: 'p',
        value: 'v',
        confidence: 0.9,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: null,
        recordedAt: new Date('2026-01-01T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    commitments: [],
    scopes: [
      {
        id: NEW_ID,
        name: 'personal',
        aliases: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    edges: [
      {
        id: NEW_ID,
        fromId: NEW_ID,
        toId: COMMIT_ID,
        edgeType: 'supersedes',
        createdBy: 'user_api',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    memoryEvents: [
      {
        id: NEW_ID,
        memoryId: NEW_ID,
        eventKind: 'created',
        actorKind: 'user_api',
        payload: { note: 'imported' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    proposals: [
      {
        id: COMMIT_ID,
        fromId: NEW_ID,
        toId: COMMIT_ID,
        edgeType: 'supersedes',
        memoryType: 'note',
        similarity: 0.95,
        rationale: 'near-duplicate',
        status: 'proposed',
        decidedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    factProposals: [
      {
        id: COMMIT_ID,
        memoryId: NEW_ID,
        subject: 'deploy target',
        predicate: 'is',
        value: 'fly.io',
        confidence: 0.8,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: null,
        memoryType: 'note',
        rationale: 'extracted from the memory body',
        status: 'proposed',
        decidedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    agentSessions: [
      {
        id: NEW_ID,
        agent: 'codex',
        sessionId: 'sess-export',
        source: 'startup',
        project: '3ngram',
        scope: 'work',
        selector: { kind: 'all' },
        openedAt: new Date('2026-01-01T00:00:00.000Z'),
        closedAt: null,
        lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
        activationEpoch: 1,
        triageStatus: 'idle',
        triageAttemptId: null,
        lastTriagedEventIds: [],
        briefingDeliveredAt: null,
        briefedMemories: [{ id: NEW_ID, topic: 'ship v1.4.4', status: 'open' }],
        lastMessageExcerpt: 'we should ship the migration',
      },
    ],
    userBudgets: [
      {
        id: COMMIT_ID,
        capUsdOverride: '5.000000000000',
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2026-02-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ],
    llmUsage: [
      {
        id: NEW_ID,
        operation: 'memory.embed',
        model: 'text-embedding-3-small',
        inputTokens: 12,
        outputTokens: 0,
        costUsd: '0.000000240000',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    retrievalPolicy: {
      mode: 'default',
      defaultScope: 'work',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  })

  it('returns the caller dataset, calls core under the key tenant, sets a download header', async () => {
    exportUserData.mockResolvedValue(sampleExport())
    const res = await call('/api/v1/export', { key: VALID_KEY })
    expect(res.status).toBe(200)
    // The export is scoped to the AUTHENTICATED tenant only — no cross-user id leaks.
    expect(exportUserData).toHaveBeenCalledWith(TENANT, undefined)
    expect(exportUserData).toHaveBeenCalledTimes(1)
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="3ngram-export-\d{4}-\d{2}-\d{2}\.json"$/,
    )
    const body = (await res.json()) as {
      format: string
      account: { id: string; email: string }
      memories: Array<{ id: string; content: string }>
      facts: Array<{ value: string }>
      edges: Array<{ edgeType: string }>
      memoryEvents: Array<{ payload: unknown }>
      proposals: Array<{ rationale: string | null }>
      factProposals: Array<{ subject: string; value: string; rationale: string | null }>
      agentSessions: Array<{ agent: string; lastMessageExcerpt: string | null }>
      userBudgets: Array<{ capUsdOverride: string | null }>
      llmUsage: Array<{ operation: string; costUsd: string | null }>
      retrievalPolicy: {
        mode: string
        defaultScope: string | null
        updatedAt: string
      } | null
      counts: {
        memories: number
        facts: number
        commitments: number
        scopes: number
        edges: number
        memoryEvents: number
        proposals: number
        factProposals: number
        agentSessions: number
        userBudgets: number
        llmUsage: number
      }
    }
    expect(body.format).toBe('3ngram.account-export.v1')
    expect(body.account).toEqual({
      id: TENANT,
      email: 'seb@test.local',
      emailVerifiedAt: '2026-01-02T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    expect(body.memories[0]?.content).toBe('export content')
    expect(body.facts[0]?.value).toBe('v')
    // The OTHER tenant PII + the typed memory graph are present (completeness).
    expect(body.edges[0]?.edgeType).toBe('supersedes')
    expect(body.memoryEvents[0]?.payload).toEqual({ note: 'imported' })
    expect(body.proposals[0]?.rationale).toBe('near-duplicate')
    // Staged fact proposals are user content too — they are NOT `facts` rows,
    // so the facts section above does not cover them.
    expect(body.factProposals[0]?.subject).toBe('deploy target')
    expect(body.factProposals[0]?.value).toBe('fly.io')
    expect(body.factProposals[0]?.rationale).toBe('extracted from the memory body')
    expect(body.agentSessions[0]?.agent).toBe('codex')
    expect(body.agentSessions[0]?.lastMessageExcerpt).toBe('we should ship the migration')
    // Cost/usage rows are present — user-owned, RLS-scoped like the rest.
    expect(body.userBudgets[0]?.capUsdOverride).toBe('5.000000000000')
    expect(body.llmUsage[0]?.operation).toBe('memory.embed')
    expect(body.llmUsage[0]?.costUsd).toBe('0.000000240000')
    expect(body.retrievalPolicy).toEqual({
      mode: 'default',
      defaultScope: 'work',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    expect(body.counts).toEqual({
      memories: 1,
      facts: 1,
      commitments: 0,
      scopes: 1,
      edges: 1,
      memoryEvents: 1,
      proposals: 1,
      factProposals: 1,
      agentSessions: 1,
      userBudgets: 1,
      llmUsage: 1,
    })
  })

  it('publishes the runtime retrieval-policy shape in generated OpenAPI', () => {
    const spec = JSON.parse(
      readFileSync(new URL('../../../docs/api-reference/openapi.json', import.meta.url), 'utf8'),
    ) as {
      paths: {
        '/api/v1/export': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      required: string[]
                      properties: Record<
                        string,
                        {
                          anyOf?: Array<{
                            type?: string
                            required?: string[]
                            additionalProperties?: boolean
                            properties?: Record<string, unknown>
                          }>
                        }
                      >
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    const schema =
      spec.paths['/api/v1/export'].get.responses['200'].content['application/json'].schema
    expect(schema.required).toContain('retrievalPolicy')
    expect(schema.required).toContain('agentSessions')
    const policy = schema.properties.retrievalPolicy
    const objectBranch = policy?.anyOf?.find((branch) => branch.type === 'object')
    expect(objectBranch).toMatchObject({
      additionalProperties: false,
      required: ['mode', 'defaultScope', 'updatedAt'],
    })
    expect(Object.keys(objectBranch?.properties ?? {}).sort()).toEqual([
      'defaultScope',
      'mode',
      'updatedAt',
    ])
  })

  it('works under a session Bearer too (binds the same tenant)', async () => {
    exportUserData.mockResolvedValue(sampleExport())
    const res = await call('/api/v1/export', { token: VALID_TOKEN })
    expect(res.status).toBe(200)
    expect(exportUserData).toHaveBeenCalledWith(TENANT, undefined)
  })
})

describe('DELETE /api/v1/account (self-serve deletion, spec 015)', () => {
  const erased = {
    alreadyErased: false,
    memories: 2,
    facts: 1,
    commitments: 0,
    proposals: 0,
    factProposals: 3,
    agentSessions: 1,
    sessionsDeleted: 1,
    apiKeysRevoked: 1,
    oauthTokensRevoked: 0,
    oauthCodesDeleted: 1,
    passwordResetTokensDeleted: 1,
    emailVerificationTokensDeleted: 1,
  }

  it('happy path: validates confirm, calls core deleteAccount under the key tenant', async () => {
    deleteAccount.mockResolvedValue({ alreadyDeleted: false, erased })
    const res = await call('/api/v1/account', {
      method: 'DELETE',
      key: VALID_KEY,
      body: { confirm: true },
    })
    expect(res.status).toBe(200)
    // Scoped to the AUTHENTICATED tenant only.
    expect(deleteAccount).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ now: expect.any(Date) }),
    )
    const body = (await res.json()) as {
      deleted: boolean
      alreadyDeleted: boolean
      erased: {
        memories: number
        factProposals: number
        agentSessions: number
        sessionsDeleted: number
      }
    }
    expect(body.deleted).toBe(true)
    expect(body.alreadyDeleted).toBe(false)
    expect(body.erased.memories).toBe(2)
    expect(body.erased.sessionsDeleted).toBe(1)
    // Staged fact proposals are erased too, and the receipt must report them —
    // the count is echoed, not dropped on the way through the transport.
    expect(body.erased.factProposals).toBe(3)
    expect(body.erased.agentSessions).toBe(1)
  })

  it('400s without an explicit { confirm: true } (no silent destructive call)', async () => {
    const res = await call('/api/v1/account', { method: 'DELETE', key: VALID_KEY, body: {} })
    expect(res.status).toBe(400)
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it('400s when confirm is false', async () => {
    const res = await call('/api/v1/account', {
      method: 'DELETE',
      key: VALID_KEY,
      body: { confirm: false },
    })
    expect(res.status).toBe(400)
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it('works under a session Bearer too (binds the same tenant)', async () => {
    deleteAccount.mockResolvedValue({
      alreadyDeleted: true,
      erased: { ...erased, alreadyErased: true },
    })
    const res = await call('/api/v1/account', {
      method: 'DELETE',
      token: VALID_TOKEN,
      body: { confirm: true },
    })
    expect(res.status).toBe(200)
    expect(deleteAccount).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ now: expect.any(Date) }),
    )
  })
})

describe('GET /api/v1/scopes', () => {
  it('happy path: empty list returns {scopes:[], count:0}', async () => {
    listScopes.mockResolvedValue([])
    const res = await call('/api/v1/scopes', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scopes: [], count: 0 })
    expect(listScopes).toHaveBeenCalledWith(TENANT)
  })
})

// GET /api/v1/agent-sessions/:sessionRunId/events: the typed provenance read
// (docs/concepts/session-continuity.mdx layer 3). Thin-adapter contract only —
// the paging, the ceiling and the payload projection are core/db's job; the
// route validates, calls core, and shapes ISO timestamps.
describe('GET /api/v1/agent-sessions/:sessionRunId/events', () => {
  const RUN = crypto.randomUUID()
  const EVENT = crypto.randomUUID()
  const events = (nextCursor?: string) => ({
    items: [
      {
        id: EVENT,
        memoryId: NEW_ID,
        eventKind: 'create',
        actorKind: 'user_mcp',
        sessionRunId: RUN,
        createdAt: new Date('2026-08-21T12:00:00.000Z'),
      },
    ],
    nextCursor,
    truncated: false,
  })

  it('happy path: shapes items and defaults the limit', async () => {
    listSessionEvents.mockResolvedValue(events())
    const res = await call(`/api/v1/agent-sessions/${RUN}/events`, { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      items: [
        {
          id: EVENT,
          memoryId: NEW_ID,
          eventKind: 'create',
          actorKind: 'user_mcp',
          sessionRunId: RUN,
          createdAt: '2026-08-21T12:00:00.000Z',
        },
      ],
      truncated: false,
    })
    // No nextCursor key at all on a final page — not a null.
    expect(
      await (await call(`/api/v1/agent-sessions/${RUN}/events`, { key: VALID_KEY })).text(),
    ).not.toContain('nextCursor')
    expect(listSessionEvents).toHaveBeenCalledWith(TENANT, RUN, { limit: 50 })
  })

  it('passes a validated cursor and coerced limit through to core', async () => {
    listSessionEvents.mockResolvedValue(events(EVENT))
    const res = await call(`/api/v1/agent-sessions/${RUN}/events?cursor=${EVENT}&limit=2`, {
      key: VALID_KEY,
    })
    expect(res.status).toBe(200)
    expect((await res.json()).nextCursor).toBe(EVENT)
    expect(listSessionEvents).toHaveBeenCalledWith(TENANT, RUN, { cursor: EVENT, limit: 2 })
  })

  it('400s a malformed cursor and an out-of-range limit', async () => {
    for (const query of ['?cursor=nope', '?limit=0', '?limit=101', '?limit=abc', '?limit=1.5']) {
      const res = await call(`/api/v1/agent-sessions/${RUN}/events${query}`, { key: VALID_KEY })
      expect(res.status, query).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
    }
    expect(listSessionEvents).not.toHaveBeenCalled()
  })

  it('400s an unknown query key instead of silently restarting at page 1', async () => {
    // The route hands req.query through WHOLE, so .strict() sees the typo. If it
    // rebuilt a { cursor, limit } object the misspelling would vanish and the
    // caller would get page 1 again — a duplicate-results bug, not a 400.
    for (const query of ['?cursro=x', `?cursor=${EVENT}&offset=1`, '?limit=2&projection=compact']) {
      const res = await call(`/api/v1/agent-sessions/${RUN}/events${query}`, { key: VALID_KEY })
      expect(res.status, query).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
    }
    expect(listSessionEvents).not.toHaveBeenCalled()
  })

  it('400s a repeated param (Express yields an array) rather than crashing', async () => {
    for (const query of ['?limit=1&limit=2', `?cursor=${EVENT}&cursor=${EVENT}`]) {
      const res = await call(`/api/v1/agent-sessions/${RUN}/events${query}`, { key: VALID_KEY })
      expect(res.status, query).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
    }
    expect(listSessionEvents).not.toHaveBeenCalled()
  })

  it('400s a malformed run id before core is reached', async () => {
    const res = await call('/api/v1/agent-sessions/not-a-uuid/events', { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_input' })
    expect(listSessionEvents).not.toHaveBeenCalled()
  })

  it('canonicalizes an uppercase run id so the run’s events are returned, not an empty page', async () => {
    // The reader compares payload->>'sessionRunId' as TEXT. An uppercase id
    // clears the uuid-typed ownership check, so without canonicalization at the
    // boundary core would be handed the uppercase spelling and return nothing.
    listSessionEvents.mockResolvedValue(events())
    const res = await call(`/api/v1/agent-sessions/${RUN.toUpperCase()}/events`, { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect((await res.json()).items).toHaveLength(1)
    expect(listSessionEvents).toHaveBeenCalledWith(TENANT, RUN, { limit: 50 })
  })

  it('maps a foreign/unknown run id to 400 invalid_input, matching the write path', async () => {
    // Deliberately NOT 404: UnknownSessionRunError is the same error the native
    // write path raises for the same mistake, and rest/errors.ts already maps it
    // to 400. Consistency with the write path beats REST purism here.
    listSessionEvents.mockRejectedValue(new UnknownSessionRunError(RUN))
    const res = await call(`/api/v1/agent-sessions/${RUN}/events`, { key: VALID_KEY })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_input' })
  })
})

// The hook-facing session lifecycle (docs/concepts/session-continuity.mdx
// layers 1, 4, 6; issue #166 step 5a). Thin-adapter contract only — the lease
// arithmetic, the epoch fence and the idempotency rules are core/db's job and
// are pinned in packages/db. Here: the natural key rides the BODY, unknown keys
// are 400, the typed errors map to 404/409, and timestamps serialise to ISO.
describe('agent-session lifecycle routes', () => {
  const RUN = crypto.randomUUID()
  const OPENED = new Date('2026-08-23T10:00:00.000Z')
  const SEEN = new Date('2026-08-23T10:05:00.000Z')
  const CLOSED = new Date('2026-08-23T10:09:00.000Z')
  const KEY = { agent: 'claude-code', sessionId: 'conv-abc' }

  const row = (over: Record<string, unknown> = {}) => ({
    id: RUN,
    agent: KEY.agent,
    sessionId: KEY.sessionId,
    source: 'startup',
    project: '3ngram',
    scope: 'work',
    selector: { kind: 'all' },
    activationEpoch: 1,
    openedAt: OPENED,
    closedAt: null,
    lastSeenAt: SEEN,
    briefingDeliveredAt: OPENED,
    briefedMemories: [],
    ...over,
  })

  describe('POST /api/v1/agent-sessions/open', () => {
    it('inserts on startup and echoes the resolved state', async () => {
      openAgentSession.mockResolvedValue({ row: row(), created: true, reopened: false })
      const body = {
        agent: KEY.agent,
        sessionId: KEY.sessionId,
        source: 'startup',
        project: '3ngram',
        scope: 'work',
        briefedMemories: [{ id: NEW_ID, topic: 'ship 5a', status: 'open' }],
      }
      const res = await call('/api/v1/agent-sessions/open', {
        method: 'POST',
        key: VALID_KEY,
        body,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        sessionRunId: RUN,
        activationEpoch: 1,
        source: 'startup',
        created: true,
        reopened: false,
        openedAt: OPENED.toISOString(),
        lastSeenAt: SEEN.toISOString(),
        briefingDeliveredAt: OPENED.toISOString(),
      })
      // The selector default is applied at the ONE boundary, so core sees it.
      expect(openAgentSession).toHaveBeenCalledWith(TENANT, {
        ...body,
        selector: { kind: 'all' },
      })
    })

    it('reports a resume that reopened the row and advanced the epoch', async () => {
      openAgentSession.mockResolvedValue({
        row: row({ activationEpoch: 4 }),
        created: false,
        reopened: true,
      })
      const res = await call('/api/v1/agent-sessions/open', {
        method: 'POST',
        key: VALID_KEY,
        body: { agent: KEY.agent, sessionId: KEY.sessionId, source: 'resume' },
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toMatchObject({ activationEpoch: 4, created: false, reopened: true })
      expect(json.source).toBe('resume')
    })

    it('serialises a never-briefed row as briefingDeliveredAt null', async () => {
      openAgentSession.mockResolvedValue({
        row: row({ briefingDeliveredAt: null }),
        created: true,
        reopened: false,
      })
      const res = await call('/api/v1/agent-sessions/open', {
        method: 'POST',
        key: VALID_KEY,
        body: { agent: KEY.agent, sessionId: KEY.sessionId, source: 'resume' },
      })
      expect((await res.json()).briefingDeliveredAt).toBeNull()
    })

    it('409s a startup reusing the natural key with changed params', async () => {
      // "request token; reuse with changed params is 409" — the natural key IS
      // the request token, so a recycled conversation id cannot silently
      // overwrite the row a live session is leasing.
      openAgentSession.mockRejectedValue(new AgentSessionParamsConflictError(KEY))
      const res = await call('/api/v1/agent-sessions/open', {
        method: 'POST',
        key: VALID_KEY,
        body: { agent: KEY.agent, sessionId: KEY.sessionId, source: 'startup', project: 'other' },
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'conflict' })
    })

    it('400s a bad source, a non-kebab agent and an over-cap briefing list', async () => {
      const bodies = [
        { agent: KEY.agent, sessionId: KEY.sessionId, source: 'compact' },
        { agent: 'Claude Code', sessionId: KEY.sessionId, source: 'startup' },
        { agent: KEY.agent, sessionId: '', source: 'startup' },
        {
          agent: KEY.agent,
          sessionId: KEY.sessionId,
          source: 'startup',
          briefedMemories: Array.from({ length: 101 }, () => ({
            id: NEW_ID,
            topic: 't',
            status: 'open',
          })),
        },
        {
          agent: KEY.agent,
          sessionId: KEY.sessionId,
          source: 'startup',
          briefedMemories: [{ id: 'not-a-uuid', topic: 't', status: 'open' }],
        },
      ]
      for (const body of bodies) {
        const res = await call('/api/v1/agent-sessions/open', {
          method: 'POST',
          key: VALID_KEY,
          body,
        })
        expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400)
        expect(await res.json()).toEqual({ error: 'invalid_input' })
      }
      expect(openAgentSession).not.toHaveBeenCalled()
    })

    it('400s an unknown body key rather than silently dropping it', async () => {
      // The body is parsed WHOLE through the strict schema: a client-supplied
      // `briefingDeliveredAt` or `activationEpoch` is rejected, not ignored —
      // the server stamps the first and owns the second.
      for (const extra of [
        { briefingDeliveredAt: OPENED.toISOString() },
        { activationEpoch: 7 },
        { sessionRunId: RUN },
        { sessionid: KEY.sessionId },
      ]) {
        const res = await call('/api/v1/agent-sessions/open', {
          method: 'POST',
          key: VALID_KEY,
          body: { agent: KEY.agent, sessionId: KEY.sessionId, source: 'startup', ...extra },
        })
        expect(res.status, JSON.stringify(extra)).toBe(400)
        expect(await res.json()).toEqual({ error: 'invalid_input' })
      }
      expect(openAgentSession).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/v1/agent-sessions/close', () => {
    it('closes by natural key and reports the close timestamp', async () => {
      closeAgentSession.mockResolvedValue({
        row: row({ closedAt: CLOSED }),
        closedAt: CLOSED,
        alreadyClosed: false,
      })
      const res = await call('/api/v1/agent-sessions/close', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        sessionRunId: RUN,
        activationEpoch: 1,
        closedAt: CLOSED.toISOString(),
        alreadyClosed: false,
      })
      expect(closeAgentSession).toHaveBeenCalledWith(TENANT, KEY)
    })

    it('is idempotent: a repeat close echoes the FIRST timestamp', async () => {
      closeAgentSession.mockResolvedValue({
        row: row({ closedAt: CLOSED }),
        closedAt: CLOSED,
        alreadyClosed: true,
      })
      const res = await call('/api/v1/agent-sessions/close', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(await res.json()).toMatchObject({
        alreadyClosed: true,
        closedAt: CLOSED.toISOString(),
      })
    })

    it('reports core closedAt verbatim, never a value invented from another column', async () => {
      // The route used to fall back to `lastSeenAt` when `row.closedAt` was
      // null, which could publish a close timestamp for a row nothing closed.
      closeAgentSession.mockResolvedValue({
        row: row({ closedAt: null, lastSeenAt: SEEN }),
        closedAt: CLOSED,
        alreadyClosed: false,
      })
      const res = await call('/api/v1/agent-sessions/close', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect((await res.json()).closedAt).toBe(CLOSED.toISOString())
    })

    it('404s a natural key this tenant owns no row for', async () => {
      closeAgentSession.mockRejectedValue(new AgentSessionNotFoundError(KEY))
      const res = await call('/api/v1/agent-sessions/close', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })

    it('400s an activationEpoch on the body — close must never take one', async () => {
      // SessionEnd has the conversation id and nothing else; looking the epoch
      // up would close a resumed activation.
      const res = await call('/api/v1/agent-sessions/close', {
        method: 'POST',
        key: VALID_KEY,
        body: { ...KEY, activationEpoch: 2 },
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
      expect(closeAgentSession).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/v1/agent-sessions/heartbeat', () => {
    it('refreshes the lease and reports no resurrection for a live row', async () => {
      heartbeatAgentSession.mockResolvedValue({ row: row(), resurrected: false })
      const res = await call('/api/v1/agent-sessions/heartbeat', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        sessionRunId: RUN,
        activationEpoch: 1,
        lastSeenAt: SEEN.toISOString(),
        resurrected: false,
      })
    })

    it('passes the bounded excerpt through and reports a resurrection', async () => {
      heartbeatAgentSession.mockResolvedValue({
        row: row({ activationEpoch: 2 }),
        resurrected: true,
      })
      const body = { ...KEY, lastMessageExcerpt: 'shipped the router' }
      const res = await call('/api/v1/agent-sessions/heartbeat', {
        method: 'POST',
        key: VALID_KEY,
        body,
      })
      expect(await res.json()).toMatchObject({ resurrected: true, activationEpoch: 2 })
      expect(heartbeatAgentSession).toHaveBeenCalledWith(TENANT, body)
    })

    it('400s an excerpt past the cap — the hook truncates locally, the server does not', async () => {
      const res = await call('/api/v1/agent-sessions/heartbeat', {
        method: 'POST',
        key: VALID_KEY,
        body: { ...KEY, lastMessageExcerpt: 'x'.repeat(4001) },
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
      expect(heartbeatAgentSession).not.toHaveBeenCalled()
    })

    it('accepts an excerpt exactly at the cap', async () => {
      heartbeatAgentSession.mockResolvedValue({ row: row(), resurrected: false })
      const res = await call('/api/v1/agent-sessions/heartbeat', {
        method: 'POST',
        key: VALID_KEY,
        body: { ...KEY, lastMessageExcerpt: 'x'.repeat(4000) },
      })
      expect(res.status).toBe(200)
    })

    it('404s an unknown natural key', async () => {
      heartbeatAgentSession.mockRejectedValue(new AgentSessionNotFoundError(KEY))
      const res = await call('/api/v1/agent-sessions/heartbeat', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })
  })

  // The Stop-nudge handshake (issue #166 step 7a). Thin-adapter contract only:
  // the entry rule, the debounce arithmetic, the two watermarks and the
  // attempt-id fence are core/db's and are pinned in packages/db. Here: strict
  // parsing, the armed / armed-false / 404 / 409 shapes, and that the router
  // passes validated args straight through.
  describe('POST /api/v1/agent-sessions/triage/begin', () => {
    const ATTEMPT = crypto.randomUUID()

    it('returns the armed attempt so the hook knows to inject', async () => {
      beginAgentSessionTriage.mockResolvedValue({
        sessionRunId: RUN,
        armed: true,
        attemptId: ATTEMPT,
        triageStatus: 'pending',
      })
      const res = await call('/api/v1/agent-sessions/triage/begin', {
        method: 'POST',
        key: VALID_KEY,
        body: { ...KEY, turnCount: 4 },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        sessionRunId: RUN,
        armed: true,
        attemptId: ATTEMPT,
        triageStatus: 'pending',
      })
      expect(beginAgentSessionTriage).toHaveBeenCalledWith(
        TENANT,
        { ...KEY, turnCount: 4 },
        expect.objectContaining({
          thresholds: expect.objectContaining({ minTurns: expect.any(Number) }),
        }),
      )
    })

    it('is a 200 with armed:false and a reason when the server declines', async () => {
      // "No nudge this turn" is the expected answer on most Stops, so it is not
      // an error status — `reason` is the content-free tag that says which rule
      // declined, and `attemptId` is simply absent.
      beginAgentSessionTriage.mockResolvedValue({
        sessionRunId: RUN,
        armed: false,
        triageStatus: 'idle',
        reason: 'debounce',
      })
      const res = await call('/api/v1/agent-sessions/triage/begin', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({
        sessionRunId: RUN,
        armed: false,
        triageStatus: 'idle',
        reason: 'debounce',
      })
      expect('attemptId' in json).toBe(false)
    })

    it('hands back the in-flight attempt on a pending decline', async () => {
      // armed:false + attemptId is the "finish it, do not inject again" answer.
      beginAgentSessionTriage.mockResolvedValue({
        sessionRunId: RUN,
        armed: false,
        attemptId: ATTEMPT,
        triageStatus: 'pending',
        reason: 'pending',
      })
      const res = await call('/api/v1/agent-sessions/triage/begin', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(await res.json()).toMatchObject({ armed: false, attemptId: ATTEMPT })
    })

    it('404s an unknown natural key rather than declining', async () => {
      // Stop never creates the row; a decline would hide a broken SessionStart.
      beginAgentSessionTriage.mockRejectedValue(new AgentSessionNotFoundError(KEY))
      const res = await call('/api/v1/agent-sessions/triage/begin', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })

    it('forwards the body VERBATIM — core is the single validation boundary', async () => {
      // The route does not pre-parse (hard rule 2, the `remember` contract), so
      // the thin-adapter assertion here is that nothing is reshaped, dropped or
      // defaulted on the way through. The strict-parsing rules themselves are
      // pinned where the parse lives: packages/schema/test/agent-sessions.test.ts.
      beginAgentSessionTriage.mockResolvedValue({
        sessionRunId: RUN,
        armed: false,
        triageStatus: 'idle',
        reason: 'debounce',
      })
      const body = { ...KEY, turnCount: 0 }
      await call('/api/v1/agent-sessions/triage/begin', { method: 'POST', key: VALID_KEY, body })
      expect(beginAgentSessionTriage).toHaveBeenCalledWith(TENANT, body, expect.anything())
    })

    it('400s a body core rejects', async () => {
      // End to end the behaviour is unchanged by moving the parse: core throws a
      // ZodError and the shared mapper still returns 400 invalid_input.
      beginAgentSessionTriage.mockRejectedValue(new ZodError([]))
      const res = await call('/api/v1/agent-sessions/triage/begin', {
        method: 'POST',
        key: VALID_KEY,
        body: { ...KEY, turnCount: -1 },
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
    })
  })

  describe('POST /api/v1/agent-sessions/triage/complete', () => {
    const ATTEMPT = crypto.randomUUID()
    const BODY = { ...KEY, attemptId: ATTEMPT }

    it('reports the outcome as counts only', async () => {
      completeAgentSessionTriage.mockResolvedValue({
        sessionRunId: RUN,
        triageStatus: 'completed',
        eventCount: 3,
        sinceBeginCount: 2,
        truncated: false,
      })
      const res = await call('/api/v1/agent-sessions/triage/complete', {
        method: 'POST',
        key: VALID_KEY,
        body: BODY,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        sessionRunId: RUN,
        triageStatus: 'completed',
        eventCount: 3,
        sinceBeginCount: 2,
        truncated: false,
      })
      expect(completeAgentSessionTriage).toHaveBeenCalledWith(TENANT, BODY)
    })

    it('reports a zero-write continuation as expired', async () => {
      completeAgentSessionTriage.mockResolvedValue({
        sessionRunId: RUN,
        triageStatus: 'expired',
        eventCount: 1,
        sinceBeginCount: 0,
        truncated: false,
      })
      const res = await call('/api/v1/agent-sessions/triage/complete', {
        method: 'POST',
        key: VALID_KEY,
        body: BODY,
      })
      expect(await res.json()).toMatchObject({ triageStatus: 'expired', sinceBeginCount: 0 })
    })

    it('409s a stale attempt', async () => {
      // A crashed hook, a second Stop, or a closer that re-claimed the row after
      // the lease expired mid-handshake. The caller must learn its attempt is
      // over rather than retry forever.
      completeAgentSessionTriage.mockRejectedValue(
        new AgentSessionTriageConflictError(KEY, ATTEMPT),
      )
      const res = await call('/api/v1/agent-sessions/triage/complete', {
        method: 'POST',
        key: VALID_KEY,
        body: BODY,
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'conflict' })
    })

    it('404s an unknown natural key', async () => {
      completeAgentSessionTriage.mockRejectedValue(new AgentSessionNotFoundError(KEY))
      const res = await call('/api/v1/agent-sessions/triage/complete', {
        method: 'POST',
        key: VALID_KEY,
        body: BODY,
      })
      expect(res.status).toBe(404)
    })

    it('forwards the body VERBATIM and 400s what core rejects', async () => {
      // Same pass-through contract as `begin`: core owns the parse, so the
      // route's job is to hand it the body unchanged and map the throw. The
      // attemptId/strictness rules live in the schema suite.
      completeAgentSessionTriage.mockResolvedValue({
        sessionRunId: RUN,
        triageStatus: 'expired',
        eventCount: 0,
        sinceBeginCount: 0,
        truncated: false,
      })
      await call('/api/v1/agent-sessions/triage/complete', {
        method: 'POST',
        key: VALID_KEY,
        body: BODY,
      })
      expect(completeAgentSessionTriage).toHaveBeenCalledWith(TENANT, BODY)

      completeAgentSessionTriage.mockRejectedValue(new ZodError([]))
      const res = await call('/api/v1/agent-sessions/triage/complete', {
        method: 'POST',
        key: VALID_KEY,
        body: KEY,
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
    })
  })
})

// GET /api/v1/prompts/debrief — the MCP debrief registrar over REST, so a Stop
// hook can inject the SAME words without an MCP client.
describe('GET /api/v1/prompts/debrief', () => {
  const KEY = { agent: 'claude-code', sessionId: 'conv-abc' }

  it('renders the prompt with no facets and no session lookup', async () => {
    const res = await call('/api/v1/prompts/debrief', { key: VALID_KEY })
    expect(res.status).toBe(200)
    const { prompt } = await res.json()
    expect(prompt).toContain('remember')
    expect(prompt).toContain('resolve')
    expect(getAgentSession).not.toHaveBeenCalled()
  })

  it('inlines the run briefed_memories as an id -> topic/status mapping', async () => {
    getAgentSession.mockResolvedValue({
      id: crypto.randomUUID(),
      briefedMemories: [{ id: NEW_ID, topic: 'ship step 5a', status: 'open' }],
    })
    const res = await call(
      `/api/v1/prompts/debrief?scope=work&project=3ngram&agent=${KEY.agent}&sessionId=${KEY.sessionId}`,
      { key: VALID_KEY },
    )
    expect(res.status).toBe(200)
    const { prompt } = await res.json()
    expect(getAgentSession).toHaveBeenCalledWith(TENANT, KEY)
    expect(prompt).toContain(NEW_ID)
    expect(prompt).toContain('ship step 5a')
    // Facets and briefed rows ride a fenced JSON block, never an imperative
    // sentence — projectSchema permits a directory name that reads as a command.
    const fenced = /```json\n([\s\S]*?)\n```/.exec(prompt)
    expect(fenced).not.toBeNull()
    expect(JSON.parse((fenced as RegExpExecArray)[1] as string)).toEqual({
      scope: 'work',
      project: '3ngram',
      briefedCommitments: [{ id: NEW_ID, topic: 'ship step 5a', status: 'open' }],
    })
  })

  it('404s a natural key this tenant owns no row for', async () => {
    getAgentSession.mockRejectedValue(new AgentSessionNotFoundError(KEY))
    const res = await call(
      `/api/v1/prompts/debrief?agent=${KEY.agent}&sessionId=${KEY.sessionId}`,
      { key: VALID_KEY },
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('400s half a natural key — the two params move together', async () => {
    for (const query of ['?agent=claude-code', '?sessionId=conv-abc']) {
      const res = await call(`/api/v1/prompts/debrief${query}`, { key: VALID_KEY })
      expect(res.status, query).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
    }
    expect(getAgentSession).not.toHaveBeenCalled()
  })

  it('400s an unknown or repeated query key rather than ignoring it', async () => {
    for (const query of ['?scopes=work', '?scope=Work%20Notes', '?scope=work&scope=personal']) {
      const res = await call(`/api/v1/prompts/debrief${query}`, { key: VALID_KEY })
      expect(res.status, query).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_input' })
    }
  })

  // The facets fall back to the ROW when the query omits them. The hook sends
  // only the natural key precisely because it cannot know these values: a
  // retrieval policy may have narrowed a `kind=all` briefing to a scope that
  // exists nowhere in the hook's environment, and an omitted `scope` on the
  // resulting `remember` would default to `personal` — filing the debrief
  // outside the briefing that surfaced the work.
  it('resolves scope and project from the session row', async () => {
    getAgentSession.mockResolvedValue({
      id: crypto.randomUUID(),
      scope: 'client-acme',
      project: '3ngram',
      briefedMemories: [{ id: NEW_ID, topic: 'ship step 7b', status: 'open' }],
    })
    const res = await call(
      `/api/v1/prompts/debrief?agent=${KEY.agent}&sessionId=${KEY.sessionId}`,
      { key: VALID_KEY },
    )
    expect(res.status).toBe(200)
    const { prompt } = await res.json()
    const fenced = /```json\n([\s\S]*?)\n```/.exec(prompt)
    expect(JSON.parse((fenced as RegExpExecArray)[1] as string)).toEqual({
      scope: 'client-acme',
      project: '3ngram',
      briefedCommitments: [{ id: NEW_ID, topic: 'ship step 7b', status: 'open' }],
    })
  })

  // An EXPLICIT query value still wins: this route is not hook-only, and a
  // caller that names a facet has answered the question itself.
  it('lets an explicit query facet override the row', async () => {
    getAgentSession.mockResolvedValue({
      id: crypto.randomUUID(),
      scope: 'client-acme',
      project: '3ngram',
      briefedMemories: [],
    })
    const res = await call(
      `/api/v1/prompts/debrief?scope=work&agent=${KEY.agent}&sessionId=${KEY.sessionId}`,
      { key: VALID_KEY },
    )
    expect(res.status).toBe(200)
    const { prompt } = await res.json()
    const fenced = /```json\n([\s\S]*?)\n```/.exec(prompt)
    expect(JSON.parse((fenced as RegExpExecArray)[1] as string)).toEqual({
      scope: 'work',
      project: '3ngram',
      briefedCommitments: [],
    })
  })

  // A row with NULL facets renders the keys ABSENT rather than `null`: the
  // prompt reads an absent key as "use the one the work belonged to", while a
  // null would be a value the model might copy into a tool argument.
  it('omits facets the row does not carry', async () => {
    getAgentSession.mockResolvedValue({
      id: crypto.randomUUID(),
      scope: null,
      project: null,
      briefedMemories: [],
    })
    const res = await call(
      `/api/v1/prompts/debrief?agent=${KEY.agent}&sessionId=${KEY.sessionId}`,
      { key: VALID_KEY },
    )
    expect(res.status).toBe(200)
    const { prompt } = await res.json()
    const fenced = /```json\n([\s\S]*?)\n```/.exec(prompt)
    expect(JSON.parse((fenced as RegExpExecArray)[1] as string)).toEqual({
      briefedCommitments: [],
    })
  })
})

// GET /api/v1/budget: the caller's budget status (effective cap + consumed).
// 503 when budget enforcement is unwired; the shape mirrors
// budgetStatusResponseSchema with ISO period strings.
describe('GET /api/v1/budget', () => {
  const wiredBudget = {
    resolveLimits: async () => ({}),
    config: { defaultCapUsd: 10, defaultWindowDays: 30 },
  } as unknown as Parameters<typeof restRouter>[0]['budget']

  async function withBudgetApp(run: (url: string) => Promise<void>): Promise<void> {
    const budgetServer = buildApp(
      fakeGateway as unknown as Parameters<typeof restRouter>[0]['gateway'],
      wiredBudget,
    ).listen(0)
    await new Promise<void>((resolve) => budgetServer.once('listening', resolve))
    const address = budgetServer.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    try {
      await run(`http://127.0.0.1:${address.port}`)
    } finally {
      await new Promise<void>((resolve, reject) => {
        budgetServer.close((err) => (err === undefined ? resolve() : reject(err)))
      })
    }
  }

  it('503s budget_unavailable when budget enforcement is not wired', async () => {
    // The shared contract server wires NO budget — the self-host/back-compat path.
    const res = await call('/api/v1/budget', { key: VALID_KEY })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'budget_unavailable' })
    expect(getBudgetStatus).not.toHaveBeenCalled()
  })

  it('returns the budget status with ISO period strings', async () => {
    getBudgetStatus.mockResolvedValue({
      effectiveCapUsd: 25,
      consumedUsd: 3.5,
      capUsdOverride: null,
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
    })
    await withBudgetApp(async (url) => {
      const res = await fetch(`${url}/api/v1/budget`, { headers: { 'x-api-key': VALID_KEY } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        effectiveCapUsd: 25,
        consumedUsd: 3.5,
        capUsdOverride: null,
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-08-01T00:00:00.000Z',
      })
      expect(getBudgetStatus).toHaveBeenCalledWith(wiredBudget, TENANT)
    })
  })

  it('returns null period bounds for the self-host shape', async () => {
    getBudgetStatus.mockResolvedValue({
      effectiveCapUsd: 10,
      consumedUsd: 0,
      capUsdOverride: null,
      periodStart: null,
      periodEnd: null,
    })
    await withBudgetApp(async (url) => {
      const res = await fetch(`${url}/api/v1/budget`, { headers: { 'x-api-key': VALID_KEY } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        effectiveCapUsd: 10,
        consumedUsd: 0,
        capUsdOverride: null,
        periodStart: null,
        periodEnd: null,
      })
    })
  })
})

// ACCESS GATE ENFORCEMENT: the previously-ungated read + mutation surfaces now
// consult the injected access gate BEFORE the db op. A denying gate must reject
// the request (403 access_denied) AND the core fn must NEVER be reached — proving
// the gate blocks BEFORE the db op. Under the self-host allowAllAccess every assert
// is empty, so this is a no-op there (the rest of the suite, which wires no access
// gate, is the back-compat proof that an unwired gate changes nothing).
describe('access gate enforcement (#429)', () => {
  // An access gate that DENIES both reads and writes: assertRead + assertWrite
  // throw AccessDeniedError, which rest/errors.ts maps to 403 access_denied.
  const denyingAccess = {
    assertRead: async () => {
      throw new AccessDeniedError()
    },
    assertWrite: async () => {
      throw new AccessDeniedError()
    },
  } as unknown as Parameters<typeof restRouter>[0]['access']
  // A wired budget so /api/v1/budget serves under the denying gate (it is
  // deliberately ungated); getBudgetStatus is mocked, so the object is inert.
  const gatedBudget = {
    resolveLimits: async () => ({}),
    config: { defaultCapUsd: 1000, defaultWindowDays: 30 },
  } as unknown as Parameters<typeof restRouter>[0]['budget']

  let gatedServer: Server
  let gatedUrl: string

  beforeAll(async () => {
    gatedServer = buildApp(
      fakeGateway as unknown as Parameters<typeof restRouter>[0]['gateway'],
      gatedBudget,
      denyingAccess,
    ).listen(0)
    await new Promise<void>((resolve) => gatedServer.once('listening', resolve))
    const address = gatedServer.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    gatedUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      gatedServer.close((err) => (err === undefined ? resolve() : reject(err)))
    })
  })

  async function callGated(path: string, opts: CallOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.key !== undefined) headers['x-api-key'] = opts.key
    return fetch(`${gatedUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  }

  // [surface, method, path, body, core spy] — EVERY tenant-memory read
  // (assertRead) and state-changing op (assertWrite) newly gated by the access
  // gate. The set is exhaustive over the router's memory surfaces; /me (account
  // identity) and /budget (cost status) are deliberately ungated (see router
  // comments) and so are NOT in this table.
  const GATED: Array<[string, string, string, unknown, ReturnType<typeof vi.fn>]> = [
    ['memories.list (read)', 'GET', '/api/v1/memories', undefined, listMemories],
    ['memories.inspect (read)', 'GET', `/api/v1/memories/${NEW_ID}`, undefined, getMemoryById],
    [
      'memories.history (read)',
      'GET',
      `/api/v1/memories/${NEW_ID}/history`,
      undefined,
      getMemoryHistory,
    ],
    ['memories.facets (read)', 'GET', '/api/v1/memories/facets', undefined, listMemoryFacets],
    ['scopes.list (read)', 'GET', '/api/v1/scopes', undefined, listScopes],
    ['search (read)', 'POST', '/api/v1/search', { query: 'find me' }, search],
    [
      'dashboard.search (read)',
      'POST',
      '/api/v1/dashboard/search',
      { query: 'find me' },
      searchDashboardPage,
    ],
    ['facts (read)', 'GET', '/api/v1/facts', undefined, getFacts],
    ['briefing (read)', 'GET', '/api/v1/briefing?kind=all', undefined, briefing],
    ['proposals.list (read)', 'GET', '/api/v1/proposals', undefined, listProposals],
    ['stats (read)', 'GET', '/api/v1/stats', undefined, describeEnvironment],
    ['export (read)', 'GET', '/api/v1/export', undefined, exportUserData],
    [
      'resolve (write)',
      'POST',
      `/api/v1/memories/${NEW_ID}/resolve`,
      { status: 'resolved' },
      resolveByMemoryId,
    ],
    ['archive (write)', 'POST', `/api/v1/memories/${NEW_ID}/archive`, {}, archiveMemory],
    ['apply (write)', 'POST', `/api/v1/proposals/${NEW_ID}/apply`, {}, applyProposal],
    ['reject (write)', 'POST', `/api/v1/proposals/${NEW_ID}/reject`, {}, rejectProposal],
  ]

  it.each(
    GATED,
  )('denies %s with 403 access_denied and never reaches core', async (_label, method, path, body, coreSpy) => {
    const res = await callGated(path, { method, key: VALID_KEY, body })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'access_denied' })
    // The gate blocked BEFORE the db op — the core fn was never invoked.
    expect(coreSpy).not.toHaveBeenCalled()
    expect(resolveRetrievalPolicy).not.toHaveBeenCalled()
  })

  it('still serves GET /api/v1/budget under a denying gate — deliberately ungated', async () => {
    // A denied user MUST keep reading their own cost status: it is the very read
    // that explains the denial. Gating it would be self-defeating.
    getBudgetStatus.mockResolvedValue({
      effectiveCapUsd: 25,
      consumedUsd: 25,
      capUsdOverride: null,
      periodStart: null,
      periodEnd: null,
    })
    const res = await callGated('/api/v1/budget', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ effectiveCapUsd: 25, consumedUsd: 25 })
  })

  it('still serves GET /api/v1/version under a denying gate — deliberately ungated', async () => {
    // A deploy probe must stay answerable when the gate itself is broken: that
    // is precisely when an operator most needs to know which build is running.
    // Gating it would make the endpoint useless in the one incident it exists for.
    const res = await callGated('/api/v1/version', { key: VALID_KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: SERVER_VERSION })
  })
})
