// SPDX-License-Identifier: Apache-2.0
// Integration — pre-persist budget gate against the
// real runtime role (app_user, NOBYPASSRLS) on the CI ephemeral Neon branch.
// Proves the invariant a mocked-db unit test cannot: an over-cap write/import is
// rejected BEFORE the persistence transaction, so ZERO rows are written and no
// gateway spend is incurred. Under cap, the row lands.
//
// Cap mechanics: NoOpGate resolves tier 'selfhost' (no plan_tiers row), so the
// effective cap falls through to config.defaultCapUsd. A cap of 0 makes any op
// over (consumed 0 + the embed estimate > 0); a large cap is comfortably under.
//
// Reuses packages/db integration infra (helpers.ts).
import { closeDb } from '@3ngram/db'
import { createFakeGateway } from '@3ngram/llm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { type BudgetEnforcement, BudgetExceededError } from '../../src/budget/index.js'
import { importMemory } from '../../src/import/index.js'
import { remember } from '../../src/write/remember.js'

let userId: string

const overCapBudget: BudgetEnforcement = {
  resolveLimits: async () => ({}),
  config: { defaultCapUsd: 0, defaultWindowDays: 30 },
}
const underCapBudget: BudgetEnforcement = {
  resolveLimits: async () => ({}),
  config: { defaultCapUsd: 1000, defaultWindowDays: 30 },
}

const input = () => ({ memoryType: 'note', topic: 'budget', content: 'budget gate content' })
const countRows = async () =>
  (await ownerPool.query('SELECT id FROM memories WHERE user_id = $1', [userId])).rowCount

beforeAll(async () => {
  userId = await seedUser('budget-gate@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('pre-persist budget gate (US2, SC-003)', () => {
  it('rejects an over-cap remember BEFORE persistence — zero rows, no spend', async () => {
    const gateway = createFakeGateway()
    await expect(
      remember(userId, input(), 'user_api', { gateway, budget: overCapBudget }),
    ).rejects.toBeInstanceOf(BudgetExceededError)
    expect(await countRows()).toBe(0)
    expect(gateway.calls.embed).toHaveLength(0)
  })

  it('rejects an over-cap import BEFORE persistence — zero rows, no spend', async () => {
    const gateway = createFakeGateway()
    await expect(
      importMemory(userId, input(), { gateway, budget: overCapBudget }),
    ).rejects.toBeInstanceOf(BudgetExceededError)
    expect(await countRows()).toBe(0)
    expect(gateway.calls.embed).toHaveLength(0)
  })

  it('allows an under-cap remember and persists exactly one row', async () => {
    const gateway = createFakeGateway()
    const { id, embed } = await remember(userId, input(), 'user_api', {
      gateway,
      budget: underCapBudget,
    })
    await embed.settled
    const rows = await ownerPool.query('SELECT id FROM memories WHERE id = $1', [id])
    expect(rows.rowCount).toBe(1)
  })
})
