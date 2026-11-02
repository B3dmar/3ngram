// SPDX-License-Identifier: Apache-2.0
// Integration: one forgetting-pass run through core against the real runtime
// role, with the fake judgment gateway. A judgment-opted-in tenant's stale
// memories and a conflicting pair are read, judged, and staged as retention
// proposals; usage is recorded; a second run finds nothing to judge again.
import { closeDb } from '@3ngram/db'
import { createFakeGateway, type DecideAnswer, FAKE_DECIDE_MODEL } from '@3ngram/llm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { FORGET_DECIDE_OPERATION } from '../../src/admin/forgetting-judgment.js'
import { runForgettingPass } from '../../src/admin/forgetting-pass.js'
import { setJudgmentPolicy } from '../../src/settings/judgment.js'

let userId: string
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date()
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString()

function embedding(axis: number): string {
  const vec = new Array(1536).fill(0)
  vec[axis] = 1
  return `[${vec.join(',')}]`
}

async function seed(type: string, axis: number, createdDaysAgo: number): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, scope, project,
                           embedding, created_at, recorded_at, valid_from, updated_at)
     VALUES ($1, $2, 'topic', 'content', md5(random()::text), 'work', '3ngram', $3::vector,
             $4::timestamptz, $4::timestamptz, $4::timestamptz, $4::timestamptz)
     RETURNING id`,
    [userId, type, embedding(axis), daysAgo(createdDaysAgo)],
  )
  return (r.rows[0] as { id: string }).id
}

const choice = (key: string, p: number): DecideAnswer => ({
  type: 'choice',
  choice: key,
  confidence: p,
  probabilities: { [key]: p },
})

beforeEach(async () => {
  await resetDomainTables()
  userId = await seedUser(`forgetting-core-${crypto.randomUUID()}@test.local`)
})
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('runForgettingPass (real database, fake judgment gateway)', () => {
  it('stages verdicts for an opted-in tenant, records usage, and does not re-judge', async () => {
    const older = await seed('decision', 1, 90)
    const newer = await seed('decision', 1, 60)
    const stale = await seed('fact', 2, 80)
    await seed('event', 3, 80) // never a candidate
    await setJudgmentPolicy(userId, 'on', 'user_api')
    const gateway = createFakeGateway({
      decisions: {
        [FORGET_DECIDE_OPERATION]: {
          p0: choice('supersede_older', 0.92),
          s0: choice('archive', 0.6),
        },
      },
    })

    const first = await runForgettingPass(userId, { gateway, now: NOW })
    expect(first).toEqual({
      items: 2,
      batches: 1,
      proposed: 1,
      dismissed: 1,
      skipped: 0,
      staged: 2,
    })
    const rows = await ownerPool.query(
      `SELECT memory_id, action, related_memory_id, status, model
         FROM retention_proposals WHERE user_id = $1 ORDER BY action`,
      [userId],
    )
    expect(rows.rows).toEqual([
      {
        memory_id: stale,
        action: 'archive',
        related_memory_id: null,
        status: 'dismissed',
        model: FAKE_DECIDE_MODEL,
      },
      {
        memory_id: older,
        action: 'supersede',
        related_memory_id: newer,
        status: 'proposed',
        model: FAKE_DECIDE_MODEL,
      },
    ])
    const usage = await ownerPool.query(
      `SELECT operation, model, cost_usd FROM llm_usage WHERE user_id = $1`,
      [userId],
    )
    expect(usage.rows).toEqual([
      { operation: FORGET_DECIDE_OPERATION, model: FAKE_DECIDE_MODEL, cost_usd: null },
    ])

    const second = await runForgettingPass(userId, { gateway, now: NOW })
    expect(second).toMatchObject({ items: 0, batches: 0 })
    expect(gateway.calls.decide).toHaveLength(1)
  })

  it('judges nothing for a tenant without the judgment opt-in', async () => {
    await seed('decision', 4, 90)
    const gateway = createFakeGateway()
    expect(await runForgettingPass(userId, { gateway, now: NOW })).toMatchObject({
      stopped: 'not-opted-in',
    })
    expect(gateway.calls.decide).toEqual([])
  })
})
