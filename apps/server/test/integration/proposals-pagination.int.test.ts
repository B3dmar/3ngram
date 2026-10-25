// SPDX-License-Identifier: Apache-2.0
// Transport integration for complete, read-only proposal pagination (issue
// #320), THROUGH the real Streamable HTTP MCP transport (OAuth Bearer) and the
// REST /api/v1 router (session Bearer), against the runtime role and real DB.
// Proves what the unit contract tests cannot:
//   - an MCP consumer walks >100 edge + >100 fact proposals (one shared
//     created_at, so ids break every tie) to completion via nextCursor, every
//     id exactly once, with per-kind counts and totals on every page;
//   - a REST consumer walks every edge proposal the same way, `count` staying
//     the page size;
//   - tenant B replaying tenant A's cursor, an MCP cursor on REST, and a
//     garbled cursor are typed client errors — never a 500, never A's rows;
//   - the walk changes no proposal row.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
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

const PASSWORD = 'proposals-pagination-password'
const EDGES = 110
const FACTS = 105

interface Tenant {
  email: string
  userId: string
  session: string
  mcp: McpClient
}

interface McpListPage {
  proposals: Array<{ id: string }>
  factProposals?: Array<{ id: string }>
  count: number
  counts: { edge: number; fact: number }
  totals: { edge: number; fact: number }
  hasMore: boolean
  nextCursor?: string
}

interface RestListPage {
  proposals: Array<{ id: string }>
  count: number
  totals: { edge: number }
  hasMore: boolean
  nextCursor?: string
}

let server: Server
let baseUrl: string
let clientId: string
let a: Tenant
let b: Tenant

async function tenant(label: string): Promise<Tenant> {
  const email = `proposals-page-${label}-${crypto.randomUUID()}@test.local`
  const user = await createUser(email, PASSWORD)
  const grant = await login(email, PASSWORD, 1)
  if (!grant) throw new Error('login failed in setup')
  const token = await mintAccessToken(ownerPool, clientId, user.id)
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const mcp = new McpClient({ name: 'int-test', version: '0.0.0' })
  await mcp.connect(transport)
  return { email, userId: user.id, session: grant.token, mcp }
}

/**
 * Seed `edges` edge + `facts` fact proposals for `userId` in ONE statement
 * (owner connection, data-modifying CTEs) so every row shares one created_at —
 * the tie case. Memory FKs are checked at statement end, after the sibling CTE
 * inserted the parents.
 */
async function seed(userId: string, edges: number, facts: number): Promise<void> {
  const r = await ownerPool.query(
    `WITH m AS (
       INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       SELECT $1, 'fact', 'proposals-page', 'proposals-page-content', md5(random()::text || g)
       FROM generate_series(1, 12) g RETURNING id
     ), e AS (
       INSERT INTO consolidation_proposals
         (user_id, from_id, to_id, edge_type, memory_type, similarity, status)
       SELECT $1, f.id, t.id, 'extends', 'fact', 0.9, 'proposed'
       FROM m f CROSS JOIN m t WHERE f.id <> t.id LIMIT $2 RETURNING id
     ), fp AS (
       INSERT INTO fact_proposals (user_id, memory_id, subject, predicate, value, memory_type, status)
       SELECT $1, (SELECT min(id::text)::uuid FROM m), 'proposals.page', 'seed.value', 'v-' || g,
              'fact', 'proposed'
       FROM generate_series(1, $3::int) g RETURNING id
     )
     SELECT (SELECT count(*) FROM e)::int AS edges, (SELECT count(*) FROM fp)::int AS facts`,
    [userId, edges, facts],
  )
  expect(r.rows[0]).toEqual({ edges, facts })
}

async function ids(table: 'consolidation_proposals' | 'fact_proposals', userId: string) {
  const r = await ownerPool.query(`SELECT id FROM ${table} WHERE user_id = $1`, [userId])
  return new Set<string>(r.rows.map((row: { id: string }) => row.id))
}

async function listMcp(who: Tenant, args: Record<string, unknown>) {
  return who.mcp.callTool({ name: 'review_proposals', arguments: { action: 'list', ...args } })
}

async function listRest(who: Tenant, query: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/proposals?${query}`, {
    headers: { authorization: `Bearer ${who.session}` },
  })
}

/** The first page's nextCursor for tenant A over MCP (limit 10). */
async function firstMcpCursor(): Promise<string> {
  const result = await listMcp(a, { limit: 10 })
  const cursor = (result.structuredContent as McpListPage).nextCursor
  expect(cursor).toBeDefined()
  return cursor as string
}

beforeAll(async () => {
  process.env.BASE_URL = TEST_BASE_URL
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()
  server = createTestApp({ gateway: createFakeGateway() }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  clientId = await ensureTestClient(ownerPool)
  a = await tenant('a')
  b = await tenant('b')
  await seed(a.userId, EDGES, FACTS)
  await seed(b.userId, 3, 3)
}, 60_000)

afterAll(async () => {
  await a?.mcp.close()
  await b?.mcp.close()
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [[a?.email, b?.email]])
  await closePools()
})

describe('review_proposals list pagination (#320, real MCP transport)', () => {
  it('walks every edge AND fact proposal exactly once, read-only', async () => {
    const before = await ownerPool.query(
      `SELECT id, status, decided_at FROM consolidation_proposals WHERE user_id = $1
       UNION ALL SELECT id, status, decided_at FROM fact_proposals WHERE user_id = $1 ORDER BY id`,
      [a.userId],
    )
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (; pages < 20; pages++) {
      const result = await listMcp(a, { limit: 100, ...(cursor ? { cursor } : {}) })
      expect(result.isError).toBeFalsy()
      const page = result.structuredContent as McpListPage
      const factIds = page.factProposals?.map((p) => p.id) ?? []
      expect(page.count).toBe(page.proposals.length)
      expect(page.counts).toEqual({
        edge: page.proposals.length,
        fact: factIds.length,
        resolution: 0,
      })
      expect(page.totals).toEqual({ edge: EDGES, fact: FACTS, resolution: 0 })
      seen.push(...page.proposals.map((p) => p.id), ...factIds)
      if (!page.hasMore) {
        expect(page.nextCursor).toBeUndefined()
        break
      }
      cursor = page.nextCursor
    }
    expect(pages + 1).toBe(Math.ceil((EDGES + FACTS) / 100))
    expect(seen).toHaveLength(EDGES + FACTS)
    expect(new Set(seen)).toEqual(
      new Set([
        ...(await ids('consolidation_proposals', a.userId)),
        ...(await ids('fact_proposals', a.userId)),
      ]),
    )
    const after = await ownerPool.query(
      `SELECT id, status, decided_at FROM consolidation_proposals WHERE user_id = $1
       UNION ALL SELECT id, status, decided_at FROM fact_proposals WHERE user_id = $1 ORDER BY id`,
      [a.userId],
    )
    expect(after.rows).toEqual(before.rows)
  })

  it("tenant B replaying tenant A's cursor is a typed mismatch, never A's rows", async () => {
    const cursor = await firstMcpCursor()
    const result = await listMcp(b, { limit: 10, cursor })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('different proposals listing')
  })

  it('a cursor replayed under a different status filter is a typed mismatch', async () => {
    const cursor = await firstMcpCursor()
    const result = await listMcp(a, { limit: 10, status: 'proposed', cursor })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain(
      'different proposals listing',
    )
  })

  it('a garbled cursor is invalid input, not an internal fault', async () => {
    const result = await listMcp(a, { cursor: 'garbled-token' })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('invalid input')
  })
})

describe('GET /api/v1/proposals pagination (#320, real REST router)', () => {
  it('walks every edge proposal exactly once; count stays the page size', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let pages = 0; pages < 20; pages++) {
      const res = await listRest(a, `limit=100${cursor ? `&cursor=${cursor}` : ''}`)
      expect(res.status).toBe(200)
      const page = (await res.json()) as RestListPage
      expect(page.count).toBe(page.proposals.length)
      expect(page.totals).toEqual({ edge: EDGES })
      seen.push(...page.proposals.map((p) => p.id))
      if (!page.hasMore) break
      cursor = page.nextCursor
    }
    expect(seen).toHaveLength(EDGES)
    expect(new Set(seen)).toEqual(await ids('consolidation_proposals', a.userId))
  })

  it("400s tenant A's REST cursor for tenant B, and an MCP cursor on REST", async () => {
    const first = (await (await listRest(a, 'limit=10')).json()) as RestListPage
    expect(first.nextCursor).toBeDefined()
    const crossTenant = await listRest(b, `cursor=${first.nextCursor}`)
    expect(crossTenant.status).toBe(400)
    expect(await crossTenant.json()).toMatchObject({ error: 'invalid_input' })

    const crossSurface = await listRest(a, `cursor=${await firstMcpCursor()}`)
    expect(crossSurface.status).toBe(400)
  })

  it('400s a garbled cursor', async () => {
    const res = await listRest(a, 'cursor=garbled-token')
    expect(res.status).toBe(400)
  })
})
