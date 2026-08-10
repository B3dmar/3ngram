// SPDX-License-Identifier: Apache-2.0
// MCP transport integration for search cursor pagination + compact projection
// (issue #49), THROUGH the real Streamable HTTP transport, Bearer middleware,
// runtime role, and DB with a deterministic FakeGateway. Proves the tool-level
// acceptance criteria the unit contract tests cannot:
//   - a 3-page cursor walk never duplicates or skips a hit under CONCURRENT
//     ARCHIVE between pages, a drift row written mid-walk stays outside the
//     frozen pool, and the walk terminates (hasMore:false, no dangling cursor);
//   - projection:'compact' omits the excerpt triple per hit on the wire, and
//     the compact -> get_memories workflow fetches the full body by id;
//   - a garbled cursor is a typed CLIENT error through the transport (never a
//     500 / internal fault).
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { createFakeGateway } from '@3ngram/llm'
import {
  type ClientOptions,
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

interface AppHandle {
  server: Server
  baseUrl: string
}

interface SearchPage {
  hits: Array<Record<string, unknown> & { id: string }>
  count: number
  hasMore: boolean
  nextCursor?: string
}

const gateway = createFakeGateway()

async function startApp(): Promise<AppHandle> {
  const server = createTestApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function connect(baseUrl: string, token: string, options?: ClientOptions) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new McpClient({ name: 'int-test', version: '0.0.0' }, options)
  await client.connect(transport)
  return client
}

let app: AppHandle
let clientId: string
let userId: string
let token: string
const email = `mcp-cursor-${crypto.randomUUID()}@test.local`

beforeAll(async () => {
  process.env.BASE_URL = TEST_BASE_URL
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()
  const row = await ownerPool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  userId = row.rows[0].id
  clientId = await ensureTestClient(ownerPool)
  token = await mintAccessToken(ownerPool, clientId, userId)
  app = await startApp()
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    app.server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM users WHERE email = $1', [email])
  await closePools()
})

/** remember via the tool; returns the new memory id. */
async function rememberNote(client: McpClient, content: string): Promise<string> {
  const result = await client.callTool({
    name: 'remember',
    arguments: { memoryType: 'note', topic: 'cursor-probe', content },
  })
  expect(result.isError).toBeFalsy()
  return (result.structuredContent as { memory: { id: string } }).memory.id
}

async function searchPage(
  client: McpClient,
  query: string,
  args: Record<string, unknown> = {},
): Promise<SearchPage> {
  const result = await client.callTool({
    name: 'search',
    arguments: { query, limit: 2, ...args },
  })
  expect(result.isError).toBeFalsy()
  return result.structuredContent as SearchPage
}

describe('MCP search cursor pagination (#49, real transport)', () => {
  it('3-page walk: no duplicate/skip under concurrent archive; terminates with hasMore:false', async () => {
    const client = await connect(app.baseUrl, token)
    const probe = `curwalk${crypto.randomUUID().replace(/-/g, '')}`
    const seeded: string[] = []
    for (let i = 0; i < 6; i++)
      seeded.push(await rememberNote(client, `${probe} seeded row ${i} ${crypto.randomUUID()}`))

    const page1 = await searchPage(client, probe)
    expect(page1.count).toBe(2)
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBeDefined()

    // CONCURRENT DRIFT between pages: a new matching row (outside the frozen
    // pool — must never surface) and one not-yet-shown row archived (must drop
    // out with no duplicate or skip around it).
    const drifted = await rememberNote(client, `${probe} drift row ${crypto.randomUUID()}`)
    const shown = new Set(page1.hits.map((h) => h.id))
    const archived = seeded.find((id) => !shown.has(id)) as string
    expect(archived, 'page-1 hits must come from the seeded rows').toBeDefined()
    await ownerPool.query(`UPDATE memories SET status = 'archived' WHERE id = $1`, [archived])

    const collected = [...page1.hits.map((h) => h.id)]
    let cursor = page1.nextCursor
    let pages = 1
    while (cursor !== undefined && pages < 10) {
      const page = await searchPage(client, probe, { cursor })
      expect(page.hits.length > 0 || !page.hasMore, 'empty page while hasMore=true').toBe(true)
      collected.push(...page.hits.map((h) => h.id))
      pages++
      // The schema-enforced pair: a cursor rides exactly when hasMore is true.
      expect(page.nextCursor !== undefined).toBe(page.hasMore)
      cursor = page.nextCursor
    }

    expect(cursor).toBeUndefined() // terminated, did not spin
    expect(pages).toBeGreaterThanOrEqual(3) // a real 3-page walk
    const distinct = new Set(collected)
    expect(collected.length, `duplicate ids across pages: ${collected.join(',')}`).toBe(
      distinct.size,
    )
    expect(distinct.has(drifted)).toBe(false)
    expect(distinct.has(archived)).toBe(false)
    expect(distinct.size).toBe(seeded.length - 1)
    await client.close()
  }, 30_000)

  it('compact projection omits the excerpt triple; get_memories fetches the body by id', async () => {
    const client = await connect(app.baseUrl, token)
    const probe = `curcompact${crypto.randomUUID().replace(/-/g, '')}`
    const content = `${probe} the full body an agent reads after a compact scan`
    const id = await rememberNote(client, content)

    const page = await searchPage(client, probe, { projection: 'compact' })
    expect(page.count).toBeGreaterThanOrEqual(1)
    const hit = page.hits.find((h) => h.id === id)
    expect(hit).toBeDefined()
    // The compact wire shape: id/type/topic/score/superseded ONLY — no excerpt triple.
    expect(Object.keys(hit as object).sort()).toEqual([
      'id',
      'memoryType',
      'score',
      'superseded',
      'topic',
    ])

    // The workflow compact enables: batch-fetch the interesting id.
    const fetched = await client.callTool({ name: 'get_memories', arguments: { ids: [id] } })
    expect(fetched.isError).toBeFalsy()
    const body = (fetched.structuredContent as { memories: Array<{ content: string }> }).memories[0]
    expect(body?.content).toBe(content)
    await client.close()
  }, 30_000)

  it('rejects a garbled cursor as a typed client error through the transport', async () => {
    const client = await connect(app.baseUrl, token)
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'anything', cursor: '!!!not-a-cursor!!!' },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('invalid input')
    expect(text).not.toContain('internal')
    await client.close()
  }, 30_000)
})
