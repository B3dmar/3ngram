// SPDX-License-Identifier: Apache-2.0
// Retention-proposal store (the forgetting pass, docs/concepts/forgetting-pass.mdx)
// through the RUNTIME role via withTenant(), the production path (FORCE RLS).
//
// Covers: staging round-trip (proposed verdicts and dismissed keeps); one OPEN
// proposal per memory and action; staging only while every named memory is
// live; the action, pairing and probability CHECKs; tenant isolation, a
// fail-closed read with no tenant bound, and no DELETE grant; FORCE; the export;
// account erasure leaving the rows alone (they hold no user text).
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eraseAccountData } from '../../src/account-delete.js'
import { withTenant } from '../../src/client.js'
import { readUserDataExport } from '../../src/data-export.js'
import {
  insertRetentionProposals,
  type RetentionVerdictWrite,
} from '../../src/retention-proposals.js'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
  withTestTransaction,
} from './helpers.js'

let userA: string
let userB: string

/** A live decision memory (owner pool fixture setup). */
async function seedMemory(userId: string): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, content, memory_type, topic, scope, content_hash)
     VALUES ($1, 'fixture decision', 'decision', 'fixture', 'work', md5(random()::text))
     RETURNING id`,
    [userId],
  )
  return (r.rows[0] as { id: string }).id
}

const verdict = (
  memoryId: string,
  extra: Partial<RetentionVerdictWrite> = {},
): RetentionVerdictWrite => ({
  memoryId,
  action: 'archive',
  probability: 0.9,
  probabilities: { keep: 0.1, archive: 0.9 },
  model: 'jev-test',
  ...extra,
})

const stage = (userId: string, verdicts: RetentionVerdictWrite[]) =>
  withTenant(userId, (tx) => insertRetentionProposals(tx, userId, verdicts))

/** Owner-side read, so assertions never trust the code under test. */
async function rowsOf(userId: string) {
  const r = await ownerPool.query(
    `SELECT memory_id, action, related_memory_id, probability, probabilities, model, status, decided_at
       FROM retention_proposals WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  )
  return r.rows
}

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`retention-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`retention-b-${crypto.randomUUID()}@test.local`)
})

afterAll(async () => {
  await resetDomainTables()
  await closePools()
})

describe('retention proposal store (runtime role, withTenant)', () => {
  it('stages a proposed verdict and a dismissed keep, with every column intact', async () => {
    const older = await seedMemory(userA)
    const newer = await seedMemory(userA)
    const kept = await seedMemory(userA)
    const probabilities = { keep: 0.05, archive: 0.03, 'supersede_by:s0n0': 0.92 }
    expect(
      await stage(userA, [
        verdict(older, {
          action: 'supersede',
          relatedMemoryId: newer,
          probability: 0.92,
          probabilities,
        }),
        verdict(kept, { action: 'keep', probability: 0.8, probabilities: { keep: 0.8 } }),
      ]),
    ).toBe(2)
    expect(await rowsOf(userA)).toEqual([
      {
        memory_id: older,
        action: 'supersede',
        related_memory_id: newer,
        probability: 0.92,
        probabilities,
        model: 'jev-test',
        status: 'proposed',
        decided_at: null,
      },
      {
        memory_id: kept,
        action: 'keep',
        related_memory_id: null,
        probability: 0.8,
        probabilities: { keep: 0.8 },
        model: 'jev-test',
        status: 'dismissed',
        decided_at: null,
      },
    ])
  })

  it('keeps one OPEN proposal per memory and action, and re-proposes after a decision', async () => {
    const memoryId = await seedMemory(userA)
    const other = await seedMemory(userA)
    // A duplicate in one call and a repeat in a later call are both no-ops.
    expect(await stage(userA, [verdict(memoryId), verdict(memoryId)])).toBe(1)
    expect(await stage(userA, [verdict(memoryId)])).toBe(0)
    // Another action on the same memory is its own open proposal.
    expect(
      await stage(userA, [verdict(memoryId, { action: 'conflict', relatedMemoryId: other })]),
    ).toBe(1)
    // Once a reviewer decides, the pass may propose the same action again.
    await withTestTransaction(async (conn) => {
      await conn.query(`SELECT set_config('app.user_id', $1, true)`, [userA])
      await conn.query(
        `UPDATE retention_proposals SET status = 'rejected', decided_at = now()
          WHERE memory_id = $1 AND action = 'archive'`,
        [memoryId],
      )
      await conn.query('COMMIT')
    })
    expect(await stage(userA, [verdict(memoryId)])).toBe(1)
  })

  it('stages only while every named memory is live', async () => {
    const superseded = await seedMemory(userA)
    const archived = await seedMemory(userA)
    const live = await seedMemory(userA)
    await ownerPool.query(
      `UPDATE memories SET valid_from = now() - interval '1 day', valid_to = now() WHERE id = $1`,
      [superseded],
    )
    await ownerPool.query(`UPDATE memories SET status = 'archived' WHERE id = $1`, [archived])
    expect(
      await stage(userA, [
        verdict(superseded),
        verdict(archived),
        verdict(live, { action: 'supersede', relatedMemoryId: superseded }),
        verdict(live, { action: 'conflict', relatedMemoryId: archived }),
      ]),
    ).toBe(0)
    expect(await rowsOf(userA)).toEqual([])
  })

  it('locks the named memories until the staging transaction ends', async () => {
    const memoryId = await seedMemory(userA)
    const other = await seedMemory(userA)
    await withTenant(userA, async (tx) => {
      await insertRetentionProposals(tx, userA, [
        verdict(memoryId, { action: 'conflict', relatedMemoryId: other }),
      ])
      // A concurrent archive of either memory waits for this transaction.
      const conn = await ownerPool.connect()
      try {
        await conn.query(`SET lock_timeout = '300ms'`)
        for (const id of [memoryId, other]) {
          await expect(
            conn.query(`UPDATE memories SET status = 'archived' WHERE id = $1`, [id]),
          ).rejects.toThrow(/lock timeout/)
        }
      } finally {
        await conn.query('RESET lock_timeout')
        conn.release()
      }
    })
  })

  it('the DB CHECKs reject a bad probability, action or related-memory pairing', async () => {
    const memoryId = await seedMemory(userA)
    const other = await seedMemory(userA)
    for (const bad of [
      verdict(memoryId, { probability: 1.2 }),
      verdict(memoryId, { action: 'supersede' }),
      verdict(memoryId, { action: 'archive', relatedMemoryId: other }),
      verdict(memoryId, { action: 'supersede', relatedMemoryId: memoryId }),
      verdict(memoryId, { action: 'forget' as never }),
    ]) {
      await expect(stage(userA, [bad])).rejects.toThrow()
    }
    expect(await rowsOf(userA)).toEqual([])
  })

  it('refuses a probabilities key that is not an action name or item ref', async () => {
    const memoryId = await seedMemory(userA)
    const leaky = verdict(memoryId, { probabilities: { 'the user moved to Berlin': 0.9 } })
    await expect(stage(userA, [leaky])).rejects.toThrow(
      'insertRetentionProposals: a probabilities key is not an action name or item ref',
    )
    expect(await rowsOf(userA)).toEqual([])
  })

  it('never stages over another tenant’s memory, and the composite FK refuses one', async () => {
    const own = await seedMemory(userA)
    const foreign = await seedMemory(userB)
    expect(
      await stage(userA, [
        verdict(foreign),
        verdict(own, { action: 'conflict', relatedMemoryId: foreign }),
      ]),
    ).toBe(0)
    await expect(
      withTestTransaction(async (conn) => {
        await conn.query(`SELECT set_config('app.user_id', $1, true)`, [userA])
        await conn.query(
          `INSERT INTO retention_proposals
             (user_id, memory_id, action, related_memory_id, probability, probabilities, model)
           VALUES ($1, $2, 'conflict', $3, 0.7, '{}'::jsonb, 'jev-test')`,
          [userA, own, foreign],
        )
      }),
    ).rejects.toThrow()
  })

  it('isolates tenants, fails closed with no tenant bound, and grants no DELETE', async () => {
    const memoryId = await seedMemory(userA)
    await stage(userA, [verdict(memoryId)])
    await withTestTransaction(async (conn) => {
      await conn.query(`SELECT set_config('app.user_id', $1, true)`, [userB])
      expect((await conn.query('SELECT * FROM retention_proposals')).rowCount).toBe(0)
      const updated = await conn.query(`UPDATE retention_proposals SET status = 'applied'`)
      expect(updated.rowCount).toBe(0)
    })
    await withTestTransaction(async (conn) => {
      expect((await conn.query('SELECT * FROM retention_proposals')).rowCount).toBe(0)
    })
    await expect(
      withTestTransaction(async (conn) => {
        await conn.query(`SELECT set_config('app.user_id', $1, true)`, [userA])
        await conn.query('DELETE FROM retention_proposals')
      }),
    ).rejects.toThrow(/permission denied/)
    expect((await rowsOf(userA)).map((r) => r.status)).toEqual(['proposed'])
  })

  it('FORCEs RLS on the table', async () => {
    const r = await ownerPool.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'retention_proposals'`,
    )
    expect(r.rows[0]?.relforcerowsecurity).toBe(true)
  })
})

describe('retention proposals in the export and account erasure', () => {
  it('exports the tenant’s own verdicts only', async () => {
    const memoryId = await seedMemory(userA)
    await stage(userA, [verdict(memoryId)])
    await stage(userB, [verdict(await seedMemory(userB))])
    const exported = await withTenant(userA, (tx) => readUserDataExport(tx, userA))
    expect(exported?.retentionProposals).toEqual([
      expect.objectContaining({
        memoryId,
        action: 'archive',
        relatedMemoryId: null,
        probability: 0.9,
        probabilities: { keep: 0.1, archive: 0.9 },
        model: 'jev-test',
        status: 'proposed',
      }),
    ])
  })

  it('leaves verdict rows untouched on erasure: they carry no user text', async () => {
    const memoryId = await seedMemory(userA)
    await stage(userA, [verdict(memoryId)])
    const before = await rowsOf(userA)
    await withTenant(userA, (tx) => eraseAccountData(tx, userA, new Date()))
    expect(await rowsOf(userA)).toEqual(before)
  })
})
