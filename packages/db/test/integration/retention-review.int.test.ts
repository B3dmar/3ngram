// SPDX-License-Identifier: Apache-2.0
// Reviewing retention proposals (the forgetting pass) through the RUNTIME role
// via withTenant(), the production path.
//
// Covers: listing and counting exclude dismissed rows; reject is a
// compare-and-set; accept applies the verdict in the same transaction as the
// claim (archive with its audit event, supersede with the edge and the closed
// predecessor, conflict as a review only); a refused verdict rolls the claim
// back; a dismissed row cannot be decided; another tenant's proposal is
// invisible.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { EpisodicSupersessionError, SuccessorNotLiveError } from '../../src/proposals-apply.js'
import { listRetentionProposalsAfter } from '../../src/proposals-page.js'
import { ProposalNotFoundError } from '../../src/proposals-read.js'
import {
  acceptRetentionProposal,
  countRetentionProposals,
  decideRetentionProposal,
  RetentionProposalNotApplicableError,
} from '../../src/retention-proposals.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string
let userB: string

async function seedMemory(userId: string, type = 'decision', createdDaysAgo = 30): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, created_at)
     VALUES ($1, $2, 'topic', 'content', md5(random()::text), now() - make_interval(days => $3))
     RETURNING id`,
    [userId, type, createdDaysAgo],
  )
  return (r.rows[0] as { id: string }).id
}

async function seedProposal(
  userId: string,
  memoryId: string,
  action: string,
  opts: { related?: string; status?: string } = {},
): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO retention_proposals (user_id, memory_id, action, related_memory_id, probability,
                                      probabilities, model, status)
     VALUES ($1, $2, $3, $4, 0.9, '{}'::jsonb, 'jev-test', $5) RETURNING id`,
    [userId, memoryId, action, opts.related ?? null, opts.status ?? 'proposed'],
  )
  return (r.rows[0] as { id: string }).id
}

const memoryState = async (id: string) =>
  (
    await ownerPool.query(
      'SELECT status, valid_to IS NOT NULL AS closed FROM memories WHERE id = $1',
      [id],
    )
  ).rows[0]
const proposalStatus = async (id: string) =>
  (await ownerPool.query('SELECT status FROM retention_proposals WHERE id = $1', [id])).rows[0]
    ?.status
const events = async (memoryId: string) =>
  (
    await ownerPool.query(
      'SELECT event_kind FROM memory_events WHERE memory_id = $1 ORDER BY created_at',
      [memoryId],
    )
  ).rows.map((r) => r.event_kind)
const accept = (userId: string, proposalId: string) =>
  withTenant(userId, (tx) => acceptRetentionProposal(tx, userId, proposalId, 'user_mcp'))

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`retention-review-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`retention-review-b-${crypto.randomUUID()}@test.local`)
})

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('listing and counting', () => {
  it('never lists or counts a dismissed row, whatever the status filter', async () => {
    const m = await seedMemory(userA)
    const open = await seedProposal(userA, m, 'archive')
    await seedProposal(userA, m, 'keep', { status: 'dismissed' })
    await seedProposal(userB, await seedMemory(userB), 'archive')
    const list = (status?: string) =>
      withTenant(userA, (tx) =>
        listRetentionProposalsAfter(tx, userA, { limit: 10, ...(status ? { status } : {}) }),
      )
    expect((await list()).map((r) => r.record.id)).toEqual([open])
    expect((await list('proposed')).map((r) => r.record.id)).toEqual([open])
    expect(await list('rejected')).toEqual([])
    expect(await withTenant(userA, (tx) => countRetentionProposals(tx, userA))).toBe(1)
  })
})

describe('reject', () => {
  it('is a compare-and-set: a second decision, or a dismissed row, misses', async () => {
    const id = await seedProposal(userA, await seedMemory(userA), 'archive')
    const decide = (pid: string) =>
      withTenant(userA, (tx) => decideRetentionProposal(tx, userA, pid, 'rejected'))
    expect((await decide(id)).status).toBe('rejected')
    await expect(decide(id)).rejects.toBeInstanceOf(ProposalNotFoundError)
    const dismissed = await seedProposal(userA, await seedMemory(userA), 'keep', {
      status: 'dismissed',
    })
    await expect(decide(dismissed)).rejects.toBeInstanceOf(ProposalNotFoundError)
  })
})

describe('accept', () => {
  it('archive: archives the memory with an audited event', async () => {
    const m = await seedMemory(userA)
    const id = await seedProposal(userA, m, 'archive')
    expect((await accept(userA, id)).status).toBe('applied')
    expect(await memoryState(m)).toEqual({ status: 'archived', closed: false })
    expect(await events(m)).toContain('archive')
  })

  it('archive: a refused disposition rolls the claim back', async () => {
    const m = await seedMemory(userA, 'commitment')
    await ownerPool.query(`INSERT INTO commitments (user_id, memory_id) VALUES ($1, $2)`, [
      userA,
      m,
    ])
    const id = await seedProposal(userA, m, 'archive')
    await expect(accept(userA, id)).rejects.toBeInstanceOf(RetentionProposalNotApplicableError)
    expect(await proposalStatus(id)).toBe('proposed')
    expect(await memoryState(m)).toEqual({ status: 'active', closed: false })
  })

  it('supersede: closes the older memory behind a supersedes edge from the newer one', async () => {
    const older = await seedMemory(userA, 'decision', 60)
    const newer = await seedMemory(userA, 'decision', 10)
    const id = await seedProposal(userA, older, 'supersede', { related: newer })
    expect((await accept(userA, id)).status).toBe('applied')
    expect(await memoryState(older)).toEqual({ status: 'active', closed: true })
    expect(await memoryState(newer)).toEqual({ status: 'active', closed: false })
    const edge = await ownerPool.query(
      'SELECT edge_type FROM memory_edges WHERE from_id = $1 AND to_id = $2',
      [newer, older],
    )
    expect(edge.rows).toEqual([{ edge_type: 'supersedes' }])
    expect(await events(older)).toContain('supersede')
  })

  it('supersede: a newer memory that is no longer live rolls the claim back', async () => {
    const older = await seedMemory(userA, 'decision', 60)
    const newer = await seedMemory(userA, 'decision', 10)
    await ownerPool.query(`UPDATE memories SET status = 'archived' WHERE id = $1`, [newer])
    const id = await seedProposal(userA, older, 'supersede', { related: newer })
    await expect(accept(userA, id)).rejects.toBeInstanceOf(SuccessorNotLiveError)
    expect(await proposalStatus(id)).toBe('proposed')
    expect(await memoryState(older)).toEqual({ status: 'active', closed: false })
  })

  it('conflict: records the review and changes no memory', async () => {
    const a = await seedMemory(userA, 'fact', 60)
    const b = await seedMemory(userA, 'fact', 10)
    const id = await seedProposal(userA, a, 'conflict', { related: b })
    expect((await accept(userA, id)).status).toBe('applied')
    expect(await memoryState(a)).toEqual({ status: 'active', closed: false })
    expect(await memoryState(b)).toEqual({ status: 'active', closed: false })
  })

  it("cannot reach another tenant's proposal", async () => {
    const id = await seedProposal(userB, await seedMemory(userB), 'archive')
    await expect(accept(userA, id)).rejects.toBeInstanceOf(ProposalNotFoundError)
    expect(await proposalStatus(id)).toBe('proposed')
  })
})

describe('accept: refusals and races', () => {
  it('supersede: refuses an older memory that is no longer live, and rolls back', async () => {
    const older = await seedMemory(userA, 'decision', 60)
    const newer = await seedMemory(userA, 'decision', 10)
    await ownerPool.query(`UPDATE memories SET status = 'archived' WHERE id = $1`, [older])
    const id = await seedProposal(userA, older, 'supersede', { related: newer })
    await expect(accept(userA, id)).rejects.toBeInstanceOf(RetentionProposalNotApplicableError)
    expect(await proposalStatus(id)).toBe('proposed')
    expect(await memoryState(older)).toEqual({ status: 'archived', closed: false })
  })

  it('supersede: refuses an event-type memory, and rolls back', async () => {
    const older = await seedMemory(userA, 'event', 60)
    const newer = await seedMemory(userA, 'event', 10)
    const id = await seedProposal(userA, older, 'supersede', { related: newer })
    await expect(accept(userA, id)).rejects.toBeInstanceOf(EpisodicSupersessionError)
    expect(await proposalStatus(id)).toBe('proposed')
    expect(await memoryState(older)).toEqual({ status: 'active', closed: false })
  })

  it('archive: an already archived memory still marks the proposal applied, as the reviewer', async () => {
    const m = await seedMemory(userA)
    const first = await seedProposal(userA, m, 'archive')
    await accept(userA, first)
    const actor = await ownerPool.query(
      `SELECT actor_kind FROM memory_events WHERE memory_id = $1 AND event_kind = 'archive'`,
      [m],
    )
    expect(actor.rows).toEqual([{ actor_kind: 'user_mcp' }])
    const second = await seedProposal(userA, m, 'archive')
    expect((await accept(userA, second)).status).toBe('applied')
  })

  it('two concurrent accepts: exactly one wins', async () => {
    const id = await seedProposal(userA, await seedMemory(userA), 'archive')
    const results = await Promise.allSettled([accept(userA, id), accept(userA, id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toBeInstanceOf(ProposalNotFoundError)
  })
})
