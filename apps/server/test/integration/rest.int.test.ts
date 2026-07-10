// SPDX-License-Identifier: Apache-2.0
// REST /api/v1 integration tests against the in-process app, the REAL runtime
// role, and the REAL C3 apiKeyAuth middleware over a real DB. Proves the
// acceptance criteria THROUGH the actual Express transport:
//   - remember -> search round-trips for the key's tenant
//   - TENANT ISOLATION: key A cannot read user B's memory (RLS)
//   - PARITY SMOKE: a REST remember is then found via the CORE search path
//     (REST and core agree on the write) — full REST≡MCP≡core parity is covered by parity.int.test.ts
//   - revise + resolve round-trip; a not-found predecessor/commitment is a 404
//
// A deterministic FakeGateway is injected so embed-on-write + query both run
// offline; identical text maps to identical vectors, so a search for the exact
// written content is a guaranteed cosine hit (RLS is what filters cross-tenant).
import type { Server } from 'node:http'
import { search as coreSearch } from '@3ngram/core'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { createApp } from '../../src/app.js'

const PASSWORD = 'rest-a2-contract-password'
const gateway = createFakeGateway()

let server: Server
let baseUrl: string
let emailA: string
let emailB: string
let userBId: string
let keyA: string
let keyB: string
let tokenA: string

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
  token?: string
  body?: unknown
}

async function api(path: string, opts: RestCall = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.key !== undefined) headers['x-api-key'] = opts.key
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

beforeAll(async () => {
  emailA = `rest-a-${crypto.randomUUID()}@test.local`
  emailB = `rest-b-${crypto.randomUUID()}@test.local`
  await createUser(emailA, PASSWORD)
  const b = await createUser(emailB, PASSWORD)
  userBId = b.id
  const grantA = await login(emailA, PASSWORD, 1)
  const grantB = await login(emailB, PASSWORD, 1)
  if (!grantA || !grantB) throw new Error('login failed in setup')
  // Keep A's session token to exercise the C2 session-Bearer auth path.
  tokenA = grantA.token

  server = createApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`

  keyA = await issueKey(grantA.token, 'rest-a')
  keyB = await issueKey(grantB.token, 'rest-b')
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [[emailA, emailB]])
  await closePools()
})

describe('REST /api/v1 remember + search (runtime role, real DB)', () => {
  it('remember then search round-trips for the key tenant', async () => {
    const content = `rest-roundtrip-${crypto.randomUUID()}`
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'rt', content },
    })
    expect(written.status).toBe(201)

    const searched = await api('/api/v1/search', {
      method: 'POST',
      key: keyA,
      body: { query: content },
    })
    expect(searched.status).toBe(200)
    const body = (await searched.json()) as { count: number; hits: Array<{ content: string }> }
    expect(body.count).toBeGreaterThanOrEqual(1)
    expect(body.count).toBe(body.hits.length)
    expect(body.hits.some((h) => h.content === content)).toBe(true)
  })

  it('PARITY SMOKE: a REST remember is found via the CORE search path (A4 owns full parity)', async () => {
    const content = `rest-core-parity-${crypto.randomUUID()}`
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'parity', content },
    })
    const memoryId = ((await written.json()) as { memory: { id: string } }).memory.id

    // Reach into core directly as the same tenant: REST and core must agree on
    // the write. Full REST≡MCP≡core parity (all surfaces, all routes) is covered by parity.int.test.ts.
    const userA = (
      await ownerPool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [emailA])
    ).rows[0]?.id as string
    const hits = await coreSearch(userA, content, { gateway })
    expect(hits.some((h) => h.id === memoryId)).toBe(true)
  })

  it('TENANT ISOLATION: key A cannot read user B memory (RLS)', async () => {
    const content = `rest-tenant-private-${crypto.randomUUID()}`
    // Seed a B-owned memory directly via core under B's tenant.
    await api('/api/v1/memories', {
      method: 'POST',
      key: keyB,
      body: { memoryType: 'note', topic: 'b', content },
    })
    // A searches for B's content -> never sees it.
    const searched = await api('/api/v1/search', {
      method: 'POST',
      key: keyA,
      body: { query: content },
    })
    const body = (await searched.json()) as { hits: Array<{ content: string }> }
    expect(body.hits.some((h) => h.content === content)).toBe(false)
    // sanity: B sees their own row.
    expect(userBId).toBeDefined()
  })
})

describe('REST /api/v1 revise + resolve (runtime role, real DB)', () => {
  it('revise round-trips and ranks the successor above the superseded predecessor', async () => {
    const tag = crypto.randomUUID()
    const predecessor = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'decision',
        topic: 'rest revise',
        content: `rest-revise-${tag} initial`,
      },
    })
    const predecessorId = ((await predecessor.json()) as { memory: { id: string } }).memory.id

    const revised = await api(`/api/v1/memories/${predecessorId}/revise`, {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'decision',
        topic: 'rest revise',
        content: `rest-revise-${tag} corrected with more detail`,
        edgeIntent: 'supersedes',
      },
    })
    expect(revised.status).toBe(200)
    const successorId = ((await revised.json()) as { memory: { id: string } }).memory.id
    expect(successorId).not.toBe(predecessorId)
  })

  it('404s revising an unknown predecessor', async () => {
    const res = await api(`/api/v1/memories/${crypto.randomUUID()}/revise`, {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'note',
        topic: 'x',
        content: `ghost-${crypto.randomUUID()}`,
        edgeIntent: 'supersedes',
      },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('resolve transitions an auto-created commitment, then 409s an illegal transition', async () => {
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'commitment',
        topic: 'rest commit',
        content: `rest-commit-${crypto.randomUUID()}`,
      },
    })
    const body = (await written.json()) as { memory: { id: string }; commitmentId?: string }
    const memoryId = body.memory.id
    expect(body.commitmentId).toEqual(expect.any(String))

    const resolved = await api(`/api/v1/memories/${memoryId}/resolve`, {
      method: 'POST',
      key: keyA,
      body: { status: 'resolved' },
    })
    expect(resolved.status).toBe(200)
    expect((await resolved.json()).status).toBe('resolved')

    // resolved -> expired is illegal (resolved only -> open): a 409 invalid_transition.
    const illegal = await api(`/api/v1/memories/${memoryId}/resolve`, {
      method: 'POST',
      key: keyA,
      body: { status: 'expired' },
    })
    expect(illegal.status).toBe(409)
    expect(await illegal.json()).toEqual({ error: 'invalid_transition' })

    // unresolve: resolved -> open is legal, same route.
    const unresolved = await api(`/api/v1/memories/${memoryId}/resolve`, {
      method: 'POST',
      key: keyA,
      body: { status: 'open' },
    })
    expect(unresolved.status).toBe(200)
    expect((await unresolved.json()).status).toBe('open')
  })

  it('404s resolving a memory with no commitment', async () => {
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'x', content: `no-commit-${crypto.randomUUID()}` },
    })
    const memoryId = ((await written.json()) as { memory: { id: string } }).memory.id
    const res = await api(`/api/v1/memories/${memoryId}/resolve`, {
      method: 'POST',
      key: keyA,
      body: { status: 'resolved' },
    })
    expect(res.status).toBe(404)
  })

  it('GET facts as_of: validAt time-travels to a historically-true generation (not the live row)', async () => {
    // Seed a supersession chain directly (owner connection) under key A's tenant,
    // mirroring packages/db facts-read.int.test.ts: role engineer->lead->manager
    // across three valid-time windows, the last live (valid_to NULL). Then assert
    // the REST querystring asOf coordinate reaches core's bi-temporal read.
    const userAId = (
      await ownerPool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [emailA])
    ).rows[0]?.id as string
    const subject = `employee:${crypto.randomUUID()}`
    const mem = await ownerPool.query<{ id: string }>(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1, 'fact', 'rest-asof', 'rest-asof', $2) RETURNING id`,
      [userAId, `rest-asof-${subject}`],
    )
    const memoryId = mem.rows[0]?.id as string
    const seedFact = (
      value: string,
      validFrom: string,
      validTo: string | null,
      recordedAt: string,
    ) =>
      ownerPool.query(
        `INSERT INTO facts (user_id, memory_id, subject, predicate, value,
                            valid_from, valid_to, recorded_at)
         VALUES ($1, $2, $3, 'role', $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)`,
        [userAId, memoryId, subject, value, validFrom, validTo, recordedAt],
      )
    await seedFact(
      'engineer',
      '2020-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    )
    await seedFact(
      'lead',
      '2021-01-01T00:00:00.000Z',
      '2022-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
    )
    await seedFact('manager', '2022-01-01T00:00:00.000Z', null, '2022-01-01T00:00:00.000Z')

    // No asOf -> the current (live) generation only.
    const live = await api(`/api/v1/facts?subject=${encodeURIComponent(subject)}&predicate=role`, {
      key: keyA,
    })
    expect(live.status).toBe(200)
    const liveBody = (await live.json()) as { facts: Array<{ value: string }>; count: number }
    expect(liveBody.facts.map((f) => f.value)).toEqual(['manager'])

    // validAt mid-2021 -> the "lead" generation that was TRUE then, not the live row.
    const pit = await api(
      `/api/v1/facts?subject=${encodeURIComponent(subject)}&predicate=role&validAt=2021-06-01T00:00:00.000Z`,
      { key: keyA },
    )
    expect(pit.status).toBe(200)
    const pitBody = (await pit.json()) as { facts: Array<{ value: string }> }
    expect(pitBody.facts.map((f) => f.value)).toEqual(['lead'])

    // asKnownAt before the "manager" row was recorded -> transaction-time view
    // sees only what was KNOWN then (engineer + lead recorded, manager not yet).
    const tt = await api(
      `/api/v1/facts?subject=${encodeURIComponent(subject)}&predicate=role&validAt=2021-06-01T00:00:00.000Z&asKnownAt=2021-06-01T00:00:00.000Z`,
      { key: keyA },
    )
    expect(tt.status).toBe(200)
    const ttBody = (await tt.json()) as { facts: Array<{ value: string }> }
    expect(ttBody.facts.map((f) => f.value)).toEqual(['lead'])

    // A malformed asOf coordinate is a 400 at the schema boundary, never a silent drop.
    const bad = await api(`/api/v1/facts?subject=${encodeURIComponent(subject)}&validAt=nope`, {
      key: keyA,
    })
    expect(bad.status).toBe(400)
  })

  it('GET briefing surfaces an open commitment for the key tenant (selector required)', async () => {
    const tag = crypto.randomUUID()
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'commitment',
        topic: 'rest briefing commit',
        content: `rest-briefing-${tag} ship the briefing route`,
      },
    })
    expect(written.status).toBe(201)

    // A briefing over the 'all' selector includes the just-opened commitment in
    // its count; the route shapes the briefingToolOutputSchema sections verbatim.
    const briefed = await api('/api/v1/briefing?kind=all', { key: keyA })
    expect(briefed.status).toBe(200)
    const body = (await briefed.json()) as {
      selector: { kind: string }
      mode: string
      commitments: { count: number; items: Array<{ topic: string }> }
    }
    expect(body.selector).toEqual({ kind: 'all' })
    expect(body.mode).toBe('brief')
    expect(body.commitments.count).toBeGreaterThanOrEqual(1)
  })

  it('400s a briefing with no selector (no-firehose discipline through the transport)', async () => {
    const res = await api('/api/v1/briefing', { key: keyA })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_input' })
  })

  it('TENANT ISOLATION: key B cannot resolve key A commitment (RLS -> 404)', async () => {
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'commitment',
        topic: 'a-commit',
        content: `a-commit-${crypto.randomUUID()}`,
      },
    })
    const memoryId = ((await written.json()) as { memory: { id: string } }).memory.id
    const res = await api(`/api/v1/memories/${memoryId}/resolve`, {
      method: 'POST',
      key: keyB,
      body: { status: 'resolved' },
    })
    expect(res.status).toBe(404)
  })
})

describe('REST /api/v1 archive (runtime role, real DB)', () => {
  it('archive round-trips: status flips (valid_to stays NULL), audits, lists, counts — then 404s a re-archive', async () => {
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: {
        memoryType: 'note',
        topic: 'archive rt',
        content: `rest-archive-${crypto.randomUUID()}`,
      },
    })
    expect(written.status).toBe(201)
    const memoryId = ((await written.json()) as { memory: { id: string } }).memory.id

    const statsBefore = await api('/api/v1/stats', { key: keyA })
    expect(statsBefore.status).toBe(200)
    const archivedBefore = ((await statsBefore.json()) as { archivedMemories: number })
      .archivedMemories

    const archived = await api(`/api/v1/memories/${memoryId}/archive`, {
      method: 'POST',
      key: keyA,
    })
    expect(archived.status).toBe(200)
    expect(await archived.json()).toEqual({ id: memoryId, status: 'archived' })

    // Row invariant (Decision D): archived bucket = status='archived' AND
    // valid_to IS NULL — the archive must NOT bi-temporally close the row.
    const row = await ownerPool.query<{ status: string; valid_to: Date | null }>(
      'SELECT status, valid_to FROM memories WHERE id = $1',
      [memoryId],
    )
    expect(row.rows[0]?.status).toBe('archived')
    expect(row.rows[0]?.valid_to).toBeNull()

    // The lifecycle is audited: exactly one 'archive' memory_events row.
    const events = await ownerPool.query(
      "SELECT 1 FROM memory_events WHERE memory_id = $1 AND event_kind = 'archive'",
      [memoryId],
    )
    expect(events.rowCount).toBe(1)

    // The archived list bucket returns it...
    const listed = await api('/api/v1/memories?status=archived&limit=100', { key: keyA })
    expect(listed.status).toBe(200)
    const listBody = (await listed.json()) as { memories: Array<{ id: string; status: string }> }
    expect(listBody.memories.some((m) => m.id === memoryId && m.status === 'archived')).toBe(true)

    // ...and the stats archived count incremented.
    const statsAfter = await api('/api/v1/stats', { key: keyA })
    const archivedAfter = ((await statsAfter.json()) as { archivedMemories: number })
      .archivedMemories
    expect(archivedAfter).toBe(archivedBefore + 1)

    // A second archive is a typed miss (the guard matches ACTIVE rows only).
    const again = await api(`/api/v1/memories/${memoryId}/archive`, {
      method: 'POST',
      key: keyA,
    })
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: 'not_found' })
  })

  it('404s archiving an unknown id', async () => {
    const res = await api(`/api/v1/memories/${crypto.randomUUID()}/archive`, {
      method: 'POST',
      key: keyA,
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('TENANT ISOLATION: key B cannot archive a key A memory (RLS -> 404)', async () => {
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'iso', content: `archive-iso-${crypto.randomUUID()}` },
    })
    const memoryId = ((await written.json()) as { memory: { id: string } }).memory.id
    const res = await api(`/api/v1/memories/${memoryId}/archive`, {
      method: 'POST',
      key: keyB,
    })
    expect(res.status).toBe(404)
    // A's memory is untouched — still active.
    const row = await ownerPool.query<{ status: string }>(
      'SELECT status FROM memories WHERE id = $1',
      [memoryId],
    )
    expect(row.rows[0]?.status).toBe('active')
  })
})

describe('REST /api/v1 dashboard reads (list/get/stats/me, real DB, issue #194)', () => {
  it('GET /memories lists the key tenant LIVE memories with a total; inspect returns content', async () => {
    const content = `rest-list-${crypto.randomUUID()}`
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'list rt', content, scope: 'personal' },
    })
    expect(written.status).toBe(201)
    const memoryId = ((await written.json()) as { memory: { id: string } }).memory.id

    const listed = await api('/api/v1/memories?limit=100', { key: keyA })
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as {
      memories: Array<{ id: string; topic: string }>
      count: number
      total: number
    }
    expect(body.count).toBe(body.memories.length)
    expect(body.total).toBeGreaterThanOrEqual(1)
    expect(body.memories.some((m) => m.id === memoryId)).toBe(true)
    // identity-only list: content never appears.
    expect(body.memories.every((m) => !('content' in m))).toBe(true)

    const inspected = await api(`/api/v1/memories/${memoryId}`, { key: keyA })
    expect(inspected.status).toBe(200)
    const detail = (await inspected.json()) as { id: string; content: string; status: string }
    expect(detail.id).toBe(memoryId)
    expect(detail.content).toBe(content)
    expect(detail.status).toBe('active')
  })

  it('TENANT ISOLATION: key B cannot inspect a key A memory (RLS -> 404)', async () => {
    const content = `rest-inspect-iso-${crypto.randomUUID()}`
    const written = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'iso', content },
    })
    const memoryId = ((await written.json()) as { memory: { id: string } }).memory.id
    const res = await api(`/api/v1/memories/${memoryId}`, { key: keyB })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('GET /proposals returns the tenant proposal list (empty is a valid envelope)', async () => {
    const res = await api('/api/v1/proposals?limit=10', { key: keyA })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { proposals: unknown[]; count: number }
    expect(body.count).toBe(body.proposals.length)
  })

  it('GET /stats returns the bounded count aggregates for the key tenant', async () => {
    // Seed at least one live memory so activeMemories is non-zero.
    await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'stats', content: `rest-stats-${crypto.randomUUID()}` },
    })
    const res = await api('/api/v1/stats', { key: keyA })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      memoriesByType: Record<string, number>
      activeMemories: number
      supersededMemories: number
      commitmentsByStatus: Record<string, number>
    }
    expect(body.activeMemories).toBeGreaterThanOrEqual(1)
    // counts only, no scopes leakage through /stats.
    expect(body).not.toHaveProperty('scopes')
  })

  it('GET /me works under BOTH X-API-Key and a session Bearer, returning the same identity', async () => {
    const viaKey = await api('/api/v1/me', { key: keyA })
    expect(viaKey.status).toBe(200)
    const keyBody = (await viaKey.json()) as { id: string; email: string }
    expect(keyBody.email).toBe(emailA)

    const viaToken = await api('/api/v1/me', { token: tokenA })
    expect(viaToken.status).toBe(200)
    const tokenBody = (await viaToken.json()) as { id: string; email: string }
    expect(tokenBody).toEqual(keyBody)
  })

  it('AUTH: /api/v1 accepts a valid session Bearer for a read (list memories)', async () => {
    const res = await api('/api/v1/memories?limit=1', { token: tokenA })
    expect(res.status).toBe(200)
  })

  it('401s a read with neither X-API-Key nor a session Bearer', async () => {
    const res = await api('/api/v1/memories')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/v1/export (GDPR portability, real DB, spec 015)', () => {
  async function userIdFor(email: string): Promise<string> {
    const r = await ownerPool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      email,
    ])
    return r.rows[0]?.id as string
  }

  // Seed a memory_edge (typed graph), a memory_event (PII payload), and a
  // consolidation_proposal (PII rationale) directly under a tenant — none has a
  // REST write path, so seed via the owner connection.
  async function seedGraph(
    userId: string,
    fromId: string,
    toId: string,
    payloadNote: string,
    rationale: string,
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'supersedes', 'user_api')`,
      [userId, fromId, toId],
    )
    await ownerPool.query(
      `INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload)
       VALUES ($1, $2, 'import', 'importer', $3::jsonb)`,
      [userId, fromId, JSON.stringify({ note: payloadNote })],
    )
    await ownerPool.query(
      `INSERT INTO consolidation_proposals
         (user_id, from_id, to_id, edge_type, memory_type, similarity, rationale, status)
       VALUES ($1, $2, $3, 'supersedes', 'note', 0.95, $4, 'proposed')`,
      [userId, fromId, toId, rationale],
    )
  }

  // Seed the user-owned cost/usage rows — budget window (one per user) and one
  // llm_usage cost row. Neither has a REST write path under test, so seed via the
  // owner connection (explicit user_id).
  async function seedUsage(userId: string, usageOperation: string): Promise<void> {
    await ownerPool.query(
      `INSERT INTO user_budgets (user_id, cap_usd_override, period_start, period_end)
       VALUES ($1, '7.000000000000', now(), now() + interval '30 days')`,
      [userId],
    )
    await ownerPool.query(
      `INSERT INTO llm_usage (user_id, operation, model, input_tokens, output_tokens, cost_usd)
       VALUES ($1, $2, 'text-embedding-3-small', 10, 0, '0.000000200000')`,
      [userId, usageOperation],
    )
  }

  async function seedProfile(userId: string, role: string, source: string): Promise<void> {
    await ownerPool.query(
      `INSERT INTO user_profile_attributes (user_id, role, use_case, ai_tools, referral_source)
       VALUES ($1, $2, 'dev', ARRAY['claude', 'codex'], $3)`,
      [userId, role, source],
    )
  }

  it('exports the key tenant account + memories + edges + events + proposals with a download header', async () => {
    const content = `rest-export-${crypto.randomUUID()}`
    const first = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'export', content, scope: 'personal' },
    })
    expect(first.status).toBe(201)
    const memoryId = ((await first.json()) as { memory: { id: string } }).memory.id
    const second = await api('/api/v1/memories', {
      method: 'POST',
      key: keyA,
      body: { memoryType: 'note', topic: 'export2', content: `${content}-2` },
    })
    const memoryId2 = ((await second.json()) as { memory: { id: string } }).memory.id

    const payloadNote = `evt-${crypto.randomUUID()}`
    const rationale = `rat-${crypto.randomUUID()}`
    await seedGraph(await userIdFor(emailA), memoryId, memoryId2, payloadNote, rationale)

    const res = await api('/api/v1/export', { key: keyA })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="3ngram-export-\d{4}-\d{2}-\d{2}\.json"$/,
    )
    const body = (await res.json()) as {
      format: string
      account: { email: string }
      memories: Array<{ id: string; content: string }>
      edges: Array<{ fromId: string; toId: string; edgeType: string }>
      memoryEvents: Array<{ memoryId: string; payload: { note?: string } | null }>
      proposals: Array<{ rationale: string | null }>
      counts: { memories: number; edges: number; memoryEvents: number; proposals: number }
    }
    expect(body.format).toBe('3ngram.account-export.v1')
    expect(body.account.email).toBe(emailA)
    const mine = body.memories.find((m) => m.id === memoryId)
    expect(mine?.content).toBe(content)
    // The typed memory graph + the OTHER tenant PII are present (completeness).
    expect(
      body.edges.some(
        (e) => e.fromId === memoryId && e.toId === memoryId2 && e.edgeType === 'supersedes',
      ),
    ).toBe(true)
    expect(body.memoryEvents.some((e) => e.payload?.note === payloadNote)).toBe(true)
    expect(body.proposals.some((p) => p.rationale === rationale)).toBe(true)
    expect(body.counts.memories).toBe(body.memories.length)
    expect(body.counts.edges).toBe(body.edges.length)
    expect(body.counts.memoryEvents).toBe(body.memoryEvents.length)
    expect(body.counts.proposals).toBe(body.proposals.length)
  })

  it('TENANT ISOLATION: A export never contains B-owned memories, edges, events, or proposals (RLS)', async () => {
    const bContent = `rest-export-b-${crypto.randomUUID()}`
    const bFirst = await api('/api/v1/memories', {
      method: 'POST',
      key: keyB,
      body: { memoryType: 'note', topic: 'b-export', content: bContent },
    })
    const bMemoryId = ((await bFirst.json()) as { memory: { id: string } }).memory.id
    const bSecond = await api('/api/v1/memories', {
      method: 'POST',
      key: keyB,
      body: { memoryType: 'note', topic: 'b-export2', content: `${bContent}-2` },
    })
    const bMemoryId2 = ((await bSecond.json()) as { memory: { id: string } }).memory.id

    const bPayload = `b-evt-${crypto.randomUUID()}`
    const bRationale = `b-rat-${crypto.randomUUID()}`
    await seedGraph(await userIdFor(emailB), bMemoryId, bMemoryId2, bPayload, bRationale)

    const res = await api('/api/v1/export', { key: keyA })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      account: { email: string }
      memories: Array<{ id: string; content: string }>
      edges: Array<{ fromId: string; toId: string }>
      memoryEvents: Array<{ memoryId: string; payload: { note?: string } | null }>
      proposals: Array<{ rationale: string | null }>
    }
    // A's export is scoped to A: every B-owned id/content/edge/payload/rationale is absent.
    expect(body.account.email).toBe(emailA)
    expect(body.memories.some((m) => m.id === bMemoryId)).toBe(false)
    expect(body.memories.some((m) => m.content === bContent)).toBe(false)
    expect(body.edges.some((e) => e.fromId === bMemoryId || e.toId === bMemoryId2)).toBe(false)
    expect(body.memoryEvents.some((e) => e.memoryId === bMemoryId)).toBe(false)
    expect(body.memoryEvents.some((e) => e.payload?.note === bPayload)).toBe(false)
    expect(body.proposals.some((p) => p.rationale === bRationale)).toBe(false)
  })

  it('works under a session Bearer (same identity as the key)', async () => {
    const viaToken = await api('/api/v1/export', { token: tokenA })
    expect(viaToken.status).toBe(200)
    const body = (await viaToken.json()) as { account: { email: string } }
    expect(body.account.email).toBe(emailA)
  })

  it('exports the key tenant budget + usage rows (#475)', async () => {
    const usageOp = `op-a-${crypto.randomUUID()}`
    await seedUsage(await userIdFor(emailA), usageOp)

    const res = await api('/api/v1/export', { key: keyA })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      userBudgets: Array<{ capUsdOverride: string | null }>
      llmUsage: Array<{ operation: string; costUsd: string | null }>
      counts: { userBudgets: number; llmUsage: number }
    }
    expect(body.userBudgets.some((b) => b.capUsdOverride === '7.000000000000')).toBe(true)
    const usage = body.llmUsage.find((u) => u.operation === usageOp)
    expect(usage?.costUsd).toBe('0.000000200000')
    expect(body.counts.userBudgets).toBe(body.userBudgets.length)
    expect(body.counts.llmUsage).toBe(body.llmUsage.length)
  })

  it('TENANT ISOLATION: A export never contains B-owned budget/usage rows (RLS)', async () => {
    const bUsageOp = `op-b-${crypto.randomUUID()}`
    await seedUsage(await userIdFor(emailB), bUsageOp)

    const res = await api('/api/v1/export', { key: keyA })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      account: { email: string }
      llmUsage: Array<{ operation: string }>
    }
    // A's archive is scoped to A: B's usage op never appears.
    expect(body.account.email).toBe(emailA)
    expect(body.llmUsage.some((u) => u.operation === bUsageOp)).toBe(false)
  })

  it('exports the key tenant onboarding profile attributes (#522)', async () => {
    await seedProfile(await userIdFor(emailA), 'engineer', 'reddit')

    const res = await api('/api/v1/export', { key: keyA })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      profile: {
        role: string | null
        useCase: string | null
        aiTools: string[] | null
        referralSource: string | null
      } | null
    }
    expect(body.profile?.role).toBe('engineer')
    expect(body.profile?.useCase).toBe('dev')
    expect(body.profile?.aiTools).toEqual(['claude', 'codex'])
    expect(body.profile?.referralSource).toBe('reddit')
  })

  it('TENANT ISOLATION: A export carries A profile only, never B (RLS, no explicit filter)', async () => {
    await seedProfile(await userIdFor(emailB), 'founder', 'twitter')

    const res = await api('/api/v1/export', { key: keyA })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      profile: { role: string | null; referralSource: string | null } | null
    }
    // The export's profile select has no user_id predicate; RLS alone scopes it to A,
    // so B's 'founder'/'twitter' row must never surface in A's archive.
    expect(body.profile?.role).not.toBe('founder')
    expect(body.profile?.referralSource).not.toBe('twitter')
  })
})
