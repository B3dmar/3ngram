// SPDX-License-Identifier: Apache-2.0
// Unit tests for the facts write helpers — no database, no withTenant.
//
// Two things are worth isolating from the integration suite
// (facts-write.int.test.ts, which covers the real runtime-role behavior):
// the empty-input short-circuit (it must not reach the transaction at all),
// and the schema-shape premise that lets writeMemory keep ONE
// unique-violation -> DuplicateMemoryError mapping at its transaction boundary.
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { insertFacts } from '../src/facts-write.js'
import { facts } from '../src/schema/memory.js'

/** A transaction that fails the test if any statement is issued against it. */
const unusableTx = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`insertFacts touched the transaction: .${String(property)}`)
    },
  },
) as never

describe('insertFacts', () => {
  it('short-circuits on empty input without touching the transaction', async () => {
    // The fresh-write path calls insertFacts unconditionally, so a memory
    // carrying no facts must cost exactly zero statements (and drizzle rejects
    // an empty VALUES list outright).
    await expect(insertFacts(unusableTx, [])).resolves.toEqual([])
  })
})

describe('facts table shape (writeMemory duplicate-mapping premise)', () => {
  it('carries no caller-collidable uniqueness', () => {
    // writeMemory maps ANY unique violation in its transaction to
    // DuplicateMemoryError. That is only correct while the memories partial
    // hash index is the sole source of one. Bi-temporal history keeps every
    // assertion, so facts declares no unique index and no unique constraint —
    // if that ever changes, this test fails and the mapping must be scoped to
    // the memories insert (the insertEdge precedent) before uniqueness ships.
    //
    // The row's uuidv7 primary key is the one unique object on the table, and
    // it is excluded from the premise on purpose: the writer never supplies an
    // id, so no caller input can collide on it.
    const config = getTableConfig(facts)
    expect(config.indexes.filter((index) => index.config.unique)).toEqual([])
    expect(config.uniqueConstraints).toEqual([])
    expect(facts.id.hasDefault).toBe(true)
  })
})
