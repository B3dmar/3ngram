// SPDX-License-Identifier: Apache-2.0
// Fact-proposal review operations through the RUNTIME role via withTenant() —
// the production path. Owner bypasses RLS and would prove nothing
// (docs/concepts/testing.mdx).
//
// The load-bearing case here is idempotency. The insert's ON CONFLICT target
// has to INFER the partial expression index `fact_proposals_open_idx`; if it
// does not match, Postgres raises rather than skipping, so "re-running an
// extractor is a no-op" is only true against a real database. The unit test
// (test/fact-proposals.test.ts) pins the emitted SQL; this proves the database
// accepts that inference and behaves as intended.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import {
  type FactProposalWrite,
  insertFactProposals,
  listFactProposals,
  rejectFactProposal,
} from '../../src/fact-proposals.js'
import { applyFactProposal } from '../../src/fact-proposals-apply.js'
import { ProposalNotFoundError } from '../../src/proposals-read.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let uid: string
let otherUid: string
let memoryId: string
let otherMemoryId: string

/** A facts/proposal row needs a parent memory (composite FK). */
async function seedMemory(userId: string, hash: string): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
     VALUES ($1, 'fact', 'fact-proposals-topic', 'fact-proposals-content', $2) RETURNING id`,
    [userId, hash],
  )
  return r.rows[0].id
}

const candidate = (overrides: Partial<FactProposalWrite> = {}): FactProposalWrite => ({
  userId: uid,
  memoryId,
  subject: 'lift.back_squat',
  predicate: 'top_set.weight_kg',
  value: '98',
  memoryType: 'fact',
  ...overrides,
})

const insert = (rows: FactProposalWrite[], userId = uid) =>
  withTenant(userId, (tx) => insertFactProposals(tx, rows))

const list = (userId = uid) => withTenant(userId, (tx) => listFactProposals(tx, {}))

async function countFacts(userId: string): Promise<number> {
  const r = await ownerPool.query('SELECT count(*)::int AS n FROM facts WHERE user_id = $1', [
    userId,
  ])
  return r.rows[0].n
}

beforeAll(async () => {
  await resetDomainTables()
}, 120_000)

beforeEach(async () => {
  await resetDomainTables()
  uid = await seedUser('fact-proposals@test.local')
  otherUid = await seedUser('fact-proposals-other@test.local')
  memoryId = await seedMemory(uid, `fp-${Date.now()}-${Math.random()}`)
  otherMemoryId = await seedMemory(otherUid, `fp-other-${Date.now()}-${Math.random()}`)
})

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('insertFactProposals idempotency (open-proposal index inference)', () => {
  it('collapses a re-proposed triple to the single OPEN row, keeping the first metadata', async () => {
    expect(await insert([candidate({ confidence: 0.5, rationale: 'first' })])).toBe(1)
    // Same (memory, subject, predicate, value) — the key deliberately ignores
    // confidence and rationale, so the re-run is a no-op and the FIRST wins.
    expect(await insert([candidate({ confidence: 0.99, rationale: 'second' })])).toBe(0)

    const rows = await list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.confidence).toBeCloseTo(0.5)
    expect(rows[0]?.rationale).toBe('first')
  })

  it('does not collapse a DIFFERENT value for the same subject/predicate', async () => {
    expect(await insert([candidate()])).toBe(1)
    expect(await insert([candidate({ value: '100' })])).toBe(1)
    expect((await list()).map((row) => row.value).sort()).toEqual(['100', '98'])
  })

  it('allows re-proposing the same triple once the open row is DECIDED', async () => {
    expect(await insert([candidate()])).toBe(1)
    const [open] = await list()
    await withTenant(uid, (tx) => rejectFactProposal(tx, open?.id as string))
    // The partial index only constrains status='proposed', so a rejected row
    // does not block a fresh proposal of the same claim.
    expect(await insert([candidate()])).toBe(1)
    expect(await list()).toHaveLength(2)
  })

  it('inserts a batch in one statement and skips only the colliding member', async () => {
    expect(await insert([candidate()])).toBe(1)
    expect(await insert([candidate(), candidate({ predicate: 'top_set.reps', value: '3' })])).toBe(
      1,
    )
    expect(await list()).toHaveLength(2)
  })
})

describe('rejectFactProposal', () => {
  it('flips proposed -> rejected and stamps decided_at, writing no fact', async () => {
    await insert([candidate()])
    const [open] = await list()

    const rejected = await withTenant(uid, (tx) => rejectFactProposal(tx, open?.id as string))
    expect(rejected.status).toBe('rejected')
    expect(rejected.decidedAt).not.toBeNull()
    expect(await countFacts(uid)).toBe(0)
  })

  it('raises ProposalNotFoundError on an already-decided proposal', async () => {
    await insert([candidate()])
    const [open] = await list()
    await withTenant(uid, (tx) => rejectFactProposal(tx, open?.id as string))

    await expect(
      withTenant(uid, (tx) => rejectFactProposal(tx, open?.id as string)),
    ).rejects.toBeInstanceOf(ProposalNotFoundError)
  })
})

describe('applyFactProposal', () => {
  it('writes the fact and decides the row in one transaction', async () => {
    await insert([candidate({ confidence: 0.75 })])
    const [open] = await list()

    const { factId, proposal } = await withTenant(uid, (tx) =>
      applyFactProposal(tx, uid, open?.id as string),
    )
    expect(proposal.status).toBe('applied')
    expect(proposal.decidedAt).not.toBeNull()

    const facts = await ownerPool.query(
      'SELECT id, user_id, memory_id, subject, predicate, value, confidence, valid_to FROM facts WHERE user_id = $1',
      [uid],
    )
    expect(facts.rowCount).toBe(1)
    expect(facts.rows[0].id).toBe(factId)
    expect(facts.rows[0].memory_id).toBe(memoryId)
    expect(facts.rows[0].value).toBe('98')
    expect(facts.rows[0].confidence).toBeCloseTo(0.75)
    // A newly asserted fact is live.
    expect(facts.rows[0].valid_to).toBeNull()
  })

  it('lands the facts column default when the proposal carries no valid_from', async () => {
    await insert([candidate()])
    const [open] = await list()
    expect(open?.validFrom).toBeNull()

    await withTenant(uid, (tx) => applyFactProposal(tx, uid, open?.id as string))

    // NOT NULL on facts: the null proposal instant falls through to now().
    const facts = await ownerPool.query('SELECT valid_from FROM facts WHERE user_id = $1', [uid])
    expect(facts.rows[0].valid_from).not.toBeNull()
  })

  it('carries an explicit validity window through to the fact', async () => {
    const validFrom = new Date('2026-01-01T00:00:00.000Z')
    await insert([candidate({ validFrom })])
    const [open] = await list()

    await withTenant(uid, (tx) => applyFactProposal(tx, uid, open?.id as string))

    const facts = await ownerPool.query('SELECT valid_from FROM facts WHERE user_id = $1', [uid])
    expect(new Date(facts.rows[0].valid_from).toISOString()).toBe(validFrom.toISOString())
  })

  it('refuses a double-apply and an apply-after-reject, writing exactly one fact', async () => {
    await insert([candidate()])
    const [open] = await list()
    await withTenant(uid, (tx) => applyFactProposal(tx, uid, open?.id as string))

    await expect(
      withTenant(uid, (tx) => applyFactProposal(tx, uid, open?.id as string)),
    ).rejects.toBeInstanceOf(ProposalNotFoundError)
    expect(await countFacts(uid)).toBe(1)

    await insert([candidate({ predicate: 'top_set.reps', value: '3' })])
    const rejected = (await list()).find((row) => row.status === 'proposed')
    await withTenant(uid, (tx) => rejectFactProposal(tx, rejected?.id as string))
    await expect(
      withTenant(uid, (tx) => applyFactProposal(tx, uid, rejected?.id as string)),
    ).rejects.toBeInstanceOf(ProposalNotFoundError)
    expect(await countFacts(uid)).toBe(1)
  })

  it('applies against a SUPERSEDED source memory (reviewed decision)', async () => {
    await insert([candidate()])
    const [open] = await list()
    // Close the source memory's validity, as a revise would.
    await ownerPool.query('UPDATE memories SET valid_to = now() WHERE id = $1', [memoryId])

    // The FK guarantees the source EXISTS, not that it is live; a fact carries
    // its own validity and stands on its own once asserted.
    const { factId } = await withTenant(uid, (tx) => applyFactProposal(tx, uid, open?.id as string))
    expect(factId).toBeTruthy()
    expect(await countFacts(uid)).toBe(1)
  })
})

describe('tenant isolation', () => {
  it("hides another tenant's proposals from list", async () => {
    await insert([candidate()])
    expect(await list(otherUid)).toEqual([])
  })

  it('refuses a cross-tenant reject and apply, writing no fact', async () => {
    await insert([candidate()])
    const [open] = await list()

    // RLS makes the row invisible to the other tenant, so a decision attempt is
    // indistinguishable from a missing proposal — by design.
    await expect(
      withTenant(otherUid, (tx) => rejectFactProposal(tx, open?.id as string)),
    ).rejects.toBeInstanceOf(ProposalNotFoundError)
    await expect(
      withTenant(otherUid, (tx) => applyFactProposal(tx, otherUid, open?.id as string)),
    ).rejects.toBeInstanceOf(ProposalNotFoundError)

    expect(await countFacts(otherUid)).toBe(0)
    expect(await countFacts(uid)).toBe(0)
    const rows = await list()
    expect(rows[0]?.status).toBe('proposed')
  })

  it('scopes an inserted proposal to the writing tenant', async () => {
    await insert([{ ...candidate(), userId: otherUid, memoryId: otherMemoryId }], otherUid)
    expect(await list()).toEqual([])
    expect(await list(otherUid)).toHaveLength(1)
  })
})
