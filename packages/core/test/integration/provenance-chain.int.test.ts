// SPDX-License-Identifier: Apache-2.0
import { closeDb, getMemoriesProvenance, withTenant } from '@3ngram/db'
import { type MemoryProvenance, memoryProvenanceSchema } from '@3ngram/schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, resetDomainTables } from '../../../db/test/integration/helpers.js'
import { getMemoriesByIds } from '../../src/read/memory.js'
import { fixture, id, type Seed, seedFixture } from './provenance-fixture.js'

let a: Seed
let b: Seed
beforeAll(async () => {
  await resetDomainTables()
  const first = fixture.tenants[0],
    second = fixture.tenants[1]
  if (!first || !second) throw new Error('fixture requires two tenants')
  a = await seedFixture(first)
  b = await seedFixture(second)
})
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

function idsIn(value: unknown, ids = new Set<string>()): Set<string> {
  if (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    ids.add(value.toLowerCase())
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) idsIn(item, ids)
  return ids
}

describe('provenance synthetic chain slice (#432)', () => {
  it('scores exact recall/precision and zero foreign identities across all five sections', async () => {
    let expectedCount = 0,
      returnedCount = 0,
      matched = 0,
      foreign = 0
    const foreignIds = new Set(b.labels.values())
    for (const probe of fixture.probes) {
      const result = await getMemoriesByIds(a.userId, [id(a, probe.memory)], {
        include: ['provenance'],
      })
      expect(result.notFound).toEqual([])
      const chain = memoryProvenanceSchema.parse(result.memories[0]?.provenance)
      expect(chain.supersession.truncated, probe.memory).toBe(probe.lineageTruncated)
      for (const section of Object.keys(probe.expected) as (keyof MemoryProvenance)[]) {
        const expected = new Set(probe.expected[section].map((label) => id(a, label)))
        const actual = idsIn(chain[section])
        expectedCount += expected.size
        returnedCount += actual.size
        matched += [...actual].filter((value) => expected.has(value)).length
        foreign += [...actual].filter((value) => foreignIds.has(value)).length
        expect([...actual].sort(), `${probe.memory}.${section}`).toEqual([...expected].sort())
      }
    }
    const metrics = {
      provenance_chain_recall: matched / expectedCount,
      provenance_chain_precision: matched / returnedCount,
      provenance_foreign_ids: foreign,
    }
    expect(metrics).toEqual(fixture._meta.targets)
  })

  it('collapses foreign ids to notFound and proves the caller predicate independently of RLS', async () => {
    const foreign = id(b, 'fact')
    const own = id(a, 'fact')
    const normal = await getMemoriesByIds(a.userId, [own, foreign], { include: ['provenance'] })
    expect(normal.notFound).toEqual([foreign])
    expect(normal.memories.map((m) => m.id)).toEqual([own])
    const exposed = await withTenant(b.userId, (tx) =>
      getMemoriesProvenance(tx, a.userId, [foreign]),
    )
    expect(exposed.size).toBe(0)
    expect(
      (await withTenant(b.userId, (tx) => getMemoriesProvenance(tx, b.userId, [foreign]))).size,
    ).toBe(1)
  })
})
