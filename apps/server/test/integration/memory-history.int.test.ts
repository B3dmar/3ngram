// SPDX-License-Identifier: Apache-2.0
// End-to-end REST integration test for memory history: a memory
// updated then superseded must return 200 with its lineage + audit trail
// through the REAL Express transport, real runtime role, and real DB — NOT a
// 500 that the dashboard renders as "History unavailable".
import type { Server } from 'node:http'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { createApp } from '../../src/app.js'

const PASSWORD = 'history-366-int-password'
const gateway = createFakeGateway()

let server: Server
let baseUrl: string
let email: string
let key: string

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
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
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
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  await ownerPool.query('DELETE FROM users WHERE email = $1', [email])
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
