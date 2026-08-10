// SPDX-License-Identifier: Apache-2.0
// The facts write path exercised through the RUNTIME role via writeMemory() —
// the production path. Owner bypasses RLS and would prove nothing
// (docs/concepts/testing.mdx).
//
// What this suite is for: facts ride the SAME transaction as the memory that
// asserts them. A fact whose source memory rolled back would be an unsourced
// claim in the structured projection, and a memory whose facts silently
// vanished would be a claim nobody can query. Both halves are asserted here,
// including the type-independence of the commitment branch in writeMemory.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import { type FactsQuery, getFacts } from '../../src/facts-read.js'
import { writeMemory } from '../../src/memory-write.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

/** Runtime-role read, exactly as production reads facts (RLS binds the tenant). */
const readFacts = (userId: string, query: FactsQuery) =>
  withTenant(userId, (tx) => getFacts(tx, userId, query))

let uid: string
let otherUid: string

/** A distinct hash per write: the live-hash partial index rejects repeats. */
let hashCounter = 0
const nextHash = () => `facts-write-${Date.now()}-${hashCounter++}`

function memoryInput(userId: string, memoryType = 'fact') {
  return {
    userId,
    memoryType,
    topic: 'facts-write-topic',
    content: 'facts-write-content',
    scope: 'work',
    tags: [] as string[],
    contentHash: nextHash(),
    actorKind: 'user_api' as const,
  }
}

/** Owner-side count, so an assertion never depends on the code under test. */
async function countFacts(userId: string): Promise<number> {
  const r = await ownerPool.query('SELECT count(*)::int AS n FROM facts WHERE user_id = $1', [
    userId,
  ])
  return r.rows[0].n
}

async function countMemories(userId: string): Promise<number> {
  const r = await ownerPool.query('SELECT count(*)::int AS n FROM memories WHERE user_id = $1', [
    userId,
  ])
  return r.rows[0].n
}

beforeAll(async () => {
  await resetDomainTables()
  uid = await seedUser('facts-write@test.local')
  otherUid = await seedUser('facts-write-other@test.local')
}, 120_000)

beforeEach(async () => {
  await resetDomainTables()
  uid = await seedUser('facts-write@test.local')
  otherUid = await seedUser('facts-write-other@test.local')
})

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('writeMemory with facts', () => {
  it('lands the memory and every fact in one transaction', async () => {
    const written = await writeMemory(memoryInput(uid), undefined, [
      { subject: 'lift.back_squat', predicate: 'top_set.weight_kg', value: '98' },
      { subject: 'lift.back_squat', predicate: 'top_set.reps', value: '3' },
    ])

    expect(written.factIds).toHaveLength(2)
    expect(new Set(written.factIds).size).toBe(2)
    expect(await countFacts(uid)).toBe(2)

    // Read back through the runtime role: the rows are the tenant's own, tied
    // to the memory that asserted them, and live (valid_to IS NULL).
    const rows = await readFacts(uid, { subject: 'lift.back_squat' })
    expect(rows.map((row) => row.predicate).sort()).toEqual(['top_set.reps', 'top_set.weight_kg'])
    for (const row of rows) expect(row.memoryId).toBe(written.id)
  })

  it('returns factIds positionally so a caller can correlate its input', async () => {
    const written = await writeMemory(memoryInput(uid), undefined, [
      { subject: 'employee:42', predicate: 'role', value: 'engineer' },
      { subject: 'employee:42', predicate: 'city', value: 'berlin' },
    ])
    const ids = written.factIds ?? []
    const r = await ownerPool.query('SELECT id, predicate FROM facts WHERE user_id = $1', [uid])
    const byId = new Map<string, string>(r.rows.map((row) => [row.id, row.predicate]))
    expect(byId.get(ids[0] as string)).toBe('role')
    expect(byId.get(ids[1] as string)).toBe('city')
  })

  it('omits factIds entirely when no facts are supplied', async () => {
    const written = await writeMemory(memoryInput(uid))
    expect(written.factIds).toBeUndefined()
    expect(await countFacts(uid)).toBe(0)

    // An explicitly empty list is the same no-op, not an empty-array result.
    const withEmpty = await writeMemory(memoryInput(uid), undefined, [])
    expect(withEmpty.factIds).toBeUndefined()
    expect(await countFacts(uid)).toBe(0)
  })

  it('rolls back the memory when a fact insert fails', async () => {
    // Injected failure AFTER the memory insert: valid_from > valid_to violates
    // facts_validity_check, so the facts INSERT raises inside the same tx.
    await expect(
      writeMemory(memoryInput(uid), undefined, [
        { subject: 'employee:42', predicate: 'role', value: 'engineer' },
        {
          subject: 'employee:42',
          predicate: 'city',
          value: 'berlin',
          validFrom: new Date('2026-01-02T00:00:00.000Z'),
          validTo: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]),
    ).rejects.toThrow()

    // Both halves are gone: no orphan memory, no partially applied facts. A
    // check violation must NOT surface as a duplicate-content conflict either.
    expect(await countMemories(uid)).toBe(0)
    expect(await countFacts(uid)).toBe(0)
  })

  it('writes facts for a commitment memory alongside its commitment row', async () => {
    // The commitment branch is an EARLY RETURN in writeMemory; facts must land
    // for both sides of it, and both ids must come back together.
    const written = await writeMemory(memoryInput(uid, 'commitment'), undefined, [
      { subject: 'invoice:2026-03', predicate: 'due.date', value: '2026-03-31' },
    ])

    expect(written.commitmentId).toBeDefined()
    expect(written.factIds).toHaveLength(1)
    expect(await countFacts(uid)).toBe(1)

    const r = await ownerPool.query('SELECT memory_id FROM commitments WHERE user_id = $1', [uid])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].memory_id).toBe(written.id)
  })

  it('binds facts to the writing tenant and hides them from another', async () => {
    await writeMemory(memoryInput(uid), undefined, [
      { subject: 'employee:42', predicate: 'role', value: 'engineer' },
    ])

    // RLS: the other tenant's runtime-role read sees nothing, and the row is
    // stamped with the writer's user_id (not merely invisible by filtering).
    expect(await readFacts(otherUid, { subject: 'employee:42' })).toEqual([])
    expect(await countFacts(otherUid)).toBe(0)
    expect(await countFacts(uid)).toBe(1)
  })
})
