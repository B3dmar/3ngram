// SPDX-License-Identifier: Apache-2.0
// Resolution-proposal store (issue #229) through the RUNTIME role via
// withTenant(), the production path (the table is FORCE RLS).
//
// Covers: insert round-trip; one OPEN proposal per commitment (a repeat insert
// is a no-op, re-proposal after a decision is allowed); decide is a
// compare-and-set (a second decision misses); the probability CHECK; the
// keyset source and count; tenant isolation through the accessors and raw SQL;
// RLS fails closed with no tenant bound; FORCE.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { listResolutionProposalsAfter } from '../../src/proposals-page.js'
import { ProposalNotFoundError } from '../../src/proposals-read.js'
import {
  countResolutionProposals,
  decideResolutionProposal,
  getOpenResolutionProposal,
  insertResolutionProposals,
} from '../../src/resolution-proposals.js'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
  withTestTransaction,
} from './helpers.js'

let userA: string
let userB: string

/** A commitment memory owned by `userId` (fixture setup through the owner pool). */
async function seedCommitment(userId: string): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, content, memory_type, topic, scope, content_hash)
     VALUES ($1, 'fixture commitment', 'commitment', 'fixture', 'work', md5(random()::text))
     RETURNING id`,
    [userId],
  )
  return (r.rows[0] as { id: string }).id
}

/** A closed agent-session run owned by `userId`. */
async function seedRun(userId: string): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO agent_sessions (user_id, agent, session_id, source, selector, closed_at)
     VALUES ($1, 'claude-code', $2, 'startup', '{"kind":"all"}'::jsonb, now())
     RETURNING id`,
    [userId, `run-${crypto.randomUUID()}`],
  )
  return (r.rows[0] as { id: string }).id
}

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`resolution-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`resolution-b-${crypto.randomUUID()}@test.local`)
})

afterAll(closePools)

describe('resolution proposal store (runtime role, withTenant)', () => {
  it('inserts, keeps one OPEN proposal per commitment, and re-proposes after a decision', async () => {
    const memoryId = await seedCommitment(userA)
    const run = await seedRun(userA)
    const insert = () =>
      withTenant(userA, (tx) =>
        insertResolutionProposals(tx, userA, run, [{ memoryId, probability: 0.7 }]),
      )
    expect(await insert()).toBe(1)
    expect(await insert()).toBe(0)
    const [open] = await withTenant(userA, (tx) =>
      listResolutionProposalsAfter(tx, userA, { status: 'proposed', limit: 10 }),
    )
    expect(open?.record).toMatchObject({ memoryId, sessionRunId: run, status: 'proposed' })
    expect(open?.record.probability).toBeCloseTo(0.7)

    const id = open?.record.id as string
    const rejected = await withTenant(userA, (tx) =>
      decideResolutionProposal(tx, userA, id, 'rejected'),
    )
    expect(rejected.status).toBe('rejected')
    expect(rejected.decidedAt).not.toBeNull()
    // Re-proposal after the rejection is allowed (the open index is partial).
    expect(await insert()).toBe(1)
    expect(await withTenant(userA, (tx) => countResolutionProposals(tx, userA))).toBe(2)
    expect(await withTenant(userA, (tx) => countResolutionProposals(tx, userA, 'proposed'))).toBe(1)
  })

  it('decides by compare-and-set: a second decision, or a read of a decided one, misses', async () => {
    const memoryId = await seedCommitment(userA)
    const run = await seedRun(userA)
    await withTenant(userA, (tx) =>
      insertResolutionProposals(tx, userA, run, [{ memoryId, probability: 0.6 }]),
    )
    const [row] = await withTenant(userA, (tx) =>
      listResolutionProposalsAfter(tx, userA, { limit: 1 }),
    )
    const id = row?.record.id as string
    expect((await withTenant(userA, (tx) => getOpenResolutionProposal(tx, userA, id))).id).toBe(id)
    await withTenant(userA, (tx) => decideResolutionProposal(tx, userA, id, 'applied'))
    await expect(
      withTenant(userA, (tx) => decideResolutionProposal(tx, userA, id, 'rejected')),
    ).rejects.toBeInstanceOf(ProposalNotFoundError)
    await expect(
      withTenant(userA, (tx) => getOpenResolutionProposal(tx, userA, id)),
    ).rejects.toBeInstanceOf(ProposalNotFoundError)
  })

  it('the DB CHECK rejects a probability outside [0, 1]', async () => {
    const memoryId = await seedCommitment(userA)
    const run = await seedRun(userA)
    await expect(
      withTenant(userA, (tx) =>
        insertResolutionProposals(tx, userA, run, [{ memoryId, probability: 1.2 }]),
      ),
    ).rejects.toThrow()
  })

  it('refuses a proposal over another tenant’s memory or run (composite FKs)', async () => {
    const foreignMemory = await seedCommitment(userB)
    const run = await seedRun(userA)
    await expect(
      withTenant(userA, (tx) =>
        insertResolutionProposals(tx, userA, run, [{ memoryId: foreignMemory, probability: 0.6 }]),
      ),
    ).rejects.toThrow()
    const memoryId = await seedCommitment(userA)
    const foreignRun = await seedRun(userB)
    await expect(
      withTenant(userA, (tx) =>
        insertResolutionProposals(tx, userA, foreignRun, [{ memoryId, probability: 0.6 }]),
      ),
    ).rejects.toThrow()
  })

  it('isolates tenants: B neither lists, decides nor reads A’s proposal', async () => {
    const memoryId = await seedCommitment(userA)
    const run = await seedRun(userA)
    await withTenant(userA, (tx) =>
      insertResolutionProposals(tx, userA, run, [{ memoryId, probability: 0.6 }]),
    )
    const [row] = await withTenant(userA, (tx) =>
      listResolutionProposalsAfter(tx, userA, { limit: 1 }),
    )
    const id = row?.record.id as string
    expect(
      await withTenant(userB, (tx) => listResolutionProposalsAfter(tx, userB, { limit: 10 })),
    ).toEqual([])
    await expect(
      withTenant(userB, (tx) => decideResolutionProposal(tx, userB, id, 'applied')),
    ).rejects.toBeInstanceOf(ProposalNotFoundError)
    await withTestTransaction(async (conn) => {
      await conn.query(`SELECT set_config('app.user_id', $1, true)`, [userB])
      const read = await conn.query('SELECT * FROM resolution_proposals WHERE id = $1', [id])
      expect(read.rowCount).toBe(0)
      const updated = await conn.query(
        `UPDATE resolution_proposals SET status = 'applied' WHERE id = $1`,
        [id],
      )
      expect(updated.rowCount).toBe(0)
    })
    await withTestTransaction(async (conn) => {
      const r = await conn.query('SELECT * FROM resolution_proposals')
      expect(r.rowCount).toBe(0)
    })
    expect((await withTenant(userA, (tx) => getOpenResolutionProposal(tx, userA, id))).status).toBe(
      'proposed',
    )
  })

  it('FORCEs RLS: the table is in the forced tenant set', async () => {
    const r = await ownerPool.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'resolution_proposals'`,
    )
    expect(r.rows[0]?.relforcerowsecurity).toBe(true)
  })
})
