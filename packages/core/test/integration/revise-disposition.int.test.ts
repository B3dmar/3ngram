// SPDX-License-Identifier: Apache-2.0
// Integration — the revise ARCHIVE disposition (issue #217) against the real
// runtime role (app_user, NOBYPASSRLS). Proves what the mocked unit tests
// cannot:
//   - only `status` (and updated_at) moves: content, topic, tags, valid_from,
//     valid_to and recorded_at are byte-identical, nothing is appended, no edge
//   - the row leaves default ranked search and the stale-candidate queue, and
//     stays recoverable with `status: "archived"` and through `asOf`
//   - one batch reports per-id outcomes: archived / already_archived /
//     rejected (superseded, open_commitment, blocker, not_found incl. RLS)
//   - every archived row gets exactly one `archive` event with the strict
//     payload, attributed to the actor and the attached session run
//   - product path: the briefing's staleCandidates count drops after an archive
//
// Reuses packages/db integration infra (helpers.ts).
import {
  closeDb,
  searchFused,
  staleCandidates,
  UnknownSessionRunError,
  withTenant,
} from '@3ngram/db'
import type { ActorKind } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { briefing, STALE_CANDIDATE_TYPES } from '../../src/read/briefing.js'
import { openAgentSession } from '../../src/session/lifecycle.js'
import { resolveByMemoryId } from '../../src/write/commitments.js'
import { remember } from '../../src/write/remember.js'
import { revise } from '../../src/write/revise.js'
import { reviseDisposition } from '../../src/write/revise-disposition.js'

let userA: string
let userB: string

const ACTOR: ActorKind = 'user_mcp'
const PROJECT = 'stale-review'
const OLD = '2026-01-01T00:00:00.000Z'
const UNKNOWN = '01890b6e-0000-7000-8000-00000000ffff'

const write = async (
  user: string,
  memoryType: string,
  content: string,
  extra: Record<string, unknown> = {},
) => (await remember(user, { memoryType, topic: 'stale review', content, ...extra }, ACTOR)).id

const archive = (user: string, memoryIds: string[], extra: Record<string, unknown> = {}) =>
  reviseDisposition(user, { kind: 'archive', memoryIds, ...extra }, ACTOR)

const SNAPSHOT_COLUMNS =
  'content, topic, tags, scope, project, memory_type, content_hash, valid_from, valid_to, recorded_at, created_at'

async function snapshot(id: string) {
  const { rows } = await ownerPool.query(`SELECT ${SNAPSHOT_COLUMNS} FROM memories WHERE id = $1`, [
    id,
  ])
  return rows[0]
}

async function archiveEvents(user: string) {
  const { rows } = await ownerPool.query(
    "SELECT memory_id, actor_kind, payload FROM memory_events WHERE user_id = $1 AND event_kind = 'archive' ORDER BY id",
    [user],
  )
  return rows
}

beforeAll(async () => {
  userA = await seedUser('disposition-a@test.local')
  userB = await seedUser('disposition-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('revise archive disposition (issue #217, runtime role)', () => {
  it('moves status only: content and provenance are untouched, nothing is appended', async () => {
    const id = await write(userA, 'decision', 'we ship the archive disposition', {
      project: PROJECT,
      tags: ['ops'],
    })
    const before = await snapshot(id)

    const result = await archive(userA, [id])

    expect(result).toEqual({ kind: 'archive', outcomes: [{ memoryId: id, outcome: 'archived' }] })
    expect(await snapshot(id)).toEqual(before)
    const row = await ownerPool.query('SELECT status FROM memories WHERE id = $1', [id])
    expect(row.rows[0].status).toBe('archived')
    const counts = await ownerPool.query(
      'SELECT (SELECT count(*) FROM memories WHERE user_id = $1) AS memories, (SELECT count(*) FROM memory_edges WHERE user_id = $1) AS edges',
      [userA],
    )
    expect(counts.rows[0]).toEqual({ memories: '1', edges: '0' })
    expect(await archiveEvents(userA)).toEqual([
      { memory_id: id, actor_kind: 'user_mcp', payload: { disposition: 'archive' } },
    ])
  })

  it('leaves default ranked search; recoverable by status: archived and by asOf', async () => {
    const id = await write(userA, 'fact', 'the quartz relay runs on port 7443')
    const beforeArchive = new Date()
    await archive(userA, [id])

    const ids = async (filters: Parameters<typeof searchFused>[7]) =>
      (
        await withTenant(userA, (tx) =>
          searchFused(tx, userA, 'quartz relay', 10, undefined, undefined, undefined, filters),
        )
      ).map((hit) => hit.id)

    expect(await ids({})).not.toContain(id)
    expect(await ids({ status: 'archived' })).toContain(id)
    expect(await ids({ asOf: { validAt: beforeArchive } })).toContain(id)
  })

  it('reports one outcome per id, in order, and writes only for the archived ones', async () => {
    const live = await write(userA, 'decision', 'live decision')
    const already = await write(userA, 'preference', 'already archived preference')
    await archive(userA, [already])
    const superseded = await write(userA, 'fact', 'old fact')
    await revise(
      userA,
      { memoryType: 'fact', topic: 'stale review', content: 'new fact', predecessorId: superseded },
      ACTOR,
    )
    const openCommitment = await write(userA, 'commitment', 'open obligation')
    const waitingCommitment = await write(userA, 'commitment', 'waiting obligation')
    await resolveByMemoryId(userA, waitingCommitment, 'waiting', ACTOR)
    const resolvedCommitment = await write(userA, 'commitment', 'settled obligation')
    await resolveByMemoryId(userA, resolvedCommitment, 'resolved', ACTOR)
    const blocker = await write(userA, 'blocker', 'blocked on review')
    const foreign = await write(userB, 'decision', 'tenant B decision')
    const eventsBefore = (await archiveEvents(userA)).length

    const result = await archive(userA, [
      live,
      already,
      superseded,
      openCommitment,
      waitingCommitment,
      resolvedCommitment,
      blocker,
      UNKNOWN,
      foreign,
    ])

    expect(result.outcomes).toEqual([
      { memoryId: live, outcome: 'archived' },
      { memoryId: already, outcome: 'already_archived' },
      { memoryId: superseded, outcome: 'rejected', reason: 'superseded' },
      { memoryId: openCommitment, outcome: 'rejected', reason: 'open_commitment' },
      { memoryId: waitingCommitment, outcome: 'rejected', reason: 'open_commitment' },
      { memoryId: resolvedCommitment, outcome: 'archived' },
      { memoryId: blocker, outcome: 'rejected', reason: 'blocker' },
      { memoryId: UNKNOWN, outcome: 'rejected', reason: 'not_found' },
      { memoryId: foreign, outcome: 'rejected', reason: 'not_found' },
    ])
    const statuses = await ownerPool.query(
      'SELECT id, status, valid_to IS NULL AS live FROM memories WHERE id = ANY($1::uuid[])',
      [[superseded, openCommitment, waitingCommitment, blocker, foreign]],
    )
    for (const row of statuses.rows) expect(row.status).toBe('active')
    const events = await archiveEvents(userA)
    expect(events.slice(eventsBefore).map((event) => event.memory_id)).toEqual([
      live,
      resolvedCommitment,
    ])
    // RLS + the caller-bound predicate: tenant B's row was never touched or audited.
    expect(await archiveEvents(userB)).toEqual([])
  })

  it('attributes the event to the single leased-open session for the project', async () => {
    const { row: session } = await openAgentSession(userA, {
      agent: 'claude-code',
      sessionId: 'disposition-session',
      source: 'startup',
      project: PROJECT,
    })
    const id = await write(userA, 'decision', 'attributed archive', { project: PROJECT })

    await archive(userA, [id])

    const events = await archiveEvents(userA)
    expect(events.at(-1)).toEqual({
      memory_id: id,
      actor_kind: 'user_mcp',
      payload: { disposition: 'archive', sessionRunId: session.id },
    })
  })

  it('an unowned sessionRunId fails the whole batch before anything is archived', async () => {
    const id = await write(userA, 'decision', 'not archived by a foreign run')
    const { row: foreignRun } = await openAgentSession(userB, {
      agent: 'claude-code',
      sessionId: 'tenant-b-session',
      source: 'startup',
    })

    await expect(archive(userA, [id], { sessionRunId: foreignRun.id })).rejects.toBeInstanceOf(
      UnknownSessionRunError,
    )
    const row = await ownerPool.query('SELECT status FROM memories WHERE id = $1', [id])
    expect(row.rows[0].status).toBe('active')
    expect(await archiveEvents(userA)).toEqual([])
  })

  it('product path: the briefing staleCandidates count drops after an archive', async () => {
    const stale = [
      await write(userA, 'decision', 'stale decision one', { project: PROJECT }),
      await write(userA, 'fact', 'stale fact two', { project: PROJECT }),
    ]
    await ownerPool.query('UPDATE memories SET updated_at = $2 WHERE id = ANY($1::uuid[])', [
      stale,
      OLD,
    ])
    const view = () =>
      briefing(userA, {
        selector: { kind: 'project', project: PROJECT },
        mode: 'full',
        now: new Date(),
      })

    expect((await view()).staleCandidates.count).toBe(2)
    await archive(userA, [stale[0] as string])

    const after = await view()
    expect(after.staleCandidates.count).toBe(1)
    expect(after.staleCandidates.items.map((item) => item.id)).toEqual([stale[1]])
    const direct = await withTenant(userA, (tx) =>
      staleCandidates(tx, userA, { kind: 'all' }, new Date(), 25, STALE_CANDIDATE_TYPES),
    )
    expect(direct.items.map((item) => item.id)).not.toContain(stale[0])
  })
})
