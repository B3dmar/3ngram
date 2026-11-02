// SPDX-License-Identifier: Apache-2.0
// Integration: retention proposals (the forgetting pass) through core against
// the real runtime role. The review list pages them beside the other kinds and
// never shows a dismissed verdict; accept applies the verdict as the reviewer
// through the any-kind path; reject leaves the memory alone.
import { closeDb } from '@3ngram/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import {
  acceptProposalAnyKind,
  ProposalNotFoundError,
  RetentionProposalNotApplicableError,
  rejectProposalAnyKind,
} from '../../src/admin/proposals.js'
import { listProposalsPage } from '../../src/admin/proposals-page.js'

let userId: string

async function seedMemory(memoryType = 'decision'): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
     VALUES ($1, $2, 'topic', 'content', md5(random()::text)) RETURNING id`,
    [userId, memoryType],
  )
  return (r.rows[0] as { id: string }).id
}

async function seedProposal(
  memoryId: string,
  action: string,
  status = 'proposed',
): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO retention_proposals (user_id, memory_id, action, probability, probabilities, model, status)
     VALUES ($1, $2, $3, 0.9, '{}'::jsonb, 'jev-test', $4) RETURNING id`,
    [userId, memoryId, action, status],
  )
  return (r.rows[0] as { id: string }).id
}

const memoryStatus = async (id: string) =>
  (await ownerPool.query('SELECT status FROM memories WHERE id = $1', [id])).rows[0]?.status

beforeAll(async () => {
  userId = await seedUser(`retention-core-${crypto.randomUUID()}@test.local`)
})
beforeEach(async () => {
  await resetDomainTables()
  userId = await seedUser(`retention-core-${crypto.randomUUID()}@test.local`)
})
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('retention proposals through core', () => {
  it('lists the kind beside the others, never a dismissed verdict, with live totals', async () => {
    const open = await seedProposal(await seedMemory(), 'archive')
    await seedProposal(await seedMemory(), 'keep', 'dismissed')
    const page = await listProposalsPage(userId, { limit: 25 })
    expect(page.retentionProposals.map((p) => p.id)).toEqual([open])
    expect(page.totals).toEqual({ edge: 0, fact: 0, resolution: 0, retention: 1 })
  })

  it('accept archives as the reviewer; reject leaves the memory alone', async () => {
    const archived = await seedMemory()
    const accepted = await acceptProposalAnyKind(
      userId,
      await seedProposal(archived, 'archive'),
      'user_mcp',
    )
    expect(accepted.kind).toBe('retention_applied')
    expect(await memoryStatus(archived)).toBe('archived')

    const kept = await seedMemory()
    const rejected = await rejectProposalAnyKind(userId, await seedProposal(kept, 'archive'))
    expect(rejected.kind).toBe('retention')
    expect(await memoryStatus(kept)).toBe('active')
  })

  it('a dismissed verdict is not found by either decision, through every probe', async () => {
    const dismissed = await seedProposal(await seedMemory(), 'archive', 'dismissed')
    await expect(acceptProposalAnyKind(userId, dismissed, 'user_mcp')).rejects.toBeInstanceOf(
      ProposalNotFoundError,
    )
    await expect(rejectProposalAnyKind(userId, dismissed)).rejects.toBeInstanceOf(
      ProposalNotFoundError,
    )
  })

  it('a refused verdict surfaces as not applicable and leaves the proposal open', async () => {
    const committed = await seedMemory('commitment')
    await ownerPool.query('INSERT INTO commitments (user_id, memory_id) VALUES ($1, $2)', [
      userId,
      committed,
    ])
    const id = await seedProposal(committed, 'archive')
    await expect(acceptProposalAnyKind(userId, id, 'user_mcp')).rejects.toBeInstanceOf(
      RetentionProposalNotApplicableError,
    )
    const status = await ownerPool.query('SELECT status FROM retention_proposals WHERE id = $1', [
      id,
    ])
    expect(status.rows[0]?.status).toBe('proposed')
    expect(await memoryStatus(committed)).toBe('active')
  })
})
