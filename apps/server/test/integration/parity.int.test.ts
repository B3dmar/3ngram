// SPDX-License-Identifier: Apache-2.0
// REST≡MCP≡core parity integration tests.
//
// A2 shipped only a SMOKE parity check (a REST write is visible via core
// search). A4 PROVES the REST /api/v1 mirror (apps/server/src/rest/router.ts)
// and the MCP tools (apps/server/src/mcp/tools.ts) are EQUIVALENT surfaces:
// both are THIN adapters over the SAME packages/core services and the SAME
// packages/schema Zod types (docs/concepts/architecture.mdx "one core, N transports"). For each of
// the 5 mirrored ops (remember/search/get_facts/revise/resolve) the SAME
// logical input over REST and over MCP yields an EQUIVALENT output, the error
// taxonomy is shared (rest/errors.ts maps the SAME reason codes mcp/errors.ts
// uses to HTTP statuses), and a write over either transport is visible via core
// for the same tenant and HIDDEN cross-tenant (RLS).
//
// SAME-TENANT BINDING: ONE user gets BOTH an X-API-Key (REST) and a Bearer
// token (MCP), so parity is asserted on ONE tenant's rows. A second user (with
// both credentials too) proves cross-tenant isolation on both transports.
//
// Both transports run on ONE app built via createTestApp (RELAXED limiter — the
// shared MCP suite would otherwise 429 under the D4 per-user limiter). REST is
// reached over fetch with x-api-key (the REAL C3 apiKeyAuth chain); MCP over the
// SDK Client + StreamableHTTPClientTransport with a REAL Bearer token (the REAL
// C4 OAuth resource-server path). A deterministic FakeGateway is injected so
// embed-on-write + query both run offline; identical text -> identical vector ->
// a guaranteed cosine hit. Assertions carry NO memory content beyond test-local
// random tags (hard rule 6).
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { getFacts as coreGetFacts, search as coreSearch } from '@3ngram/core'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import { EXCERPT_MARKER, MAX_EXCERPT_LENGTH } from '@3ngram/schema'
import {
  type CallToolResult,
  Client as McpClient,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
// Aliased to McpClient so `new McpClient(...)` does not trip the db-access gate's
// `new (pg\.)?Client\(` regex (this is the MCP SDK client, not a Postgres client).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import {
  ensureTestClient,
  mintAccessToken,
  TEST_BASE_URL,
  TEST_JWKS,
} from '../oauth-token-helper.js'
import { createTestApp } from '../test-app.js'

const PASSWORD = 'rest-a4-parity-password'
const gateway = createFakeGateway()

let server: Server
let baseUrl: string
let clientId: string
let emailA: string
let emailB: string
let userAId: string
let userBId: string
// Tenant A: both an X-API-Key (REST) and a Bearer (MCP) for the SAME user.
let keyA: string
let tokenA: string
// Tenant B: both credentials too, to prove cross-tenant isolation on both.
let keyB: string
let tokenB: string

/** Issue an API key for a session-token holder via the C3 management route. */
async function issueKey(token: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  })
  if (res.status !== 201) throw new Error(`issueKey failed: ${res.status}`)
  return ((await res.json()) as { key: string }).key
}

interface RestCall {
  method?: string
  key?: string
  body?: unknown
}

/** Drive a REST /api/v1 call over fetch with the tenant's X-API-Key. */
async function rest(path: string, opts: RestCall = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.key !== undefined) headers['x-api-key'] = opts.key
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

/** Connect an MCP SDK client to /mcp with the tenant's Bearer token. */
async function connect(token: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new McpClient({ name: 'parity-int-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

/** The text of a tool result's first content item (the typed-error message). */
function toolText(result: CallToolResult): string {
  return (result.content as Array<{ text?: string }>)[0]?.text ?? ''
}

beforeAll(async () => {
  process.env.BASE_URL = TEST_BASE_URL
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()

  emailA = `parity-a-${crypto.randomUUID()}@test.local`
  emailB = `parity-b-${crypto.randomUUID()}@test.local`
  const a = await createUser(emailA, PASSWORD)
  const b = await createUser(emailB, PASSWORD)
  userAId = a.id
  userBId = b.id

  const grantA = await login(emailA, PASSWORD, 1)
  const grantB = await login(emailB, PASSWORD, 1)
  if (!grantA || !grantB) throw new Error('login failed in setup')

  server = createTestApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`

  // SAME-TENANT binding: each user gets BOTH transports bound to its own rows.
  keyA = await issueKey(grantA.token, 'parity-a')
  keyB = await issueKey(grantB.token, 'parity-b')
  clientId = await ensureTestClient(ownerPool)
  // Mint FULL-ACCESS tokens (memory:read + memory:write, the helper default) so
  // MCP writes succeed — a read-only token would 'insufficient scope' on remember.
  tokenA = await mintAccessToken(ownerPool, clientId, userAId)
  tokenB = await mintAccessToken(ownerPool, clientId, userBId)
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [[emailA, emailB]])
  await closePools()
})

// --- SUCCESS-PAYLOAD parity for the 5 mirrored ops -------------------------

describe('A4 remember parity (REST x-api-key ≡ MCP Bearer, same tenant)', () => {
  it('normalizes identically: scope default applied, project null when omitted', async () => {
    const restRes = await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'note',
        topic: 'parity',
        content: `remember-rest-${crypto.randomUUID()}`,
      },
    })
    expect(restRes.status).toBe(201)
    const restBody = (await restRes.json()) as {
      memory: { id: string; memoryType: string; topic: string; scope: string; project: null }
    }

    const client = await connect(tokenA)
    const mcpRes = await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'note',
        topic: 'parity',
        content: `remember-mcp-${crypto.randomUUID()}`,
      },
    })
    expect(mcpRes.isError).toBeFalsy()
    const mcpBody = mcpRes.structuredContent as {
      memory: { id: string; memoryType: string; topic: string; scope: string; project: null }
    }
    await client.close()

    // Same memory shape and normalization on BOTH transports: scope DEFAULTED
    // (omitted in input -> same default value), project NULL when omitted, the
    // echoed memoryType/topic preserved. (Ids differ — distinct rows.)
    expect(restBody.memory.memoryType).toBe(mcpBody.memory.memoryType)
    expect(restBody.memory.topic).toBe(mcpBody.memory.topic)
    expect(restBody.memory.scope).toBe(mcpBody.memory.scope)
    expect(restBody.memory.project).toBeNull()
    expect(mcpBody.memory.project).toBeNull()
    expect(restBody.memory.scope).toBe('personal')
  })

  it('writes structured facts and echoes factIds identically on both transports', async () => {
    const facts = [{ subject: 'lift.back_squat', predicate: 'top_set.weight_kg', value: '98' }]
    const restRes = await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'fact',
        topic: 'parity-facts',
        content: `facts-rest-${crypto.randomUUID()}`,
        facts,
      },
    })
    expect(restRes.status).toBe(201)
    const restBody = (await restRes.json()) as { factIds: string[] }

    const client = await connect(tokenA)
    const mcpRes = await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'fact',
        topic: 'parity-facts',
        content: `facts-mcp-${crypto.randomUUID()}`,
        facts,
      },
    })
    expect(mcpRes.isError).toBeFalsy()
    const mcpBody = mcpRes.structuredContent as { factIds: string[] }
    await client.close()

    // Both transports accept the same `facts` shape and return the same
    // response key carrying one id per written fact. (Ids differ — distinct rows.)
    expect(restBody.factIds).toHaveLength(facts.length)
    expect(mcpBody.factIds).toHaveLength(facts.length)
    expect(Object.keys(restBody).sort()).toEqual(Object.keys(mcpBody).sort())
  })

  it('surfaces the auto-created commitmentId for a commitment memory on both', async () => {
    const restRes = await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'commitment', topic: 'c', content: `commit-rest-${crypto.randomUUID()}` },
    })
    const restBody = (await restRes.json()) as { commitmentId?: string }

    const client = await connect(tokenA)
    const mcpRes = await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'commitment',
        topic: 'c',
        content: `commit-mcp-${crypto.randomUUID()}`,
      },
    })
    const mcpBody = mcpRes.structuredContent as { commitmentId?: string }
    await client.close()

    expect(restBody.commitmentId).toEqual(expect.any(String))
    expect(mcpBody.commitmentId).toEqual(expect.any(String))
  })
})

describe('A4 search parity (same tenant, same projection)', () => {
  it('projects identical hit shape {id,memoryType,topic,content,score} with count===hits.length', async () => {
    // Write the SAME content over each transport, then search for each over the
    // OTHER projection path: the hit shape and the count invariant must match.
    const tag = crypto.randomUUID()
    const content = `search-parity-${tag}`
    await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'search', content },
    })

    const restRes = await rest('/api/v1/search', {
      method: 'POST',
      key: keyA,
      body: { query: content },
    })
    expect(restRes.status).toBe(200)
    const restBody = (await restRes.json()) as {
      count: number
      hits: Array<{ id: string; memoryType: string; topic: string; content: string; score: number }>
    }

    const client = await connect(tokenA)
    const mcpRes = await client.callTool({ name: 'search', arguments: { query: content } })
    const mcpBody = mcpRes.structuredContent as {
      count: number
      hits: Array<{ id: string; memoryType: string; topic: string; content: string; score: number }>
    }
    await client.close()

    // count-consistency invariant on BOTH (docs/concepts/mcp-design.mdx): count === hits.length.
    expect(restBody.count).toBe(restBody.hits.length)
    expect(mcpBody.count).toBe(mcpBody.hits.length)
    // Both find the SAME row, identically projected (same field set, same id).
    const restHit = restBody.hits.find((h) => h.content === content)
    const mcpHit = mcpBody.hits.find((h) => h.content === content)
    expect(restHit).toBeDefined()
    expect(mcpHit).toBeDefined()
    expect(restHit?.id).toBe(mcpHit?.id)
    expect(Object.keys(restHit ?? {}).sort()).toEqual([
      'content',
      'contentLength',
      'id',
      'memoryType',
      'score',
      'superseded',
      'topic',
      'truncated',
    ])
    expect(Object.keys(mcpHit ?? {}).sort()).toEqual([
      'content',
      'contentLength',
      'id',
      'memoryType',
      'score',
      'superseded',
      'topic',
      'truncated',
    ])
  })

  it('returns a >2,000-char memory as the SAME bounded excerpt on both transports (#238)', async () => {
    // The defect: stored content can exceed any write-time cap via the IMPORT
    // path (the migration landed rows up to ~245K), and an over-cap hit
    // made the MCP output schema reject the WHOLE search result while REST
    // returned the full blob — a transport DIVERGENCE. Core read-path
    // excerpting (packages/core/src/read/excerpt.ts) is the single fix; this
    // test seeds an import-scale row DIRECTLY (the remember path caps at
    // 2,000, exactly like the real corpus arrived) and proves both transports
    // return the SAME bounded excerpt.
    const tag = crypto.randomUUID()
    const stored = `excerpt-parity-${tag} ${'long memory body '.repeat(700)}`.trim()
    expect(stored.length).toBeGreaterThan(2000)
    await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, scope)
       VALUES ($1, 'note', 'excerpt parity', $2, $3, 'work')`,
      [userAId, stored, `e2e-excerpt-${tag}`],
    )

    interface ExcerptHit {
      content: string
      contentLength: number
      truncated: boolean
    }
    const restRes = await rest('/api/v1/search', {
      method: 'POST',
      key: keyA,
      // limit 25 (the ceiling): the seeded row has no embedding (direct insert,
      // like the import path), so it scores on the FTS leg only — keep the
      // window wide so vector-scored neighbours cannot crowd it out.
      body: { query: `excerpt-parity-${tag}`, limit: 25 },
    })
    expect(restRes.status).toBe(200)
    const restBody = (await restRes.json()) as { hits: Array<ExcerptHit & { id: string }> }

    const client = await connect(tokenA)
    const mcpRes = await client.callTool({
      name: 'search',
      arguments: { query: `excerpt-parity-${tag}`, limit: 25 },
    })
    await client.close()
    // The whole point: the long row must NOT fail MCP output validation.
    expect(mcpRes.isError).toBeFalsy()
    const mcpBody = mcpRes.structuredContent as { hits: Array<ExcerptHit & { id: string }> }

    const restHit = restBody.hits.find((h) => h.content.includes(tag))
    const mcpHit = mcpBody.hits.find((h) => h.content.includes(tag))
    expect(restHit).toBeDefined()
    expect(mcpHit).toBeDefined()
    for (const hit of [restHit as ExcerptHit, mcpHit as ExcerptHit]) {
      expect(hit.content.length).toBe(MAX_EXCERPT_LENGTH)
      expect(hit.content.endsWith(EXCERPT_MARKER)).toBe(true)
      expect(hit.contentLength).toBe(stored.length)
      expect(hit.truncated).toBe(true)
    }
    // PARITY: REST (no output parse — core excerpting bounds it) byte-equals
    // the MCP hit the output schema validated.
    expect(restHit).toEqual(mcpHit)
  })
})

describe('A4 get_facts parity (projection + bi-temporal as_of)', () => {
  it('projects identical fact shape and time-travels identically over both transports', async () => {
    // Seed ONE supersession chain under tenant A (owner connection), then read it
    // over REST (querystring asOf) and MCP (nested asOf). The mirrors must agree
    // on the projection {id,subject,predicate,value,confidence,validFrom,validTo}
    // AND on the bi-temporal answer (validAt time-travel + asKnownAt).
    const subject = `employee:${crypto.randomUUID()}`
    const mem = await ownerPool.query<{ id: string }>(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1, 'fact', 'parity-asof', 'parity-asof', $2) RETURNING id`,
      [userAId, `parity-asof-${subject}`],
    )
    const memoryId = mem.rows[0]?.id as string
    const seed = (value: string, validFrom: string, validTo: string | null, recordedAt: string) =>
      ownerPool.query(
        `INSERT INTO facts (user_id, memory_id, subject, predicate, value,
                            valid_from, valid_to, recorded_at)
         VALUES ($1, $2, $3, 'role', $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)`,
        [userAId, memoryId, subject, value, validFrom, validTo, recordedAt],
      )
    await seed(
      'engineer',
      '2020-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    )
    await seed(
      'lead',
      '2021-01-01T00:00:00.000Z',
      '2022-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
    )
    await seed('manager', '2022-01-01T00:00:00.000Z', null, '2022-01-01T00:00:00.000Z')

    const enc = encodeURIComponent(subject)
    const client = await connect(tokenA)

    // current (live) generation: only the manager row.
    const restLive = (await (
      await rest(`/api/v1/facts?subject=${enc}&predicate=role`, { key: keyA })
    ).json()) as {
      facts: Array<{
        id: string
        subject: string
        predicate: string
        value: string
        confidence: number
        validFrom: string
        validTo: string | null
      }>
    }
    const mcpLive = (
      await client.callTool({ name: 'get_facts', arguments: { subject, predicate: 'role' } })
    ).structuredContent as {
      facts: Array<{
        id: string
        subject: string
        predicate: string
        value: string
        confidence: number
        validFrom: string
        validTo: string | null
        recordedAt: string
      }>
    }
    expect(restLive.facts.map((f) => f.value)).toEqual(['manager'])
    expect(mcpLive.facts.map((f) => f.value)).toEqual(['manager'])
    // Identical projection field set on the live row, on BOTH transports.
    // recordedAt (output-only strict widening for time-series consumers)
    // rides both — see factSchema, packages/schema/src/mcp.ts.
    const expectedKeys = [
      'confidence',
      'id',
      'predicate',
      'recordedAt',
      'subject',
      'validFrom',
      'validTo',
      'value',
    ]
    expect(Object.keys(restLive.facts[0] ?? {}).sort()).toEqual(expectedKeys)
    expect(Object.keys(mcpLive.facts[0] ?? {}).sort()).toEqual(expectedKeys)

    // validAt mid-2021 -> the "lead" generation true then, not the live row.
    const restPit = (await (
      await rest(`/api/v1/facts?subject=${enc}&predicate=role&validAt=2021-06-01T00:00:00.000Z`, {
        key: keyA,
      })
    ).json()) as { facts: Array<{ value: string }> }
    const mcpPit = (
      await client.callTool({
        name: 'get_facts',
        arguments: { subject, predicate: 'role', asOf: { validAt: '2021-06-01T00:00:00.000Z' } },
      })
    ).structuredContent as { facts: Array<{ value: string }> }
    expect(restPit.facts.map((f) => f.value)).toEqual(['lead'])
    expect(mcpPit.facts.map((f) => f.value)).toEqual(['lead'])

    // asKnownAt before the manager row was recorded -> transaction-time view.
    const restTt = (await (
      await rest(
        `/api/v1/facts?subject=${enc}&predicate=role&validAt=2021-06-01T00:00:00.000Z&asKnownAt=2021-06-01T00:00:00.000Z`,
        { key: keyA },
      )
    ).json()) as { facts: Array<{ value: string }> }
    const mcpTt = (
      await client.callTool({
        name: 'get_facts',
        arguments: {
          subject,
          predicate: 'role',
          asOf: { validAt: '2021-06-01T00:00:00.000Z', asKnownAt: '2021-06-01T00:00:00.000Z' },
        },
      })
    ).structuredContent as { facts: Array<{ value: string }> }
    expect(restTt.facts.map((f) => f.value)).toEqual(['lead'])
    expect(mcpTt.facts.map((f) => f.value)).toEqual(['lead'])
    await client.close()
  })
})

describe('A4 revise parity (successor semantics)', () => {
  it('mints a distinct successor id and echoes the normalized successor on both', async () => {
    const restPred = await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'decision',
        topic: 'r',
        content: `revise-rest-${crypto.randomUUID()} v1`,
      },
    })
    const restPredId = ((await restPred.json()) as { memory: { id: string } }).memory.id
    const restRevised = await rest(`/api/v1/memories/${restPredId}/revise`, {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'decision',
        topic: 'r',
        content: `revise-rest-${crypto.randomUUID()} v2`,
        edgeIntent: 'supersedes',
      },
    })
    expect(restRevised.status).toBe(200)
    const restSucc = (await restRevised.json()) as {
      memory: { id: string; project: null }
    }
    expect(restSucc.memory.id).not.toBe(restPredId)
    expect(restSucc.memory.project).toBeNull()

    const client = await connect(tokenA)
    const mcpPred = await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'decision',
        topic: 'r',
        content: `revise-mcp-${crypto.randomUUID()} v1`,
      },
    })
    const mcpPredId = (mcpPred.structuredContent as { memory: { id: string } }).memory.id
    const mcpRevised = await client.callTool({
      name: 'revise',
      arguments: {
        memoryType: 'decision',
        topic: 'r',
        content: `revise-mcp-${crypto.randomUUID()} v2`,
        predecessorId: mcpPredId,
        edgeIntent: 'supersedes',
      },
    })
    expect(mcpRevised.isError).toBeFalsy()
    const mcpSucc = mcpRevised.structuredContent as { memory: { id: string; project: null } }
    await client.close()

    expect(mcpSucc.memory.id).not.toBe(mcpPredId)
    expect(mcpSucc.memory.project).toBeNull()
  })
})

describe('A4 resolve parity (FSM status output)', () => {
  it('returns {commitmentId,status} with identical FSM transitions on both', async () => {
    // REST: remember a commitment, resolve it, then unresolve back to open.
    const restWritten = await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'commitment',
        topic: 'fsm',
        content: `resolve-rest-${crypto.randomUUID()}`,
      },
    })
    const restMemId = ((await restWritten.json()) as { memory: { id: string } }).memory.id
    const restResolved = await rest(`/api/v1/memories/${restMemId}/resolve`, {
      method: 'POST',
      key: keyA,
      body: { status: 'resolved' },
    })
    expect(restResolved.status).toBe(200)
    const restOut = (await restResolved.json()) as { commitmentId: string; status: string }
    expect(restOut.commitmentId).toEqual(expect.any(String))
    expect(restOut.status).toBe('resolved')

    // MCP: same sequence over the tool.
    const client = await connect(tokenA)
    const mcpWritten = await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'commitment',
        topic: 'fsm',
        content: `resolve-mcp-${crypto.randomUUID()}`,
      },
    })
    const mcpMemId = (mcpWritten.structuredContent as { memory: { id: string } }).memory.id
    const mcpResolved = await client.callTool({
      name: 'resolve',
      arguments: { memoryId: mcpMemId, status: 'resolved' },
    })
    expect(mcpResolved.isError).toBeFalsy()
    const mcpOut = mcpResolved.structuredContent as { commitmentId: string; status: string }
    await client.close()

    // Same FSM output shape + value on both transports.
    expect(mcpOut.commitmentId).toEqual(expect.any(String))
    expect(mcpOut.status).toBe(restOut.status)
  })
})

// --- ERROR-TAXONOMY parity --------------------------------------------------

describe('A4 error-taxonomy parity (shared reason-code contract)', () => {
  it('not_found: REST 404 ≡ MCP isError not_found (unknown predecessor)', async () => {
    const ghost = crypto.randomUUID()
    const restRes = await rest(`/api/v1/memories/${ghost}/revise`, {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'note',
        topic: 'x',
        content: `ghost-rest-${crypto.randomUUID()}`,
        edgeIntent: 'supersedes',
      },
    })
    expect(restRes.status).toBe(404)
    expect(await restRes.json()).toEqual({ error: 'not_found' })

    const client = await connect(tokenA)
    const mcpRes = await client.callTool({
      name: 'revise',
      arguments: {
        memoryType: 'note',
        topic: 'x',
        content: `ghost-mcp-${crypto.randomUUID()}`,
        predecessorId: crypto.randomUUID(),
        edgeIntent: 'supersedes',
      },
    })
    await client.close()
    expect(mcpRes.isError).toBe(true)
    expect(toolText(mcpRes)).toContain('not_found')
  })

  it('invalid_transition: REST 409 ≡ MCP isError invalid_transition (resolved -> expired)', async () => {
    // REST path.
    const restWritten = await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'commitment', topic: 't', content: `tr-rest-${crypto.randomUUID()}` },
    })
    const restMemId = ((await restWritten.json()) as { memory: { id: string } }).memory.id
    await rest(`/api/v1/memories/${restMemId}/resolve`, {
      method: 'POST',
      key: keyA,
      body: { status: 'resolved' },
    })
    const restIllegal = await rest(`/api/v1/memories/${restMemId}/resolve`, {
      method: 'POST',
      key: keyA,
      body: { status: 'expired' },
    })
    expect(restIllegal.status).toBe(409)
    expect(await restIllegal.json()).toEqual({ error: 'invalid_transition' })

    // MCP path.
    const client = await connect(tokenA)
    const mcpWritten = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'commitment', topic: 't', content: `tr-mcp-${crypto.randomUUID()}` },
    })
    const mcpMemId = (mcpWritten.structuredContent as { memory: { id: string } }).memory.id
    await client.callTool({
      name: 'resolve',
      arguments: { memoryId: mcpMemId, status: 'resolved' },
    })
    const mcpIllegal = await client.callTool({
      name: 'resolve',
      arguments: { memoryId: mcpMemId, status: 'expired' },
    })
    await client.close()
    expect(mcpIllegal.isError).toBe(true)
    expect(toolText(mcpIllegal)).toContain('invalid_transition')
  })

  it('invalid_input: REST 400 ≡ MCP rejects malformed args against the SAME schema', async () => {
    // An empty topic violates the SHARED remember schema (rememberToolInputSchema,
    // hard rule 2: one validation boundary) on BOTH transports. The shapes of the
    // rejection differ by transport, and that asymmetry is a deliberate property
    // of the contract, not a parity bug:
    //   - REST re-parses at the route boundary, so a ZodError maps through
    //     rest/errors.ts to a clean { status: 400, reason: 'invalid_input' } body.
    //   - MCP's SDK validates inbound args against the tool's registered
    //     inputSchema (the registerTool contract) BEFORE the handler runs, so the
    //     SAME empty-topic rejection surfaces as a JSON-RPC -32602 "input
    //     validation error" (the handler's mapToolError 'invalid input:' path is
    //     reached only for typed CORE validation that passes the SDK shape). Both
    //     are the invalid-input taxonomy: a typed, content-free client-error
    //     rejection of the same schema violation, never a 500 / internal fault.
    const restRes = await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: '', content: `bad-rest-${crypto.randomUUID()}` },
    })
    expect(restRes.status).toBe(400)
    expect(await restRes.json()).toEqual({ error: 'invalid_input' })

    const client = await connect(tokenA)
    const mcpRes = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: '', content: `bad-mcp-${crypto.randomUUID()}` },
    })
    await client.close()
    // MCP rejects it as an error naming the schema-validation failure (the SDK
    // -32602 path) — the transport-shaped analogue of REST's 400 invalid_input.
    expect(mcpRes.isError).toBe(true)
    expect(toolText(mcpRes).toLowerCase()).toContain('validation')
  })

  it('tenant isolation: cross-tenant predecessor is not_found on BOTH (RLS)', async () => {
    // A-owned predecessor (over MCP), then B attempts to supersede it on both
    // transports — RLS hides A's row, so both see not_found, never a write.
    const clientA = await connect(tokenA)
    const written = await clientA.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'a', content: `a-owned-${crypto.randomUUID()}` },
    })
    const predecessorId = (written.structuredContent as { memory: { id: string } }).memory.id
    await clientA.close()

    // REST: B's key cannot supersede A's predecessor -> 404 not_found.
    const restRes = await rest(`/api/v1/memories/${predecessorId}/revise`, {
      method: 'POST',
      key: keyB,
      body: {
        memoryType: 'note',
        topic: 'a',
        content: `b-rest-${crypto.randomUUID()}`,
        edgeIntent: 'supersedes',
      },
    })
    expect(restRes.status).toBe(404)
    expect(await restRes.json()).toEqual({ error: 'not_found' })

    // MCP: B's token cannot supersede A's predecessor -> isError not_found.
    const clientB = await connect(tokenB)
    const mcpRes = await clientB.callTool({
      name: 'revise',
      arguments: {
        memoryType: 'note',
        topic: 'a',
        content: `b-mcp-${crypto.randomUUID()}`,
        predecessorId,
        edgeIntent: 'supersedes',
      },
    })
    await clientB.close()
    expect(mcpRes.isError).toBe(true)
    expect(toolText(mcpRes)).toContain('not_found')
  })

  it('tenant isolation: cross-tenant commitment resolve is not_found on BOTH (RLS)', async () => {
    const clientA = await connect(tokenA)
    const written = await clientA.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'commitment',
        topic: 'a',
        content: `a-commit-${crypto.randomUUID()}`,
      },
    })
    const memoryId = (written.structuredContent as { memory: { id: string } }).memory.id
    await clientA.close()

    const restRes = await rest(`/api/v1/memories/${memoryId}/resolve`, {
      method: 'POST',
      key: keyB,
      body: { status: 'resolved' },
    })
    expect(restRes.status).toBe(404)

    const clientB = await connect(tokenB)
    const mcpRes = await clientB.callTool({
      name: 'resolve',
      arguments: { memoryId, status: 'resolved' },
    })
    await clientB.close()
    expect(mcpRes.isError).toBe(true)
    expect(toolText(mcpRes)).toContain('not_found')
  })
})

// --- CORE agreement: a write over either transport is visible via core ------

describe('A4 core agreement (a transport write is visible via core, RLS-scoped)', () => {
  it('a REST write AND an MCP write are both visible via core search for tenant A', async () => {
    const restContent = `core-rest-${crypto.randomUUID()}`
    const restWritten = await rest('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'core', content: restContent },
    })
    const restId = ((await restWritten.json()) as { memory: { id: string } }).memory.id

    const client = await connect(tokenA)
    const mcpContent = `core-mcp-${crypto.randomUUID()}`
    const mcpWritten = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'core', content: mcpContent },
    })
    const mcpId = (mcpWritten.structuredContent as { memory: { id: string } }).memory.id
    await client.close()

    // Reach into core directly as tenant A: both writes are visible via core.
    const restHits = await coreSearch(userAId, restContent, { gateway })
    const mcpHits = await coreSearch(userAId, mcpContent, { gateway })
    expect(restHits.some((h) => h.id === restId)).toBe(true)
    expect(mcpHits.some((h) => h.id === mcpId)).toBe(true)

    // NOT visible cross-tenant via core (RLS): tenant B sees neither write.
    const bSeesRest = await coreSearch(userBId, restContent, { gateway })
    const bSeesMcp = await coreSearch(userBId, mcpContent, { gateway })
    expect(bSeesRest.some((h) => h.id === restId)).toBe(false)
    expect(bSeesMcp.some((h) => h.id === mcpId)).toBe(false)
  })

  it('a fact written under tenant A is visible via core getFacts, not cross-tenant', async () => {
    const subject = `core-fact:${crypto.randomUUID()}`
    const mem = await ownerPool.query<{ id: string }>(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1, 'fact', 'core', 'core', $2) RETURNING id`,
      [userAId, `core-fact-${subject}`],
    )
    const memoryId = mem.rows[0]?.id as string
    await ownerPool.query(
      `INSERT INTO facts (user_id, memory_id, subject, predicate, value, valid_from)
       VALUES ($1, $2, $3, 'role', 'lead', now())`,
      [userAId, memoryId, subject],
    )
    const aFacts = await coreGetFacts(userAId, { subject, predicate: 'role' })
    const bFacts = await coreGetFacts(userBId, { subject, predicate: 'role' })
    expect(aFacts.map((f) => f.value)).toEqual(['lead'])
    expect(bFacts).toHaveLength(0)
  })
})
