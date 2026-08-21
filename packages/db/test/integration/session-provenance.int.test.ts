// SPDX-License-Identifier: Apache-2.0
// Native write-time session provenance (docs/concepts/session-continuity.mdx).
// Runtime role, real RLS. Import never calls this path.
import { SESSION_LEASE_MS } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { writeMemory } from '../../src/memory-write.js'
import { UnknownSessionRunError } from '../../src/session-provenance.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const RUN_A = '01890b6e-0000-7000-8000-0000000000aa'
const RUN_B = '01890b6e-0000-7000-8000-0000000000bb'
const NOW = new Date('2026-08-21T12:00:00.000Z')

let uid: string
let hashCounter = 0
const nextHash = () => `sess-prov-${Date.now()}-${hashCounter++}`

function memoryInput(userId: string, extras: Record<string, unknown> = {}) {
  return {
    userId,
    memoryType: 'note',
    topic: 'session-provenance',
    content: `body-${nextHash()}`,
    scope: 'work',
    project: '3ngram',
    tags: [] as string[],
    contentHash: nextHash(),
    actorKind: 'user_api' as const,
    now: NOW,
    ...extras,
  }
}

async function seedSession(opts: {
  userId: string
  id: string
  sessionId: string
  project: string | null
  lastSeenAt: Date
  closedAt: Date | null
}): Promise<void> {
  await ownerPool.query(
    `INSERT INTO agent_sessions
       (id, user_id, agent, session_id, source, project, selector, last_seen_at, closed_at, activation_epoch)
     VALUES ($1, $2, 'codex', $3, 'startup', $4, '{"kind":"all"}'::jsonb, $5, $6, 1)`,
    [opts.id, opts.userId, opts.sessionId, opts.project, opts.lastSeenAt, opts.closedAt],
  )
}

async function eventPayload(memoryId: string): Promise<unknown> {
  const r = await ownerPool.query(
    `SELECT payload FROM memory_events WHERE memory_id = $1 AND event_kind = 'create'`,
    [memoryId],
  )
  return r.rows[0]?.payload ?? null
}

beforeAll(async () => {
  await resetDomainTables()
  uid = await seedUser('sess-prov@test.local')
}, 120_000)

beforeEach(async () => {
  await resetDomainTables()
  uid = await seedUser('sess-prov@test.local')
})

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('writeMemory session provenance', () => {
  it('stamps payload.sessionRunId when the caller passes a live owned run', async () => {
    await seedSession({
      userId: uid,
      id: RUN_A,
      sessionId: 'live',
      project: '3ngram',
      lastSeenAt: NOW,
      closedAt: null,
    })
    const written = await writeMemory(memoryInput(uid, { sessionRunId: RUN_A }))
    expect(await eventPayload(written.id)).toEqual({ sessionRunId: RUN_A })
  })

  it('fails the write when the run id is not this tenant', async () => {
    await expect(writeMemory(memoryInput(uid, { sessionRunId: RUN_B }))).rejects.toBeInstanceOf(
      UnknownSessionRunError,
    )
  })

  it('succeeds unattributed on an explicitly closed live-lease row', async () => {
    await seedSession({
      userId: uid,
      id: RUN_A,
      sessionId: 'ended',
      project: '3ngram',
      lastSeenAt: NOW,
      closedAt: NOW,
    })
    const written = await writeMemory(memoryInput(uid, { sessionRunId: RUN_A }))
    expect(await eventPayload(written.id)).toBeNull()
  })

  it('resurrects a stale-lease row then attaches', async () => {
    const stale = new Date(NOW.getTime() - SESSION_LEASE_MS - 60_000)
    await seedSession({
      userId: uid,
      id: RUN_A,
      sessionId: 'stale',
      project: '3ngram',
      lastSeenAt: stale,
      closedAt: null,
    })
    const written = await writeMemory(memoryInput(uid, { sessionRunId: RUN_A }))
    expect(await eventPayload(written.id)).toEqual({ sessionRunId: RUN_A })
    const row = await ownerPool.query(
      'SELECT closed_at, activation_epoch FROM agent_sessions WHERE id = $1',
      [RUN_A],
    )
    expect(row.rows[0].closed_at).toBeNull()
    expect(row.rows[0].activation_epoch).toBe(2)
  })

  it('omitted id attaches the single leased-open session for the project', async () => {
    await seedSession({
      userId: uid,
      id: RUN_A,
      sessionId: 'only',
      project: '3ngram',
      lastSeenAt: NOW,
      closedAt: null,
    })
    const written = await writeMemory(memoryInput(uid))
    expect(await eventPayload(written.id)).toEqual({ sessionRunId: RUN_A })
  })

  it('omitted id leaves payload unset when zero or many open sessions match', async () => {
    const none = await writeMemory(memoryInput(uid, { project: 'empty-project' }))
    expect(await eventPayload(none.id)).toBeNull()

    await seedSession({
      userId: uid,
      id: RUN_A,
      sessionId: 'one',
      project: '3ngram',
      lastSeenAt: NOW,
      closedAt: null,
    })
    await seedSession({
      userId: uid,
      id: RUN_B,
      sessionId: 'two',
      project: '3ngram',
      lastSeenAt: NOW,
      closedAt: null,
    })
    const many = await writeMemory(memoryInput(uid))
    expect(await eventPayload(many.id)).toBeNull()
  })
})
