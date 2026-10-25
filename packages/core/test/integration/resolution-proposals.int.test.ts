// SPDX-License-Identifier: Apache-2.0
// Integration — resolution proposals (issue #229) through core against the real
// runtime role: the closer's repo stages one, the review list pages it beside
// the other kinds, accept resolves the commitment AS THE REVIEWER through the
// shipped resolve path, and reject leaves the commitment open.
import { closeDb } from '@3ngram/db'
import type { ActorKind } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { acceptProposalAnyKind, rejectProposalAnyKind } from '../../src/admin/proposals.js'
import { listProposalsPage } from '../../src/admin/proposals-page.js'
import { dbSessionCloserRepo } from '../../src/admin/session-closer.js'
import { remember } from '../../src/write/remember.js'

const ACTOR: ActorKind = 'user_mcp'
let userA: string

beforeAll(async () => {
  userA = await seedUser(`resolution-core-${crypto.randomUUID()}@test.local`)
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

async function seedRun(userId: string): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO agent_sessions (user_id, agent, session_id, source, selector, closed_at)
     VALUES ($1, 'claude-code', $2, 'startup', '{"kind":"all"}'::jsonb, now())
     RETURNING id`,
    [userId, `run-${crypto.randomUUID()}`],
  )
  return (r.rows[0] as { id: string }).id
}

async function commitmentStatus(memoryId: string): Promise<string | undefined> {
  const r = await ownerPool.query('SELECT status FROM commitments WHERE memory_id = $1', [memoryId])
  return (r.rows[0] as { status: string } | undefined)?.status
}

/** A real commitment plus a staged proposal for it; returns both ids. */
async function staged(topic: string): Promise<{ memoryId: string; proposalId: string }> {
  const { id: memoryId } = await remember(
    userA,
    { memoryType: 'commitment', topic, content: `${topic} — fixture` },
    ACTOR,
  )
  const run = await seedRun(userA)
  expect(await dbSessionCloserRepo.propose(userA, run, [{ memoryId, probability: 0.7 }])).toBe(1)
  // A second pass over the same commitment stages nothing new.
  expect(await dbSessionCloserRepo.propose(userA, run, [{ memoryId, probability: 0.8 }])).toBe(0)
  const page = await listProposalsPage(userA, { status: 'proposed', limit: 10 })
  const proposal = page.resolutionProposals.find((p) => p.memoryId === memoryId)
  if (proposal === undefined) throw new Error('expected a staged resolution proposal')
  return { memoryId, proposalId: proposal.id }
}

describe('resolution proposals through core (issue #229)', () => {
  it('lists the kind beside the others with live totals', async () => {
    await staged('ship the closer')
    const page = await listProposalsPage(userA, { limit: 10 })
    expect(page.resolutionProposals).toHaveLength(1)
    expect(page.totals).toEqual({ edge: 0, fact: 0, resolution: 1 })
  })

  it('accept resolves the commitment as the reviewer and marks the proposal applied', async () => {
    const { memoryId, proposalId } = await staged('write the migration')
    const decided = await acceptProposalAnyKind(userA, proposalId, ACTOR)
    expect(decided).toMatchObject({ kind: 'resolution_applied', commitmentStatus: 'resolved' })
    expect(await commitmentStatus(memoryId)).toBe('resolved')
    const events = await ownerPool.query(
      `SELECT actor_kind FROM memory_events WHERE memory_id = $1 AND event_kind = 'resolve'`,
      [memoryId],
    )
    expect(events.rows).toEqual([{ actor_kind: ACTOR }])
    // Decided once: a second accept is not-found, and the commitment is untouched.
    await expect(acceptProposalAnyKind(userA, proposalId, ACTOR)).rejects.toThrow()
    const status = await ownerPool.query('SELECT status FROM resolution_proposals WHERE id = $1', [
      proposalId,
    ])
    expect(status.rows[0]).toMatchObject({ status: 'applied' })
  })

  it('an accept that loses to a reject writes nothing; a refused transition reopens', async () => {
    const { memoryId, proposalId } = await staged('race the reviewer')
    await rejectProposalAnyKind(userA, proposalId)
    await expect(acceptProposalAnyKind(userA, proposalId, ACTOR)).rejects.toThrow()
    expect(await commitmentStatus(memoryId)).toBe('open')

    const second = await staged('expire meanwhile')
    await ownerPool.query(`UPDATE commitments SET status = 'expired' WHERE memory_id = $1`, [
      second.memoryId,
    ])
    await expect(acceptProposalAnyKind(userA, second.proposalId, ACTOR)).rejects.toThrow()
    const row = await ownerPool.query(
      'SELECT status, decided_at FROM resolution_proposals WHERE id = $1',
      [second.proposalId],
    )
    expect(row.rows[0]).toMatchObject({ status: 'proposed', decided_at: null })
  })

  it('reject leaves the commitment open', async () => {
    const { memoryId, proposalId } = await staged('reply to review')
    const decided = await rejectProposalAnyKind(userA, proposalId)
    expect(decided).toMatchObject({ kind: 'resolution', proposal: { status: 'rejected' } })
    expect(await commitmentStatus(memoryId)).toBe('open')
  })
})
