// SPDX-License-Identifier: Apache-2.0
// End-to-end REST integration test for memory history: a memory
// updated then superseded must return 200 with its lineage + audit trail
// through the REAL Express transport, real runtime role, and real DB — NOT a
// 500 that the dashboard renders as "History unavailable". Also pins the
// allowlisted session-provenance fields (issue #262) end to end.
import type { Server } from 'node:http'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import { type MemoryHistoryResponse, memoryHistoryResponseSchema } from '@3ngram/schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { createApp } from '../../src/app.js'

const PASSWORD = 'history-366-int-password'
const gateway = createFakeGateway()

let server: Server
let baseUrl: string
let email: string
let key: string
let otherEmail: string
let otherKey: string

async function issueKey(token: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  })
  if (res.status !== 201) throw new Error(`issueKey failed: ${res.status}`)
  return ((await res.json()) as { key: string }).key
}

async function api(
  path: string,
  opts: { method?: string; body?: unknown; as?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-api-key': opts.as ?? key },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

beforeAll(async () => {
  email = `history-366-${crypto.randomUUID()}@test.local`
  await createUser(email, PASSWORD)
  const grant = await login(email, PASSWORD, 1)
  if (!grant) throw new Error('login failed in setup')
  server = createApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  key = await issueKey(grant.token, 'history-366')
  otherEmail = `history-262-other-${crypto.randomUUID()}@test.local`
  await createUser(otherEmail, PASSWORD)
  const otherGrant = await login(otherEmail, PASSWORD, 1)
  if (!otherGrant) throw new Error('login (other tenant) failed in setup')
  otherKey = await issueKey(otherGrant.token, 'history-262-other')
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  await ownerPool.query('DELETE FROM users WHERE email = ANY($1)', [[email, otherEmail]])
  await closePools()
})

describe('GET /api/v1/memories/:id/history after update + supersede (#366)', () => {
  it('returns 200 with lineage + audit events, not History unavailable', async () => {
    const tag = crypto.randomUUID()
    const created = await api('/api/v1/memories', {
      method: 'POST',
      body: { memoryType: 'note', topic: 'hist topic', content: `hist-${tag} v1` },
    })
    expect(created.status).toBe(201)
    const idA = ((await created.json()) as { memory: { id: string } }).memory.id

    const updated = await api(`/api/v1/memories/${idA}/revise`, {
      method: 'POST',
      body: {
        memoryType: 'note',
        topic: 'hist topic',
        content: `hist-${tag} v2`,
        edgeIntent: 'updates',
      },
    })
    expect(updated.status).toBe(200)
    const idB = ((await updated.json()) as { memory: { id: string } }).memory.id

    const superseded = await api(`/api/v1/memories/${idB}/revise`, {
      method: 'POST',
      body: {
        memoryType: 'note',
        topic: 'hist topic',
        content: `hist-${tag} v3`,
        edgeIntent: 'supersedes',
      },
    })
    expect(superseded.status).toBe(200)
    const idC = ((await superseded.json()) as { memory: { id: string } }).memory.id

    // History of the current memory (C) — and of a superseded version (A).
    for (const id of [idC, idA]) {
      const res = await api(`/api/v1/memories/${id}/history`)
      expect(res.status, `history of ${id} should be 200, body: ${await res.clone().text()}`).toBe(
        200,
      )
      const body = (await res.json()) as {
        lineage: { nodes: unknown[]; edges: unknown[] }
        auditEvents: unknown[]
      }
      expect(body.lineage.nodes.length).toBeGreaterThanOrEqual(1)
      expect(body.auditEvents.length).toBeGreaterThanOrEqual(1)
    }
  })
})

async function openRun(project: string): Promise<string> {
  const res = await api('/api/v1/agent-sessions/open', {
    method: 'POST',
    body: {
      agent: 'codex',
      sessionId: `hist-262-${crypto.randomUUID()}`,
      source: 'startup',
      project,
    },
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { sessionRunId: string }).sessionRunId
}

async function history(id: string): Promise<MemoryHistoryResponse> {
  const res = await api(`/api/v1/memories/${id}/history`)
  expect(res.status).toBe(200)
  // The wire body is the strict contract: no raw payload, no unlisted key.
  return memoryHistoryResponseSchema.parse(await res.json())
}

describe('GET /api/v1/memories/:id/history session provenance (#262)', () => {
  it('reports each revision its own creating run, through the real transport', async () => {
    const project = `hist-262-${crypto.randomUUID().slice(0, 8)}`
    // Two leased-open runs: a write that omits the id is NOT auto-attached.
    const runA = await openRun(project)
    const runB = await openRun(project)
    const tag = crypto.randomUUID()

    const created = await api('/api/v1/memories', {
      method: 'POST',
      body: {
        memoryType: 'note',
        topic: 't262',
        content: `p-${tag} v1`,
        project,
        sessionRunId: runA,
      },
    })
    expect(created.status).toBe(201)
    const idA = ((await created.json()) as { memory: { id: string } }).memory.id

    const revised = await api(`/api/v1/memories/${idA}/revise`, {
      method: 'POST',
      body: {
        memoryType: 'note',
        topic: 't262',
        content: `p-${tag} v2`,
        edgeIntent: 'supersedes',
        sessionRunId: runB,
      },
    })
    expect(revised.status).toBe(200)
    const idB = ((await revised.json()) as { memory: { id: string } }).memory.id

    const unattributed = await api(`/api/v1/memories/${idB}/revise`, {
      method: 'POST',
      body: { memoryType: 'note', topic: 't262', content: `p-${tag} v3`, edgeIntent: 'updates' },
    })
    expect(unattributed.status).toBe(200)
    const idC = ((await unattributed.json()) as { memory: { id: string } }).memory.id

    const ha = await history(idA)
    expect(ha.createdBySessionRunId).toBe(runA)
    expect(ha.auditEvents.map((e) => [e.eventKind, e.sessionRunId]).sort()).toEqual([
      ['create', runA],
      ['supersede', runB],
    ])
    expect(ha.auditEvents.every((e) => !('payload' in e))).toBe(true)

    const hb = await history(idB)
    expect(hb.createdBySessionRunId).toBe(runB)

    const hc = await history(idC)
    expect(hc.createdBySessionRunId).toBeNull()
    expect(hc.auditEvents.map((e) => e.sessionRunId)).toEqual([null])
  })

  it('does not let another tenant read the history or stamp the run id', async () => {
    const project = `hist-262-${crypto.randomUUID().slice(0, 8)}`
    const run = await openRun(project)
    const created = await api('/api/v1/memories', {
      method: 'POST',
      body: {
        memoryType: 'note',
        topic: 't262',
        content: `x-${crypto.randomUUID()}`,
        project,
        sessionRunId: run,
      },
    })
    expect(created.status).toBe(201)
    const id = ((await created.json()) as { memory: { id: string } }).memory.id

    const foreignRead = await api(`/api/v1/memories/${id}/history`, { as: otherKey })
    expect(foreignRead.status).toBe(404)
    const foreignStamp = await api('/api/v1/memories', {
      method: 'POST',
      as: otherKey,
      body: {
        memoryType: 'note',
        topic: 't262',
        content: `y-${crypto.randomUUID()}`,
        project,
        sessionRunId: run,
      },
    })
    expect(foreignStamp.status).toBe(400)
    expect((await history(id)).createdBySessionRunId).toBe(run)
  })
})

// Issue #234: the optional resolve `reason` lands on the commitment row and is
// read back ONLY through this authenticated, tenant-scoped history read.
describe('GET /api/v1/memories/:id/history lastResolutionReason (#234)', () => {
  async function writeTyped(memoryType: 'commitment' | 'blocker', project?: string) {
    const res = await api('/api/v1/memories', {
      method: 'POST',
      body: {
        memoryType,
        topic: 't234',
        content: `r234-${memoryType}-${crypto.randomUUID()}`,
        ...(project === undefined ? {} : { project }),
      },
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { memory: { id: string } }).memory.id
  }

  function resolve(id: string, body: Record<string, unknown>, as?: string) {
    return api(`/api/v1/memories/${id}/resolve`, {
      method: 'POST',
      body,
      ...(as === undefined ? {} : { as }),
    })
  }

  it('round-trips a trimmed reason, attributes the event to the run only, clears on reopen', async () => {
    const project = `hist-234-${crypto.randomUUID().slice(0, 8)}`
    const run = await openRun(project)
    const id = await writeTyped('commitment', project)

    const resolved = await resolve(id, {
      status: 'resolved',
      reason: '  shipped in PR #234  ',
      sessionRunId: run,
    })
    expect(resolved.status).toBe(200)
    const afterResolve = await history(id)
    expect(afterResolve.lastResolutionReason).toBe('shipped in PR #234')
    const resolveEvent = afterResolve.auditEvents.find((e) => e.eventKind === 'resolve')
    expect(resolveEvent?.sessionRunId).toBe(run)
    // The stored event payload is provenance only — the reason is not in it.
    const payload = await ownerPool.query(
      `SELECT payload FROM memory_events WHERE memory_id = $1 AND event_kind = 'resolve'`,
      [id],
    )
    expect(payload.rows.map((r) => r.payload)).toEqual([{ sessionRunId: run }])

    const reopened = await resolve(id, { status: 'open' })
    expect(reopened.status).toBe(200)
    expect((await history(id)).lastResolutionReason).toBeNull()
  })

  it('stores nothing for a reason on a same-state no-op', async () => {
    const id = await writeTyped('commitment')
    expect((await resolve(id, { status: 'resolved', reason: 'first evidence' })).status).toBe(200)
    const eventsBefore = (await history(id)).auditEvents.length

    const again = await resolve(id, { status: 'resolved', reason: 'second evidence' })
    expect(again.status).toBe(200)

    const after = await history(id)
    expect(after.lastResolutionReason).toBe('first evidence')
    expect(after.auditEvents).toHaveLength(eventsBefore)
  })

  it('rejects a reason on a blocker with invalid_input and leaves the blocker active', async () => {
    const id = await writeTyped('blocker')

    const res = await resolve(id, { status: 'resolved', reason: 'blocker-evidence-234' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({
      error: 'invalid_input',
      detail: 'a resolve reason is stored only on a commitment; omit reason to resolve a blocker',
    })
    const inspected = await api(`/api/v1/memories/${id}`)
    expect(((await inspected.json()) as { status: string }).status).toBe('active')
    expect((await history(id)).lastResolutionReason).toBeNull()

    // Without the reason the same blocker resolves (archives) as before.
    expect((await resolve(id, { status: 'resolved' })).status).toBe(200)
  })

  it('rejects empty and oversize reasons at the boundary, writing nothing', async () => {
    const id = await writeTyped('commitment')
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const res = await resolve(id, { status: 'resolved', reason })
      expect(res.status).toBe(400)
    }
    const after = await history(id)
    expect(after.memory.id).toBe(id)
    expect(after.lastResolutionReason).toBeNull()
    expect(after.auditEvents.map((e) => e.eventKind)).toEqual(['create'])
  })

  it("never lets another tenant write or read A's reason", async () => {
    const id = await writeTyped('commitment')
    expect((await resolve(id, { status: 'resolved', reason: 'owner evidence' })).status).toBe(200)

    const foreignResolve = await resolve(id, { status: 'open', reason: 'forged' }, otherKey)
    expect(foreignResolve.status).toBe(404)
    const foreignRead = await api(`/api/v1/memories/${id}/history`, { as: otherKey })
    expect(foreignRead.status).toBe(404)
    expect(JSON.stringify(await foreignRead.json())).not.toContain('owner evidence')
    expect((await history(id)).lastResolutionReason).toBe('owner evidence')
  })

  it('reports null for a memory that carries no commitment', async () => {
    const created = await api('/api/v1/memories', {
      method: 'POST',
      body: { memoryType: 'note', topic: 't234', content: `r234-note-${crypto.randomUUID()}` },
    })
    const id = ((await created.json()) as { memory: { id: string } }).memory.id
    expect((await history(id)).lastResolutionReason).toBeNull()
  })
})
