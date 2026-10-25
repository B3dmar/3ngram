// SPDX-License-Identifier: Apache-2.0
// Keyset reads for proposal-review pagination (issue #320), through the RUNTIME
// role via withTenant() — owner bypasses RLS and would prove nothing.
//
// What only a real database can prove here:
//   - a same-transaction batch shares ONE microsecond `created_at`, and the
//     strictly-after predicate still walks every tied row exactly once because
//     the position is bound back at full precision (never via a JS Date);
//   - the status filter and the counts agree with the rows;
//   - RLS (and the fact table's user_id predicate) keep another tenant's rows
//     out of both the pages and the counts.
// The cross-kind merge and the transport cursor are proven in
// packages/core/test/integration/proposals-page.int.test.ts and the server suites.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { type FactProposalWrite, insertFactProposals } from '../../src/fact-proposals.js'
import {
  countFactProposals,
  countProposals,
  type KeyedProposal,
  listFactProposalsAfter,
  listProposalsAfter,
  type ProposalKeyset,
} from '../../src/proposals-page.js'
import { insertProposals, type ProposalWrite } from '../../src/proposals-write.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let uid: string
let otherUid: string

async function seedMemories(userId: string, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1, 'fact', 'proposals-page-topic', 'proposals-page-content', $2) RETURNING id`,
      [userId, `pp-${userId}-${i}-${Math.random()}`],
    )
    ids.push(r.rows[0].id)
  }
  return ids
}

/** `count` distinct open edge candidates over the given memories (ordered pairs). */
function edgeCandidates(userId: string, memoryIds: string[], count: number): ProposalWrite[] {
  const out: ProposalWrite[] = []
  for (const from of memoryIds) {
    for (const to of memoryIds) {
      if (from === to || out.length >= count) continue
      out.push({
        userId,
        fromId: from,
        toId: to,
        edgeType: 'extends',
        memoryType: 'fact',
        similarity: 0.9,
      })
    }
  }
  return out
}

function factCandidates(userId: string, memoryId: string, count: number, tag: string) {
  return Array.from(
    { length: count },
    (_, i): FactProposalWrite => ({
      userId,
      memoryId,
      subject: 'proposals.page',
      predicate: 'seed.value',
      value: `${tag}-${i}`,
      memoryType: 'fact',
    }),
  )
}

/** Walk one table to exhaustion with the keyset, `pageSize` rows per read. */
async function walk<T extends { id: string }>(
  read: (after: ProposalKeyset | undefined) => Promise<KeyedProposal<T>[]>,
): Promise<string[]> {
  const ids: string[] = []
  let after: ProposalKeyset | undefined
  for (let reads = 0; reads < 100; reads++) {
    const rows = await read(after)
    if (rows.length === 0) return ids
    ids.push(...rows.map((r) => r.record.id))
    after = rows[rows.length - 1]?.position
  }
  throw new Error('walk did not terminate')
}

beforeAll(async () => {
  await resetDomainTables()
}, 120_000)

beforeEach(async () => {
  await resetDomainTables()
  uid = await seedUser('proposals-page@test.local')
  otherUid = await seedUser('proposals-page-other@test.local')
})

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('listProposalsAfter / listFactProposalsAfter keyset', () => {
  it('walks a same-timestamp batch exactly once per table, in created_at DESC, id DESC order', async () => {
    const memories = await seedMemories(uid, 6)
    // ONE transaction -> one now() -> every row of each kind ties on created_at.
    await withTenant(uid, async (tx) => {
      await insertProposals(tx, edgeCandidates(uid, memories, 23))
      await insertFactProposals(tx, factCandidates(uid, memories[0] as string, 23, 'tie'))
    })
    const tied = await ownerPool.query(
      `SELECT count(DISTINCT created_at)::int AS n FROM consolidation_proposals WHERE user_id = $1`,
      [uid],
    )
    expect(tied.rows[0].n).toBe(1)

    const edgeIds = await walk((after) =>
      withTenant(uid, (tx) => listProposalsAfter(tx, { limit: 4, after })),
    )
    const factIds = await walk((after) =>
      withTenant(uid, (tx) => listFactProposalsAfter(tx, uid, { limit: 4, after })),
    )
    expect(edgeIds).toHaveLength(23)
    expect(new Set(edgeIds).size).toBe(23)
    expect(factIds).toHaveLength(23)
    expect(new Set(factIds).size).toBe(23)
    // Ties broken by id DESC.
    expect(edgeIds).toEqual([...edgeIds].sort().reverse())
    expect(factIds).toEqual([...factIds].sort().reverse())
  })

  it('returns the position at full microsecond precision, matching the stored column', async () => {
    const memories = await seedMemories(uid, 2)
    await withTenant(uid, (tx) => insertProposals(tx, edgeCandidates(uid, memories, 1)))
    await ownerPool.query(
      `UPDATE consolidation_proposals SET created_at = '2026-03-04T05:06:07.123456Z' WHERE user_id = $1`,
      [uid],
    )
    const [row] = await withTenant(uid, (tx) => listProposalsAfter(tx, { limit: 1 }))
    expect(row?.position.createdAt).toBe('2026-03-04T05:06:07.123456Z')
    // Resuming strictly after its own position excludes it (no repeat).
    const next = await withTenant(uid, (tx) =>
      listProposalsAfter(tx, { limit: 5, after: row?.position }),
    )
    expect(next).toEqual([])
  })

  it('applies the status filter to rows and counts alike', async () => {
    const memories = await seedMemories(uid, 4)
    await withTenant(uid, async (tx) => {
      await insertProposals(tx, edgeCandidates(uid, memories, 5))
      await insertFactProposals(tx, factCandidates(uid, memories[0] as string, 4, 'st'))
    })
    await ownerPool.query(
      `UPDATE consolidation_proposals SET status = 'rejected', decided_at = now()
       WHERE id IN (SELECT id FROM consolidation_proposals WHERE user_id = $1 LIMIT 2)`,
      [uid],
    )
    await ownerPool.query(
      `UPDATE fact_proposals SET status = 'rejected', decided_at = now()
       WHERE id IN (SELECT id FROM fact_proposals WHERE user_id = $1 LIMIT 1)`,
      [uid],
    )
    await withTenant(uid, async (tx) => {
      const proposed = await listProposalsAfter(tx, { status: 'proposed', limit: 50 })
      expect(proposed).toHaveLength(3)
      expect(proposed.every((r) => r.record.status === 'proposed')).toBe(true)
      expect(await countProposals(tx, 'proposed')).toBe(3)
      expect(await countProposals(tx, 'rejected')).toBe(2)
      expect(await countProposals(tx)).toBe(5)
      const facts = await listFactProposalsAfter(tx, uid, { status: 'rejected', limit: 50 })
      expect(facts).toHaveLength(1)
      expect(await countFactProposals(tx, uid, 'proposed')).toBe(3)
      expect(await countFactProposals(tx, uid)).toBe(4)
    })
  })

  it("never returns or counts another tenant's proposals", async () => {
    const mine = await seedMemories(uid, 3)
    const theirs = await seedMemories(otherUid, 3)
    await withTenant(uid, async (tx) => {
      await insertProposals(tx, edgeCandidates(uid, mine, 2))
      await insertFactProposals(tx, factCandidates(uid, mine[0] as string, 2, 'mine'))
    })
    await withTenant(otherUid, async (tx) => {
      await insertProposals(tx, edgeCandidates(otherUid, theirs, 5))
      await insertFactProposals(tx, factCandidates(otherUid, theirs[0] as string, 5, 'theirs'))
    })
    await withTenant(uid, async (tx) => {
      expect(await listProposalsAfter(tx, { limit: 50 })).toHaveLength(2)
      expect(await listFactProposalsAfter(tx, uid, { limit: 50 })).toHaveLength(2)
      expect(await countProposals(tx)).toBe(2)
      expect(await countFactProposals(tx, uid)).toBe(2)
    })
  })

  it('is empty, never a throw, for a tenant with no proposals', async () => {
    await withTenant(uid, async (tx) => {
      expect(await listProposalsAfter(tx, { limit: 10 })).toEqual([])
      expect(await listFactProposalsAfter(tx, uid, { limit: 10 })).toEqual([])
      expect(await countProposals(tx)).toBe(0)
      expect(await countFactProposals(tx, uid)).toBe(0)
    })
  })
})
