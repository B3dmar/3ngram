// SPDX-License-Identifier: Apache-2.0
// Typed provenance read against real Postgres + real RLS
// (docs/concepts/session-continuity.mdx layer 3, issue #166 step 4).
//
// The events are produced by the REAL write path (writeMemory stamping
// payload.sessionRunId), not by hand-inserted rows, so the reader is pinned
// against the spelling the writer actually persists.
//
// Runtime role, so every assertion here is an RLS assertion too: the owner role
// bypasses RLS and would prove nothing about tenant isolation.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertSessionRunOwned,
  closeDb,
  listSessionEvents,
  UnknownSessionRunError,
  withTenant,
  writeMemory,
} from '../../src/index.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const RUN_A = '01890b6e-0000-7000-8000-0000000000aa'
const RUN_B = '01890b6e-0000-7000-8000-0000000000bb'
const NOW = new Date('2026-08-21T12:00:00.000Z')

let uidA: string
let uidB: string
let hashCounter = 0
const nextHash = () => `sess-events-${Date.now()}-${hashCounter++}`

async function seedSession(userId: string, id: string, project: string | null): Promise<void> {
  await ownerPool.query(
    `INSERT INTO agent_sessions
       (id, user_id, agent, session_id, source, project, selector, last_seen_at, closed_at, activation_epoch)
     VALUES ($1, $2, 'codex', $3, 'startup', $4, '{"kind":"all"}'::jsonb, $5, NULL, 1)`,
    [id, userId, `sess-${id.slice(-4)}`, project, NOW],
  )
}

/** One `create` event, stamped with `sessionRunId` when a run id is given. */
async function write(
  userId: string,
  opts: { sessionRunId?: string; project?: string } = {},
): Promise<string> {
  const memory = await writeMemory({
    userId,
    memoryType: 'note',
    topic: 'session-events',
    content: `body-${nextHash()}`,
    scope: 'work',
    project: opts.project ?? '3ngram',
    tags: [],
    contentHash: nextHash(),
    actorKind: 'user_api',
    now: NOW,
    ...(opts.sessionRunId === undefined ? {} : { sessionRunId: opts.sessionRunId }),
  })
  return memory.id
}

const read = (
  userId: string,
  sessionRunId: string,
  options: { limit: number; cursor?: string; ceiling?: number },
) => withTenant(userId, (tx) => listSessionEvents(tx, userId, sessionRunId, options))

beforeAll(async () => {
  await resetDomainTables()
}, 120_000)

beforeEach(async () => {
  await resetDomainTables()
  uidA = await seedUser('sess-events-a@test.local')
  uidB = await seedUser('sess-events-b@test.local')
  await seedSession(uidA, RUN_A, '3ngram')
  await seedSession(uidB, RUN_B, '3ngram')
})

afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('listSessionEvents', () => {
  it('lists a run’s events in uuidv7 id order', async () => {
    for (let i = 0; i < 5; i++) await write(uidA, { sessionRunId: RUN_A })
    const page = await read(uidA, RUN_A, { limit: 10 })

    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBeUndefined()
    expect(page.truncated).toBe(false)
    const ids = page.items.map((e) => e.id)
    expect([...ids].sort()).toEqual(ids)
    for (const event of page.items) {
      expect(event.sessionRunId).toBe(RUN_A)
      expect(event.eventKind).toBe('create')
      expect(event.actorKind).toBe('user_api')
    }
  })

  it('round-trips a limit=2 walk over 5 events with no duplicate or skip', async () => {
    for (let i = 0; i < 5; i++) await write(uidA, { sessionRunId: RUN_A })

    const walked: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await read(uidA, RUN_A, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      })
      walked.push(...page.items.map((e) => e.id))
      cursor = page.nextCursor
      pages++
      expect(page.items.length).toBeLessThanOrEqual(2)
    } while (cursor !== undefined && pages < 10)

    expect(pages).toBe(3)
    expect(walked).toHaveLength(5)
    expect(new Set(walked).size).toBe(5)
    const all = await read(uidA, RUN_A, { limit: 10 })
    expect(walked).toEqual(all.items.map((e) => e.id))
  })

  it('reports truncated past the per-run ceiling and stops paging there', async () => {
    // The ceiling is INJECTED so the overflow branch costs 4 rows instead of
    // MAX_SESSION_EVENT_IDS + 1; production always takes the schema default.
    for (let i = 0; i < 4; i++) await write(uidA, { sessionRunId: RUN_A })

    const capped = await read(uidA, RUN_A, { limit: 10, ceiling: 2 })
    expect(capped.items).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    expect(capped.nextCursor).toBeUndefined()

    const exact = await read(uidA, RUN_A, { limit: 10, ceiling: 4 })
    expect(exact.items).toHaveLength(4)
    expect(exact.truncated).toBe(false)
  })

  it('never surfaces an event whose payload lacks the key', async () => {
    await write(uidA, { sessionRunId: RUN_A })
    // A project with no leased-open session: the single-open default finds zero
    // rows, so this write's event carries no payload at all.
    const unattributed = await write(uidA, { project: 'no-open-session' })
    const page = await read(uidA, RUN_A, { limit: 10 })

    expect(page.items).toHaveLength(1)
    expect(page.items.map((e) => e.memoryId)).not.toContain(unattributed)
    const raw = await ownerPool.query(
      `SELECT payload FROM memory_events WHERE memory_id = $1 AND event_kind = 'create'`,
      [unattributed],
    )
    expect(raw.rows[0]?.payload ?? null).toBeNull()
  })

  it('rejects another tenant’s run id and never leaks its events', async () => {
    await write(uidB, { sessionRunId: RUN_B })

    await expect(assertSessionRunOwned(uidA, RUN_B)).rejects.toBeInstanceOf(UnknownSessionRunError)
    await expect(assertSessionRunOwned(uidB, RUN_B)).resolves.toBeUndefined()
    // Even if the ownership gate were bypassed, RLS keeps the rows out.
    const leaked = await read(uidA, RUN_B, { limit: 10 })
    expect(leaked.items).toEqual([])
  })
})

describe('memory_events_session_idx', () => {
  it('serves the reader’s predicate shape', async () => {
    for (let i = 0; i < 3; i++) await write(uidA, { sessionRunId: RUN_A })
    const conn = await ownerPool.connect()
    try {
      // A 3-row table is always cheaper to seq-scan, so the planner is forced to
      // cost the index path. The predicate below is the SAME spelling the reader
      // emits — packages/db/test/session-events-read.test.ts pins that the
      // builder produces exactly `payload->>'sessionRunId' = $n` and keysets on
      // `id`, so this plan assertion and that SQL assertion together cover the
      // index contract.
      await conn.query('BEGIN')
      await conn.query('SET LOCAL enable_seqscan = off')
      const plan = await conn.query(
        `EXPLAIN (FORMAT JSON)
         SELECT id, memory_id, event_kind, actor_kind, payload->>'sessionRunId', created_at
         FROM memory_events
         WHERE user_id = $1 AND payload->>'sessionRunId' = $2
         ORDER BY id ASC
         LIMIT 51`,
        [uidA, RUN_A],
      )
      await conn.query('ROLLBACK')
      expect(JSON.stringify(plan.rows)).toContain('memory_events_session_idx')
    } finally {
      conn.release()
    }
  })
})
