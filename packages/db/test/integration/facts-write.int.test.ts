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
import { insertFacts } from '../../src/facts-write.js'
import { insertImportedFact } from '../../src/memory-import.js'
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

// ---------------------------------------------------------------------------
// Issue #369: a single-valued key keeps exactly one open value. Each open value
// of (subject, predicate) ends where the next one begins; `cardinality: 'many'`
// opts out; a row with its own validTo takes no part; import replays verbatim.
// ---------------------------------------------------------------------------

/** Owner-side read of one key's windows, oldest first, so assertions never trust the code under test. */
async function windows(userId: string, subject: string, predicate: string) {
  const r = await ownerPool.query(
    `SELECT value, valid_from, valid_to FROM facts
      WHERE user_id = $1 AND subject = $2 AND predicate = $3
      ORDER BY valid_from, created_at`,
    [userId, subject, predicate],
  )
  return r.rows.map((row) => ({
    value: row.value as string,
    from: (row.valid_from as Date).toISOString(),
    to: row.valid_to === null ? null : (row.valid_to as Date).toISOString(),
  }))
}

const fact = (value: string, extra: Record<string, unknown> = {}) => ({
  subject: 'project:alpha',
  predicate: 'status',
  value,
  ...extra,
})

describe('single-valued facts supersede (#369)', () => {
  it('a new value closes the old one at the new validFrom', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('open', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('closed', { validFrom: '2026-10-20T00:00:00Z' })].map(toWrite),
    )
    expect(await windows(uid, 'project:alpha', 'status')).toEqual([
      { value: 'open', from: '2026-10-01T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' },
      { value: 'closed', from: '2026-10-20T00:00:00.000Z', to: null },
    ])
    const current = await readFacts(uid, { subject: 'project:alpha', predicate: 'status' })
    expect(current.map((f) => f.value)).toEqual(['closed'])
  })

  it('a value written without validFrom closes the old one at the write instant', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('open', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(memoryInput(uid), undefined, [fact('closed')].map(toWrite))
    const [older, newer] = await windows(uid, 'project:alpha', 'status')
    expect(older?.to).not.toBeNull()
    expect(older?.to).toBe(newer?.from)
    expect(newer?.to).toBeNull()
  })

  it('a backdated value becomes history that ends where the newer value starts', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('closed', { validFrom: '2026-10-20T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('open', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    expect(await windows(uid, 'project:alpha', 'status')).toEqual([
      { value: 'open', from: '2026-10-01T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' },
      { value: 'closed', from: '2026-10-20T00:00:00.000Z', to: null },
    ])
  })

  it('a time series written in one call chains in order', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      // Out of order on purpose: applied as given, `a` would end at `c`.
      [
        fact('c', { validFrom: '2026-10-20T00:00:00Z' }),
        fact('a', { validFrom: '2026-10-01T00:00:00Z' }),
        fact('b', { validFrom: '2026-10-10T00:00:00Z' }),
      ].map(toWrite),
    )
    expect((await windows(uid, 'project:alpha', 'status')).map((w) => [w.value, w.to])).toEqual([
      ['a', '2026-10-10T00:00:00.000Z'],
      ['b', '2026-10-20T00:00:00.000Z'],
      ['c', null],
    ])
  })

  it('cardinality many keeps every value open; a later single-valued write closes them all', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [
        fact('red', { predicate: 'tag', cardinality: 'many', validFrom: '2026-10-01T00:00:00Z' }),
        fact('blue', { predicate: 'tag', cardinality: 'many', validFrom: '2026-10-02T00:00:00Z' }),
      ].map(toWrite),
    )
    expect((await windows(uid, 'project:alpha', 'tag')).map((w) => w.to)).toEqual([null, null])
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('green', { predicate: 'tag', validFrom: '2026-10-05T00:00:00Z' })].map(toWrite),
    )
    // Both close at the new value's start: a write never invents an end time
    // for one value from another row's start.
    expect((await windows(uid, 'project:alpha', 'tag')).map((w) => [w.value, w.to])).toEqual([
      ['red', '2026-10-05T00:00:00.000Z'],
      ['blue', '2026-10-05T00:00:00.000Z'],
      ['green', null],
    ])
  })

  it('two values without validFrom in one call: the last one wins, the first is an empty window', async () => {
    await writeMemory(memoryInput(uid), undefined, [fact('first'), fact('second')].map(toWrite))
    const rows = await windows(uid, 'project:alpha', 'status')
    const first = rows.find((w) => w.value === 'first')
    expect(first?.to).toBe(first?.from)
    const current = await readFacts(uid, { subject: 'project:alpha', predicate: 'status' })
    expect(current.map((f) => f.value)).toEqual(['second'])
  })

  it('closes at the exact microsecond the successor starts', async () => {
    // now() carries microseconds; a JS Date would truncate them and leave a gap.
    await writeMemory(memoryInput(uid), undefined, [fact('open')].map(toWrite))
    await writeMemory(memoryInput(uid), undefined, [fact('done')].map(toWrite))
    // Compared in SQL, at full precision.
    const exact = await ownerPool.query(
      `SELECT count(*)::int AS n FROM facts older JOIN facts newer
          ON newer.user_id = older.user_id AND newer.subject = older.subject
         AND newer.predicate = older.predicate AND newer.value = 'done'
       WHERE older.user_id = $1 AND older.value = 'open' AND older.valid_to = newer.valid_from`,
      [uid],
    )
    expect(exact.rows[0].n).toBe(1)
  })

  it('a series backdated below a newer open value chains without overlap', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('later', { validFrom: '2026-10-20T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(uid),
      undefined,
      [
        fact('a', { validFrom: '2026-10-01T00:00:00Z' }),
        fact('b', { validFrom: '2026-10-10T00:00:00Z' }),
      ].map(toWrite),
    )
    expect((await windows(uid, 'project:alpha', 'status')).map((w) => [w.value, w.to])).toEqual([
      ['a', '2026-10-10T00:00:00.000Z'],
      ['b', '2026-10-20T00:00:00.000Z'],
      ['later', null],
    ])
  })

  it('a same-instant tie in one call holds below a newer open value too', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('later', { validFrom: '2026-10-20T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(uid),
      undefined,
      [
        fact('x', { validFrom: '2026-10-05T00:00:00Z' }),
        fact('y', { validFrom: '2026-10-05T00:00:00Z' }),
      ].map(toWrite),
    )
    const at = await readFacts(uid, {
      subject: 'project:alpha',
      predicate: 'status',
      asOf: { validAt: new Date('2026-10-10T00:00:00Z') },
    })
    expect(at.map((f) => f.value)).toEqual(['y'])
  })

  it('a value at the same instant as an open one replaces it', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('open', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('opened', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    const current = await readFacts(uid, { subject: 'project:alpha', predicate: 'status' })
    expect(current.map((f) => f.value)).toEqual(['opened'])
  })

  it('a backdated value closes the older open value and ends at the newer one', async () => {
    // Two open values, as left by writes before #369 (import replays verbatim).
    const written = await writeMemory(memoryInput(uid), undefined, [])
    for (const [value, validFrom] of [
      ['a', '2026-10-01T00:00:00Z'],
      ['c', '2026-10-20T00:00:00Z'],
    ] as const) {
      await insertImportedFact({
        userId: uid,
        memoryId: written.id,
        ...toWrite(fact(value, { validFrom })),
      })
    }
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('b', { validFrom: '2026-10-10T00:00:00Z' })].map(toWrite),
    )
    expect((await windows(uid, 'project:alpha', 'status')).map((w) => [w.value, w.to])).toEqual([
      ['a', '2026-10-10T00:00:00.000Z'],
      ['b', '2026-10-20T00:00:00.000Z'],
      ['c', null],
    ])
  })

  it('concurrent writers of one key leave exactly one value open', async () => {
    // insertFacts directly, as fact-proposal apply calls it: writeMemory
    // serializes a tenant's writes on its own, which would hide the race. A
    // seed value makes the race deterministic without the key lock: every
    // writer blocks on the seed row, then misses the other writers' inserts.
    const parent = await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('seed', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withTenant(uid, (tx) =>
          insertFacts(tx, [{ ...toWrite(fact(`v${i}`)), userId: uid, memoryId: parent.id }]),
        ),
      ),
    )
    const open = (await windows(uid, 'project:alpha', 'status')).filter((w) => w.to === null)
    expect(open).toHaveLength(1)
  })

  it('a row with its own validTo is a closed interval and closes nothing', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('open', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('paused', { validFrom: '2026-09-01T00:00:00Z', validTo: '2026-09-15T00:00:00Z' })].map(
        toWrite,
      ),
    )
    const current = await readFacts(uid, { subject: 'project:alpha', predicate: 'status' })
    expect(current.map((f) => f.value)).toEqual(['open'])
    expect(
      (await windows(uid, 'project:alpha', 'status')).find((w) => w.value === 'paused')?.to,
    ).toBe('2026-09-15T00:00:00.000Z')
  })

  it('other keys and other tenants are untouched', async () => {
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('open', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(otherUid),
      undefined,
      [fact('open', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('x', { predicate: 'owner', validFrom: '2026-10-20T00:00:00Z' })].map(toWrite),
    )
    await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('done', { subject: 'project:beta', validFrom: '2026-10-20T00:00:00Z' })].map(toWrite),
    )
    expect((await windows(uid, 'project:alpha', 'status'))[0]?.to).toBeNull()
    expect((await windows(otherUid, 'project:alpha', 'status'))[0]?.to).toBeNull()
  })

  it('import replays windows verbatim and closes nothing', async () => {
    const written = await writeMemory(
      memoryInput(uid),
      undefined,
      [fact('open', { validFrom: '2026-10-01T00:00:00Z' })].map(toWrite),
    )
    await insertImportedFact({
      userId: uid,
      memoryId: written.id,
      ...toWrite(fact('closed', { validFrom: '2026-10-20T00:00:00Z' })),
    })
    expect((await windows(uid, 'project:alpha', 'status')).map((w) => w.to)).toEqual([null, null])
  })
})

/** Test literal -> MemoryFactWrite (Dates, as the core mapper produces). */
function toWrite(f: Record<string, unknown>) {
  return {
    subject: f.subject as string,
    predicate: f.predicate as string,
    value: f.value as string,
    validFrom: f.validFrom === undefined ? undefined : new Date(f.validFrom as string),
    validTo: f.validTo === undefined ? undefined : new Date(f.validTo as string),
    cardinality: f.cardinality as 'one' | 'many' | undefined,
  }
}
