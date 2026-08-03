// SPDX-License-Identifier: Apache-2.0
// MCP transport integration tests against the in-process app, the REAL runtime
// role, and the REAL Bearer-JWT middleware. Proves the D0 acceptance criteria
// THROUGH the actual MCP Streamable HTTP transport (SDK Client + transport, not
// hand-rolled JSON-RPC):
//   - 401 without a Bearer token, carrying the RFC 9728 WWW-Authenticate header
//   - X-API-Key alone is rejected (/mcp is Bearer-ONLY, strict RS)
//   - a tool call round-trips (remember -> search) as the token's tenant
//   - TENANT ISOLATION: user B's token cannot read user A's memory
//   - STATELESS: a FRESH app instance (new createApp) serves a token minted
//     against the first — no in-process session state is required
//
// A deterministic FakeGateway is injected so embed-on-write + query both run
// offline; identical text maps to identical vectors, so a search for the exact
// written content is a guaranteed cosine hit (RLS is what filters cross-tenant).
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { createFakeGateway } from '@3ngram/llm'
import { EXCERPT_MARKER, MAX_EXCERPT_LENGTH } from '@3ngram/schema'
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

const gateway = createFakeGateway()

async function startApp(): Promise<AppHandle> {
  const server = createTestApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function stopApp(handle: AppHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    handle.server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
}

/** Connect an MCP client to /mcp with a static Authorization header. */
async function connect(
  baseUrl: string,
  authHeader: string | undefined,
  options?: ClientOptions,
): Promise<McpClient> {
  const headers: Record<string, string> = {}
  if (authHeader !== undefined) headers.authorization = authHeader
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers },
  })
  const client = new McpClient({ name: 'int-test', version: '0.0.0' }, options)
  await client.connect(transport)
  return client
}

let app: AppHandle
let clientId: string
let userA: string
let userB: string
let tokenA: string
let tokenB: string
let tokenReadOnly: string
const emailA = `mcp-a-${crypto.randomUUID()}@test.local`
const emailB = `mcp-b-${crypto.randomUUID()}@test.local`

beforeAll(async () => {
  process.env.BASE_URL = TEST_BASE_URL
  process.env.OAUTH_JWKS = TEST_JWKS
  resetEnvCache()

  const a = await ownerPool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [emailA],
  )
  const b = await ownerPool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [emailB],
  )
  userA = a.rows[0].id
  userB = b.rows[0].id
  clientId = await ensureTestClient(ownerPool)
  tokenA = await mintAccessToken(ownerPool, clientId, userA)
  tokenB = await mintAccessToken(ownerPool, clientId, userB)
  // A read-only grant for userA: proves per-tool scope enforcement end-to-end.
  tokenReadOnly = await mintAccessToken(ownerPool, clientId, userA, 'memory:read')

  app = await startApp()
})

afterAll(async () => {
  await stopApp(app)
  resetEnvCache()
  delete process.env.BASE_URL
  delete process.env.OAUTH_JWKS
  await ownerPool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId])
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [[emailA, emailB]])
  await closePools()
})

describe('/mcp transport auth (Bearer-only, strict RS)', () => {
  it('401s a request with no Bearer and sends the RFC 9728 WWW-Authenticate header', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('rejects an X-API-Key-only request — /mcp does not accept API keys', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-api-key': 'sk_some_api_key_value',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })
})

describe('/mcp tools end-to-end (real transport, runtime role)', () => {
  it('serves an authenticated client pinned to 2026-07-28', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    expect(client.getProtocolEra()).toBe('modern')
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(11)
    await client.close()
  })

  it('lists exactly the 11 tools (D1 5 + D2 orient 2 + inspect 1 + D3 admin 3)', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'briefing',
      'configure_scope',
      'describe_environment',
      'get_facts',
      'get_memories',
      'handoff',
      'remember',
      'resolve',
      'review_proposals',
      'revise',
      'search',
    ])
    await client.close()
  })

  it('remember then search round-trips for the token tenant', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const content = `alpha-secret-${crypto.randomUUID()}`
    const written = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'secret', content },
    })
    expect(written.isError).toBeFalsy()
    const found = await client.callTool({ name: 'search', arguments: { query: content } })
    const structured = found.structuredContent as {
      count: number
      hits: Array<{ content: string }>
    }
    expect(structured.count).toBeGreaterThanOrEqual(1)
    expect(structured.hits.some((h) => h.content === content)).toBe(true)
    await client.close()
  })

  it('a memoryType filter narrows a search round-trip to the matching type (#166)', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    // Two memories with DISTINCT content (content-hash dedup, docs/concepts/memory-model.mdx, rejects
    // identical text) that share a unique query token. The shared token gives
    // both a positive FTS leg (fts: 0.2) under the deterministic FakeGateway —
    // which maps SIMILAR text to DISSIMILAR vectors, so the vector leg alone
    // would not surface a near-text sibling. Searching the shared token with
    // memoryType:'decision' must keep ONLY the decision in the candidate set
    // (narrowing BEFORE fusion), proving the filter reached core/db.
    const token = `filterprobe${crypto.randomUUID().replace(/-/g, '')}`
    const decisionContent = `${token} we will pin the decision body for this probe`
    const noteContent = `${token} a loose note jotted alongside the same probe`
    const decision = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'decision', topic: 'probe', content: decisionContent },
    })
    expect(decision.isError).toBeFalsy()
    const note = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'probe', content: noteContent },
    })
    expect(note.isError).toBeFalsy()

    // Baseline: WITHOUT the filter, the shared token surfaces BOTH (the note is
    // a genuine FTS hit), so the filter below is doing real narrowing work.
    const unfiltered = await client.callTool({ name: 'search', arguments: { query: token } })
    expect(unfiltered.isError).toBeFalsy()
    const unfilteredHits = (unfiltered.structuredContent as { hits: Array<{ content: string }> })
      .hits
    expect(unfilteredHits.some((h) => h.content === noteContent)).toBe(true)

    const found = await client.callTool({
      name: 'search',
      arguments: { query: token, memoryType: 'decision' },
    })
    expect(found.isError).toBeFalsy()
    const structured = found.structuredContent as {
      hits: Array<{ memoryType: string; content: string }>
    }
    // The decision is present and the note was narrowed OUT before fusion.
    expect(structured.hits.some((h) => h.content === decisionContent)).toBe(true)
    expect(structured.hits.some((h) => h.content === noteContent)).toBe(false)
    expect(structured.hits.every((h) => h.memoryType === 'decision')).toBe(true)
    await client.close()
  })

  it('rejects an unknown filter key on the real MCP transport (#275)', async () => {
    // The search tool registers the FULL `.strict()` searchQuerySchema, so the
    // SDK parses inbound args strictly at the transport
    // boundary: an unknown key is REJECTED there with an InvalidParams protocol
    // error rather than silently STRIPPED and run as an unfiltered search.
    // The MCP SDK surfaces tool-input validation failure as a RESOLVED result
    // carrying `isError: true` (JSON-RPC -32602), NOT a thrown/rejected promise:
    // the contract is enforced, so assert the resolved error result.
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    try {
      const res = await client.callTool({
        name: 'search',
        arguments: { query: 'anything', bogusFilter: 'oops' },
      })
      expect(res.isError).toBe(true)
      const text = (res.content as Array<{ type: string; text?: string }>)
        .map((part) => part.text ?? '')
        .join('\n')
      expect(text).toMatch(/-32602|validation|Invalid arguments|Unrecognized|bogusFilter/i)
    } finally {
      await client.close()
    }
  })

  it('enforces tenant isolation: user B cannot read user A memory through the transport', async () => {
    const clientA = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const content = `tenant-private-${crypto.randomUUID()}`
    await clientA.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'private', content },
    })
    await clientA.close()

    const clientB = await connect(app.baseUrl, `Bearer ${tokenB}`)
    const found = await clientB.callTool({ name: 'search', arguments: { query: content } })
    const structured = found.structuredContent as { hits: Array<{ content: string }> }
    expect(structured.hits.some((h) => h.content === content)).toBe(false)
    await clientB.close()
  })

  it('enforces per-tool scopes: a read-only token can search but not remember', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenReadOnly}`)
    // search requires memory:read — the read-only token has it.
    const searched = await client.callTool({ name: 'search', arguments: { query: 'anything' } })
    expect(searched.isError).toBeFalsy()
    // remember requires memory:write — the read-only token does NOT have it.
    const written = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'blocked', content: 'should not persist' },
    })
    expect(written.isError).toBe(true)
    const text = (written.content as Array<{ text?: string }>)[0]?.text ?? ''
    expect(text).toContain('insufficient scope')
    await client.close()
  })

  it('is stateless: a FRESH app instance serves the same token (no in-process session)', async () => {
    const fresh = await startApp()
    try {
      const client = await connect(fresh.baseUrl, `Bearer ${tokenA}`)
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(11)
      await client.close()
    } finally {
      await stopApp(fresh)
    }
  })
})

describe('/mcp revise + resolve end-to-end (D1, real transport, runtime role)', () => {
  it('revise round-trips: search ranks the successor above the superseded predecessor', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const tag = crypto.randomUUID()
    const predecessorContent = `release-policy-${tag} cut from main after the staging soak`
    const written = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'decision', topic: 'release policy', content: predecessorContent },
    })
    const predecessorId = (written.structuredContent as { memory: { id: string } }).memory.id

    const successorContent = `release-policy-${tag} cut from main after a 24h staging soak window`
    const revised = await client.callTool({
      name: 'revise',
      arguments: {
        memoryType: 'decision',
        topic: 'release policy',
        content: successorContent,
        predecessorId,
        edgeIntent: 'supersedes',
      },
    })
    expect(revised.isError).toBeFalsy()
    const successorId = (revised.structuredContent as { memory: { id: string } }).memory.id
    expect(successorId).not.toBe(predecessorId)

    const found = await client.callTool({
      name: 'search',
      arguments: { query: `release-policy-${tag}` },
    })
    const hits = (found.structuredContent as { hits: Array<{ id: string }> }).hits
    const successorRank = hits.findIndex((h) => h.id === successorId)
    const predecessorRank = hits.findIndex((h) => h.id === predecessorId)
    // The successor must be present and rank ABOVE the superseded predecessor
    // (supersession tier-penalty). A predecessor absent from the window also
    // satisfies "ranks below" — it was demoted out.
    expect(successorRank).toBeGreaterThanOrEqual(0)
    if (predecessorRank >= 0) expect(successorRank).toBeLessThan(predecessorRank)
    await client.close()
  })

  it('rejects revising an unknown predecessor with a not_found result', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const result = await client.callTool({
      name: 'revise',
      arguments: {
        memoryType: 'note',
        topic: 'x',
        content: `ghost-revise-${crypto.randomUUID()}`,
        predecessorId: crypto.randomUUID(),
        edgeIntent: 'supersedes',
      },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? ''
    expect(text).toContain('not_found')
    await client.close()
  })

  it('resolve transitions an auto-created commitment, then rejects an illegal transition', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const written = await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'commitment',
        topic: 'd1 ship',
        content: `commit-${crypto.randomUUID()} open the d1 PR`,
      },
    })
    const structured = written.structuredContent as {
      memory: { id: string }
      commitmentId?: string
    }
    const memoryId = structured.memory.id
    // remember surfaces the auto-created commitment id for a commitment memory.
    expect(structured.commitmentId).toEqual(expect.any(String))

    const resolved = await client.callTool({
      name: 'resolve',
      arguments: { memoryId, status: 'resolved' },
    })
    expect(resolved.isError).toBeFalsy()
    const out = resolved.structuredContent as { commitmentId: string; status: string }
    expect(out.commitmentId).toBe(structured.commitmentId)
    expect(out.status).toBe('resolved')

    // resolved -> expired is illegal (resolved only -> open): an invalid_transition.
    const illegal = await client.callTool({
      name: 'resolve',
      arguments: { memoryId, status: 'expired' },
    })
    expect(illegal.isError).toBe(true)
    const text = (illegal.content as Array<{ text?: string }>)[0]?.text ?? ''
    expect(text).toContain('invalid_transition')

    // unresolve: resolved -> open is legal, served by the same tool.
    const unresolved = await client.callTool({
      name: 'resolve',
      arguments: { memoryId, status: 'open' },
    })
    expect(unresolved.isError).toBeFalsy()
    expect((unresolved.structuredContent as { status: string }).status).toBe('open')
    await client.close()
  })

  it('rejects resolving a memory with no commitment (not_found)', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const written = await client.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'x', content: `no-commit-${crypto.randomUUID()}` },
    })
    const memoryId = (written.structuredContent as { memory: { id: string } }).memory.id
    const result = await client.callTool({
      name: 'resolve',
      arguments: { memoryId, status: 'resolved' },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('not_found')
    await client.close()
  })

  it('enforces tenant isolation on revise: B cannot supersede A’s memory', async () => {
    const clientA = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const written = await clientA.callTool({
      name: 'remember',
      arguments: { memoryType: 'note', topic: 'a', content: `a-owned-${crypto.randomUUID()}` },
    })
    const predecessorId = (written.structuredContent as { memory: { id: string } }).memory.id
    await clientA.close()

    const clientB = await connect(app.baseUrl, `Bearer ${tokenB}`)
    const result = await clientB.callTool({
      name: 'revise',
      arguments: {
        memoryType: 'note',
        topic: 'a',
        content: `b-attempt-${crypto.randomUUID()}`,
        predecessorId,
        edgeIntent: 'supersedes',
      },
    })
    // RLS hides A's row from B, so the predecessor is not_found for B.
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('not_found')
    await clientB.close()
  })

  it('enforces tenant isolation on resolve: B cannot resolve A’s commitment', async () => {
    const clientA = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const written = await clientA.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'commitment',
        topic: 'a-commit',
        content: `a-commit-${crypto.randomUUID()}`,
      },
    })
    const memoryId = (written.structuredContent as { memory: { id: string } }).memory.id
    await clientA.close()

    const clientB = await connect(app.baseUrl, `Bearer ${tokenB}`)
    const result = await clientB.callTool({
      name: 'resolve',
      arguments: { memoryId, status: 'resolved' },
    })
    // RLS hides A's commitment from B -> not_found, never a cross-tenant write.
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('not_found')
    await clientB.close()
  })

  it('enforces per-tool scopes: a read-only token cannot revise or resolve', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenReadOnly}`)
    const revised = await client.callTool({
      name: 'revise',
      arguments: {
        memoryType: 'note',
        topic: 'x',
        content: 'blocked',
        predecessorId: crypto.randomUUID(),
        edgeIntent: 'supersedes',
      },
    })
    expect(revised.isError).toBe(true)
    expect((revised.content as Array<{ text?: string }>)[0]?.text ?? '').toContain(
      'insufficient scope',
    )
    const resolved = await client.callTool({
      name: 'resolve',
      arguments: { memoryId: crypto.randomUUID(), status: 'resolved' },
    })
    expect(resolved.isError).toBe(true)
    expect((resolved.content as Array<{ text?: string }>)[0]?.text ?? '').toContain(
      'insufficient scope',
    )
    await client.close()
  })
})

describe('/mcp D3 admin tools end-to-end (real transport, runtime role)', () => {
  it('configure_scope CRUD round-trips and reports a uniqueness conflict typed', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const name = `e2e-${crypto.randomUUID().slice(0, 8)}`

    const created = await client.callTool({
      name: 'configure_scope',
      arguments: { action: 'create', name, aliases: ['a'] },
    })
    expect(created.isError).toBeFalsy()
    expect((created.structuredContent as { scope: { name: string } }).scope.name).toBe(name)

    // Re-creating the same name is a typed conflict (unique per user).
    const dup = await client.callTool({
      name: 'configure_scope',
      arguments: { action: 'create', name },
    })
    expect(dup.isError).toBe(true)
    expect((dup.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('conflict')

    // list shows it; rename then delete; final list omits it.
    const listed = await client.callTool({ name: 'configure_scope', arguments: { action: 'list' } })
    const names = (listed.structuredContent as { scopes: Array<{ name: string }> }).scopes.map(
      (s) => s.name,
    )
    expect(names).toContain(name)

    const renamed = `${name}-r`
    await client.callTool({
      name: 'configure_scope',
      arguments: { action: 'rename', name, newName: renamed },
    })
    const del = await client.callTool({
      name: 'configure_scope',
      arguments: { action: 'delete', name: renamed },
    })
    expect(del.isError).toBeFalsy()
    expect((del.structuredContent as { name: string }).name).toBe(renamed)
    await client.close()
  })

  it('enforces tenant isolation on configure_scope: B never sees A scopes', async () => {
    const name = `iso-${crypto.randomUUID().slice(0, 8)}`
    const clientA = await connect(app.baseUrl, `Bearer ${tokenA}`)
    await clientA.callTool({ name: 'configure_scope', arguments: { action: 'create', name } })
    await clientA.close()

    const clientB = await connect(app.baseUrl, `Bearer ${tokenB}`)
    const listed = await clientB.callTool({
      name: 'configure_scope',
      arguments: { action: 'list' },
    })
    const names = (listed.structuredContent as { scopes: Array<{ name: string }> }).scopes.map(
      (s) => s.name,
    )
    expect(names).not.toContain(name)
    await clientB.close()
  })

  it('TWO-LAYER SCOPE: a read-only token may list scopes but not mutate', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenReadOnly}`)
    const listed = await client.callTool({ name: 'configure_scope', arguments: { action: 'list' } })
    expect(listed.isError).toBeFalsy()
    const blocked = await client.callTool({
      name: 'configure_scope',
      arguments: { action: 'create', name: `blocked-${crypto.randomUUID().slice(0, 8)}` },
    })
    expect(blocked.isError).toBe(true)
    expect((blocked.content as Array<{ text?: string }>)[0]?.text ?? '').toContain(
      'insufficient scope',
    )
    await client.close()
  })

  it('describe_environment reports capabilities + bounded stats and leaks NO secret', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenReadOnly}`)
    const result = await client.callTool({ name: 'describe_environment', arguments: {} })
    expect(result.isError).toBeFalsy()
    const report = result.structuredContent as {
      capabilities: { tools: string[]; toolCount: number; version: string }
      stats: { activeMemories: number }
    }
    expect(report.capabilities.toolCount).toBe(11)
    expect(report.capabilities.tools).toContain('describe_environment')
    // REDACTION sentinel: the configured DB URL password (a real secret in this
    // running server's env) must NOT appear anywhere in the response.
    const dbUrl = process.env.DATABASE_URL ?? ''
    const password = dbUrl.match(/\/\/[^:]+:([^@]+)@/)?.[1]
    const serialized = JSON.stringify(result)
    if (password !== undefined && password.length > 0) {
      expect(serialized).not.toContain(password)
    }
    expect(serialized).not.toContain(dbUrl)
    await client.close()
  })

  /**
   * Seed two parent memories + a proposed consolidation_proposals row for `user`
   * (owner connection — the consolidator that would CREATE them is a separate
   * track). Returns the proposal id and its from/to memory ids.
   */
  async function seedProposal(
    user: string,
    edgeType = 'supersedes',
    memoryType = 'fact',
    // The denormalized proposals column has no FK back to memories.memory_type;
    // passing a different value here seeds the stale-denormalization case.
    proposalMemoryType = memoryType,
  ): Promise<{ proposalId: string; fromId: string; toId: string }> {
    const m = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1,$4,'t','c',$2), ($1,$4,'t','c',$3) RETURNING id`,
      [user, `e2e-prop-${crypto.randomUUID()}`, `e2e-prop-${crypto.randomUUID()}`, memoryType],
    )
    const proposal = await ownerPool.query(
      `INSERT INTO consolidation_proposals
         (user_id, from_id, to_id, edge_type, memory_type, similarity, status)
       VALUES ($1,$2,$3,$4,$5,0.9,'proposed') RETURNING id`,
      [user, m.rows[0].id, m.rows[1].id, edgeType, proposalMemoryType],
    )
    return { proposalId: proposal.rows[0].id, fromId: m.rows[0].id, toId: m.rows[1].id }
  }

  it('review_proposals lists a seeded proposal and rejects it (proposed -> rejected, the row survives)', async () => {
    const { proposalId } = await seedProposal(userA)

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const listed = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'list' },
    })
    expect(listed.isError).toBeFalsy()
    const ids = (listed.structuredContent as { proposals: Array<{ id: string }> }).proposals.map(
      (p) => p.id,
    )
    expect(ids).toContain(proposalId)

    // reject -> proposed -> rejected (an UPDATE; the row survives).
    const rejected = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'reject', proposalId },
    })
    expect(rejected.isError).toBeFalsy()
    expect((rejected.structuredContent as { proposal: { status: string } }).proposal.status).toBe(
      'rejected',
    )

    // rejecting again -> not_found (no longer open).
    const again = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'reject', proposalId },
    })
    expect(again.isError).toBe(true)
    expect((again.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('not_found')
    await client.close()
  })

  it('review_proposals accept APPLIES: the edge exists, the predecessor closes, the proposal is applied', async () => {
    const { proposalId, fromId, toId } = await seedProposal(userA, 'supersedes')

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const accepted = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(accepted.isError).toBeFalsy()
    const out = accepted.structuredContent as {
      action: string
      proposal: { status: string; id: string }
    }
    expect(out.action).toBe('applied')
    expect(out.proposal.status).toBe('applied')
    expect(out.proposal.id).toBe(proposalId)

    // The proposed typed edge now exists (from_id -> to_id, edge_type).
    const edge = await ownerPool.query(
      `SELECT 1 FROM memory_edges
        WHERE user_id = $1 AND from_id = $2 AND to_id = $3 AND edge_type = 'supersedes'`,
      [userA, fromId, toId],
    )
    expect(edge.rowCount).toBe(1)

    // A supersedes edge closes the PREDECESSOR validity — content untouched. By the
    // load-bearing edge convention (search.ts keys supersession on e.to_id), the
    // predecessor is to_id, so to_id is the row that closes and from_id stays live.
    const predecessor = await ownerPool.query(
      `SELECT valid_to FROM memories WHERE user_id = $1 AND id = $2`,
      [userA, toId],
    )
    expect(predecessor.rows[0].valid_to).not.toBeNull()
    const successorStillLive = await ownerPool.query(
      `SELECT valid_to FROM memories WHERE user_id = $1 AND id = $2`,
      [userA, fromId],
    )
    expect(successorStillLive.rows[0].valid_to).toBeNull()
    const supersedeEvent = await ownerPool.query(
      `SELECT 1 FROM memory_events
        WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'supersede'`,
      [userA, toId],
    )
    expect(supersedeEvent.rowCount).toBe(1)

    // accepting an already-applied proposal -> not_found (no double-apply).
    const again = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(again.isError).toBe(true)
    expect((again.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('not_found')
    await client.close()
  })

  it('review_proposals accept REFUSES an event-type supersedes proposal (docs/concepts/memory-model.mdx "Consolidation is advisory" episodic exclusion)', async () => {
    const { proposalId, fromId, toId } = await seedProposal(userA, 'supersedes', 'event')

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const refused = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(refused.isError).toBe(true)
    expect((refused.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('conflict')

    // Nothing was materialized: no edge, neither memory closed, proposal still open.
    const edge = await ownerPool.query(
      `SELECT 1 FROM memory_edges WHERE user_id = $1 AND from_id = $2 AND to_id = $3`,
      [userA, fromId, toId],
    )
    expect(edge.rowCount).toBe(0)
    const validity = await ownerPool.query(
      `SELECT valid_to FROM memories WHERE user_id = $1 AND id = ANY($2)`,
      [userA, [fromId, toId]],
    )
    expect(validity.rows.every((r) => r.valid_to === null)).toBe(true)
    const status = await ownerPool.query(
      `SELECT status FROM consolidation_proposals WHERE id = $1`,
      [proposalId],
    )
    expect(status.rows[0].status).toBe('proposed')
    await client.close()
  })

  it('review_proposals accept REFUSES when the proposal memory_type is stale but an endpoint is an event memory (Codex P1)', async () => {
    // Denormalized consolidation_proposals.memory_type says 'fact', but the
    // actual memories rows are event-typed. The guard must read the LIVE
    // memories.memory_type — trusting the stale column would close an episodic
    // row's validity, the exact corruption docs/concepts/memory-model.mdx "Consolidation is advisory" bars.
    const { proposalId, fromId, toId } = await seedProposal(userA, 'supersedes', 'event', 'fact')

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const refused = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(refused.isError).toBe(true)
    expect((refused.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('conflict')

    // Nothing was materialized: no edge, neither memory closed, proposal still open.
    const edge = await ownerPool.query(
      `SELECT 1 FROM memory_edges WHERE user_id = $1 AND from_id = $2 AND to_id = $3`,
      [userA, fromId, toId],
    )
    expect(edge.rowCount).toBe(0)
    const validity = await ownerPool.query(
      `SELECT valid_to FROM memories WHERE user_id = $1 AND id = ANY($2)`,
      [userA, [fromId, toId]],
    )
    expect(validity.rows.every((r) => r.valid_to === null)).toBe(true)
    const status = await ownerPool.query(
      `SELECT status FROM consolidation_proposals WHERE id = $1`,
      [proposalId],
    )
    expect(status.rows[0].status).toBe('proposed')
    await client.close()
  })

  it('review_proposals accept CONFLICTS when the predecessor (to_id) is already superseded (no duplicate event)', async () => {
    const { proposalId, fromId, toId } = await seedProposal(userA, 'supersedes')
    // Pre-close the predecessor (to_id) by some OTHER path so the fresh edge would
    // land over a dead predecessor. The accept must refuse rather than emit a
    // second `supersede` event over the already-closed row.
    await ownerPool.query(`UPDATE memories SET valid_to = now() WHERE user_id = $1 AND id = $2`, [
      userA,
      toId,
    ])

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const refused = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(refused.isError).toBe(true)
    expect((refused.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('conflict')

    // Rolled back: no edge, no supersede event, proposal still open (no stuck flip).
    const edge = await ownerPool.query(
      `SELECT 1 FROM memory_edges WHERE user_id = $1 AND from_id = $2 AND to_id = $3`,
      [userA, fromId, toId],
    )
    expect(edge.rowCount).toBe(0)
    const supersedeEvent = await ownerPool.query(
      `SELECT 1 FROM memory_events
        WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'supersede'`,
      [userA, toId],
    )
    expect(supersedeEvent.rowCount).toBe(0)
    const status = await ownerPool.query(
      `SELECT status FROM consolidation_proposals WHERE id = $1`,
      [proposalId],
    )
    expect(status.rows[0].status).toBe('proposed')
    await client.close()
  })

  it('review_proposals accept CONFLICTS when the successor (from_id) is no longer live (stale proposal, Codex P1)', async () => {
    const { proposalId, fromId, toId } = await seedProposal(userA, 'supersedes')
    // The proposal sat queued while from_id (the proposed SUCCESSOR) was itself
    // superseded by a later revise. Applying now would close the still-live
    // predecessor and hang the supersedes edge FROM a dead memory — neither
    // side of that knowledge would stay live. Accept must refuse, before any
    // write, and leave the proposal open for the existing reject path.
    await ownerPool.query(`UPDATE memories SET valid_to = now() WHERE user_id = $1 AND id = $2`, [
      userA,
      fromId,
    ])

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const refused = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(refused.isError).toBe(true)
    expect((refused.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('no longer live')

    // Nothing was written: no edge, the predecessor (to_id) is STILL live, no
    // supersede event, and the proposal stays `proposed` (re-propose or reject).
    const edge = await ownerPool.query(
      `SELECT 1 FROM memory_edges WHERE user_id = $1 AND from_id = $2 AND to_id = $3`,
      [userA, fromId, toId],
    )
    expect(edge.rowCount).toBe(0)
    const predecessor = await ownerPool.query(
      `SELECT valid_to FROM memories WHERE user_id = $1 AND id = $2`,
      [userA, toId],
    )
    expect(predecessor.rows[0].valid_to).toBeNull()
    const supersedeEvent = await ownerPool.query(
      `SELECT 1 FROM memory_events
        WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'supersede'`,
      [userA, toId],
    )
    expect(supersedeEvent.rowCount).toBe(0)
    const status = await ownerPool.query(
      `SELECT status FROM consolidation_proposals WHERE id = $1`,
      [proposalId],
    )
    expect(status.rows[0].status).toBe('proposed')
    await client.close()
  })

  it('review_proposals accept is IDEMPOTENT when the proposed edge already exists (no stuck proposal)', async () => {
    const { proposalId, fromId, toId } = await seedProposal(userA, 'supersedes')
    // A prior revise/apply already materialized the EXACT proposed edge. The
    // proposal's intent is met, so accept must flip it to `applied` rather than
    // strand it `proposed` behind an un-actionable 409.
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'supersedes', 'system')`,
      [userA, fromId, toId],
    )

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const accepted = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(accepted.isError).toBeFalsy()
    const out = accepted.structuredContent as {
      action: string
      proposal: { status: string; id: string }
    }
    expect(out.action).toBe('applied')
    expect(out.proposal.status).toBe('applied')
    expect(out.proposal.id).toBe(proposalId)

    // No duplicate edge, and the idempotent path did NOT add a second supersede
    // event (the original close/audit is the prior write's responsibility).
    const edge = await ownerPool.query(
      `SELECT count(*)::int AS n FROM memory_edges
        WHERE user_id = $1 AND from_id = $2 AND to_id = $3 AND edge_type = 'supersedes'`,
      [userA, fromId, toId],
    )
    expect(edge.rows[0].n).toBe(1)
    const status = await ownerPool.query(
      `SELECT status FROM consolidation_proposals WHERE id = $1`,
      [proposalId],
    )
    expect(status.rows[0].status).toBe('applied')
    await client.close()
  })

  it('review_proposals accept MOVES the predecessor open commitment to a commitment-type successor (#127)', async () => {
    // Both endpoints are commitment-type; only the predecessor (to_id) rides an
    // open commitments row. Accepting the supersedes proposal closes to_id, so
    // the obligation must MOVE to the live successor (carryCommitment's
    // commitment->commitment case) — not strand invisibly on the closed row
    // (briefing inner-joins commitments -> memories with valid_to IS NULL).
    const { proposalId, fromId, toId } = await seedProposal(userA, 'supersedes', 'commitment')
    const seeded = await ownerPool.query(
      `INSERT INTO commitments (user_id, memory_id) VALUES ($1, $2) RETURNING id`,
      [userA, toId],
    )
    const commitmentId = seeded.rows[0].id

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const accepted = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(accepted.isError).toBeFalsy()

    // The SAME row (FSM state intact, still open) now rides the live successor.
    const moved = await ownerPool.query(
      `SELECT memory_id, status, resolved_at FROM commitments WHERE id = $1`,
      [commitmentId],
    )
    expect(moved.rows[0].memory_id).toBe(fromId)
    expect(moved.rows[0].status).toBe('open')
    expect(moved.rows[0].resolved_at).toBeNull()
    await client.close()
  })

  it('review_proposals accept RESOLVES the predecessor commitment when the successor rides its own row (#127 Option A)', async () => {
    // The dedupe case: both endpoints are commitment-type and EACH rides its own
    // open commitments row. The move is impossible (commitments_memory_idx is
    // UNIQUE per memory) and the successor's row carries the live obligation, so
    // the predecessor's row must be explicitly transitioned to 'resolved' —
    // never silently stranded open on the closed memory.
    const { proposalId, fromId, toId } = await seedProposal(userA, 'supersedes', 'commitment')
    const predecessorRow = await ownerPool.query(
      `INSERT INTO commitments (user_id, memory_id) VALUES ($1, $2) RETURNING id`,
      [userA, toId],
    )
    const successorRow = await ownerPool.query(
      `INSERT INTO commitments (user_id, memory_id) VALUES ($1, $2) RETURNING id`,
      [userA, fromId],
    )

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const accepted = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(accepted.isError).toBeFalsy()

    // Predecessor's row: resolved (DB-clock stamp), still pointing at to_id.
    const resolved = await ownerPool.query(
      `SELECT memory_id, status, resolved_at FROM commitments WHERE id = $1`,
      [predecessorRow.rows[0].id],
    )
    expect(resolved.rows[0].memory_id).toBe(toId)
    expect(resolved.rows[0].status).toBe('resolved')
    expect(resolved.rows[0].resolved_at).not.toBeNull()

    // Successor's own row is untouched — it carries the live obligation.
    const untouched = await ownerPool.query(
      `SELECT memory_id, status, resolved_at FROM commitments WHERE id = $1`,
      [successorRow.rows[0].id],
    )
    expect(untouched.rows[0].memory_id).toBe(fromId)
    expect(untouched.rows[0].status).toBe('open')
    expect(untouched.rows[0].resolved_at).toBeNull()

    // The explicit close is audited on the predecessor memory (the
    // transitionCommitment pattern).
    const resolveEvent = await ownerPool.query(
      `SELECT 1 FROM memory_events
        WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'resolve'`,
      [userA, toId],
    )
    expect(resolveEvent.rowCount).toBe(1)
    await client.close()
  })

  it("TENANT ISOLATION: B cannot accept A's proposal (RLS hides it -> not_found)", async () => {
    const { proposalId } = await seedProposal(userA)

    const clientB = await connect(app.baseUrl, `Bearer ${tokenB}`)
    const blocked = await clientB.callTool({
      name: 'review_proposals',
      arguments: { action: 'accept', proposalId },
    })
    expect(blocked.isError).toBe(true)
    expect((blocked.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('not_found')
    await clientB.close()

    // A's proposal is untouched (still proposed): RLS made it invisible to B.
    const still = await ownerPool.query(
      `SELECT status FROM consolidation_proposals WHERE id = $1`,
      [proposalId],
    )
    expect(still.rows[0].status).toBe('proposed')
  })

  it('TWO-LAYER SCOPE: a read-only token may list proposals but not reject', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenReadOnly}`)
    const listed = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'list' },
    })
    expect(listed.isError).toBeFalsy()
    const blocked = await client.callTool({
      name: 'review_proposals',
      arguments: { action: 'reject', proposalId: crypto.randomUUID() },
    })
    expect(blocked.isError).toBe(true)
    expect((blocked.content as Array<{ text?: string }>)[0]?.text ?? '').toContain(
      'insufficient scope',
    )
    await client.close()
  })
})

describe('/mcp briefing + handoff end-to-end (D2, real transport, runtime role)', () => {
  /** Force a past due_at on the commitment riding `memoryId` (owner connection). */
  async function setDueAtPast(memoryId: string): Promise<void> {
    await ownerPool.query(
      `UPDATE commitments SET due_at = now() - interval '2 days' WHERE memory_id = $1`,
      [memoryId],
    )
  }

  it('briefing requires a selector: a call without one is an error, no firehose', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const result = await client.callTool({ name: 'briefing', arguments: {} })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it('briefing surfaces open commitments with the overdue split for the tenant', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const tag = crypto.randomUUID()
    const written = await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'commitment',
        topic: 'ship d2',
        content: `briefing-overdue-${tag} open the d2 PR`,
        scope: 'work',
      },
    })
    const memoryId = (written.structuredContent as { memory: { id: string } }).memory.id
    await setDueAtPast(memoryId)

    const briefed = await client.callTool({
      name: 'briefing',
      arguments: { selector: { kind: 'scope', scope: 'work' }, mode: 'full' },
    })
    expect(briefed.isError).toBeFalsy()
    const structured = briefed.structuredContent as {
      commitments: { count: number; items: Array<{ memoryId: string; overdue: boolean }> }
      overdue: { count: number; items: Array<{ memoryId: string }> }
    }
    // The open commitment is present, and its past due_at puts it in the overdue split.
    expect(structured.commitments.items.some((c) => c.memoryId === memoryId && c.overdue)).toBe(
      true,
    )
    expect(structured.overdue.items.some((c) => c.memoryId === memoryId)).toBe(true)
    await client.close()
  })

  it('briefing brief mode returns counts + a bounded top slice (no content)', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const tag = crypto.randomUUID()
    await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'decision',
        topic: 'pin',
        content: `brief-decision-${tag}`,
        scope: 'work',
      },
    })
    const briefed = await client.callTool({
      name: 'briefing',
      arguments: { selector: { kind: 'scope', scope: 'work' } },
    })
    const structured = briefed.structuredContent as {
      mode: string
      recentDecisions: { count: number; items: unknown[] }
    }
    expect(structured.mode).toBe('brief')
    // brief caps the slice at the top constant even as the count grows.
    expect(structured.recentDecisions.items.length).toBeLessThanOrEqual(3)
    await client.close()
  })

  it('enforces tenant isolation: B briefing over work does not see A commitments', async () => {
    const clientA = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const tag = crypto.randomUUID()
    const written = await clientA.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'commitment',
        topic: 'a-only',
        content: `a-isolation-${tag}`,
        scope: 'work',
      },
    })
    const memoryId = (written.structuredContent as { memory: { id: string } }).memory.id
    await clientA.close()

    const clientB = await connect(app.baseUrl, `Bearer ${tokenB}`)
    const briefed = await clientB.callTool({
      name: 'briefing',
      arguments: { selector: { kind: 'scope', scope: 'work' }, mode: 'full' },
    })
    const structured = briefed.structuredContent as {
      commitments: { items: Array<{ memoryId: string }> }
    }
    expect(structured.commitments.items.some((c) => c.memoryId === memoryId)).toBe(false)
    await clientB.close()
  })

  it('handoff round-trips the structured shape with content for the tenant', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const tag = crypto.randomUUID()
    const decisionContent = `handoff-decision-${tag} pin the sdk`
    await client.callTool({
      name: 'remember',
      arguments: {
        memoryType: 'decision',
        topic: 'handoff pin',
        content: decisionContent,
        scope: 'work',
      },
    })
    const handed = await client.callTool({
      name: 'handoff',
      arguments: { selector: { kind: 'scope', scope: 'work' }, generatedFor: 'agent-b' },
    })
    expect(handed.isError).toBeFalsy()
    const structured = handed.structuredContent as {
      generatedFor: string | null
      decisions: Array<{ content: string }>
      commitments: unknown[]
      preferences: unknown[]
      notes: unknown[]
    }
    expect(structured.generatedFor).toBe('agent-b')
    // A handoff CARRIES content by design (the difference from a briefing / logs).
    expect(structured.decisions.some((d) => d.content === decisionContent)).toBe(true)
    expect(Array.isArray(structured.notes)).toBe(true)
    await client.close()
  })

  it('handoff EXCERPTS a >2,000-char decision instead of failing output validation (#238)', async () => {
    // Import-provenance rows exceed the 2,000-char write cap (the migration
    // corpus reaches ~245K); before the fix one such decision made
    // handoffMemorySchema reject the WHOLE handoff. Seed one directly (the
    // remember path caps at 2,000, exactly like the real corpus arrived) and
    // prove the export comes back as a bounded, marked excerpt.
    const tag = crypto.randomUUID()
    const stored = `handoff-excerpt-${tag} ${'imported decision body '.repeat(150)}`.trim()
    expect(stored.length).toBeGreaterThan(2000)
    await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, scope)
       VALUES ($1, 'decision', 'long import', $2, $3, 'work')`,
      [userA, stored, `e2e-handoff-excerpt-${tag}`],
    )

    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const handed = await client.callTool({
      name: 'handoff',
      arguments: { selector: { kind: 'scope', scope: 'work' } },
    })
    expect(handed.isError).toBeFalsy()
    const structured = handed.structuredContent as {
      decisions: Array<{ content: string; contentLength: number; truncated: boolean }>
    }
    const line = structured.decisions.find((d) => d.content.includes(tag))
    expect(line).toBeDefined()
    expect(line?.content.length).toBe(MAX_EXCERPT_LENGTH)
    expect(line?.content.endsWith(EXCERPT_MARKER)).toBe(true)
    expect(line?.contentLength).toBe(stored.length)
    expect(line?.truncated).toBe(true)
    await client.close()
  })

  it('handoff requires a selector and is read-scoped (read-only token allowed)', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenReadOnly}`)
    const missing = await client.callTool({ name: 'handoff', arguments: {} })
    expect(missing.isError).toBe(true)
    const ok = await client.callTool({
      name: 'handoff',
      arguments: { selector: { kind: 'all' } },
    })
    expect(ok.isError).toBeFalsy()
    await client.close()
  })
})

describe('/mcp prompts end-to-end (D5, real transport, runtime role)', () => {
  it('lists the two code-defined prompts (briefing, debrief) through the transport', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual(['briefing', 'debrief'])
    await client.close()
  })

  it('gets the briefing prompt with args, rendering orienting text', async () => {
    const client = await connect(app.baseUrl, `Bearer ${tokenA}`)
    const result = await client.getPrompt({
      name: 'briefing',
      arguments: { selector: 'all', mode: 'brief' },
    })
    expect(result.messages).toHaveLength(1)
    const text = result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('briefing')
    expect(text).toContain('"kind": "all"')
    await client.close()
  })

  it('Bearer is required: prompts/list 401s without a token (transport-gated)', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })
})
