// SPDX-License-Identifier: Apache-2.0
// Integration — the SHARED embed seam caps EVERY metered embed (no ungated
// embed path). Against the real runtime role on the CI
// ephemeral Neon branch. Proves the budget gate fires at both seams:
//   - read path: search()'s query embed (embedQuery) is blocked over cap;
//   - write-embed seam: the kickEmbed seam blocks the repair path (retryFailedEmbeds)
//     — the only embed path with no pre-persist guard of its own.
// In both cases the gateway round-trip never happens (no spend), proven via the
// fake gateway's call log.
//
// Reuses packages/db integration infra (helpers.ts).
import { closeDb, recordEmbedFailure, releaseReservation, reserveBudget } from '@3ngram/db'
import { createFakeGateway, maxCostUsdForOperation } from '@3ngram/llm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { type BudgetEnforcement, BudgetExceededError } from '../../src/budget/index.js'
import { search } from '../../src/read/search.js'
import { remember } from '../../src/write/remember.js'
import { retryFailedEmbeds } from '../../src/write/repair.js'

let userId: string

const overCapBudget: BudgetEnforcement = {
  resolveLimits: async () => ({}),
  config: { defaultCapUsd: 0, defaultWindowDays: 30 },
}
const underCapBudget: BudgetEnforcement = {
  resolveLimits: async () => ({}),
  config: { defaultCapUsd: 1000, defaultWindowDays: 30 },
}

beforeAll(async () => {
  userId = await seedUser('budget-search@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('budget seam caps every metered embed (US2, FR-005)', () => {
  it('blocks the read-path query embed over cap — search rejects, no gateway call', async () => {
    const gateway = createFakeGateway()
    await expect(
      search(userId, 'release process', { gateway }, { budget: overCapBudget }),
    ).rejects.toBeInstanceOf(BudgetExceededError)
    expect(gateway.calls.embed).toHaveLength(0)
  })

  it('allows the read-path query embed under cap — search runs, one gateway call', async () => {
    const gateway = createFakeGateway()
    const hits = await search(userId, 'release process', { gateway }, { budget: underCapBudget })
    expect(gateway.calls.embed).toHaveLength(1)
    expect(Array.isArray(hits)).toBe(true)
  })

  it('blocks the write-embed seam (repair) over cap — kickEmbed skips the gateway', async () => {
    // Land a memory WITHOUT a gateway (embedding stays NULL) and mark it
    // embed_failed, so retryFailedEmbeds is the only thing that would embed it —
    // exercising the kickEmbed seam, which has no pre-persist guard of its own.
    const { id } = await remember(
      userId,
      { memoryType: 'note', topic: 'repair', content: 'repair candidate' },
      'user_api',
    )
    await recordEmbedFailure(userId, id, 'system', 'seed_failure')

    const gateway = createFakeGateway()
    const result = await retryFailedEmbeds(userId, { gateway, budget: overCapBudget })

    // The seam rejected before the gateway round-trip: no spend, nothing landed.
    expect(gateway.calls.embed).toHaveLength(0)
    expect(result.landed).toBe(0)
    const row = await ownerPool.query('SELECT embedding FROM memories WHERE id = $1', [id])
    expect(row.rows[0]?.embedding).toBeNull()
  })

  it('an in-flight reservation blocks a concurrent metered op (P1 — no overshoot)', async () => {
    // Deterministic proof that the atomic reservation closes the TOCTOU race
    // without a flaky timing test: a budget that fits exactly ONE op, already
    // consumed by a live reservation (as a concurrent request would hold), must
    // reject the next op — the reservation counts toward the gate, so two
    // requests cannot both pass and overshoot the 100% ceiling.
    const oneOp = maxCostUsdForOperation('search')
    const tight = {
      resolveLimits: async () => ({}),
      config: { defaultCapUsd: oneOp, defaultWindowDays: 30 },
    }

    const held = await reserveBudget(userId, 'selfhost', 30, oneOp, oneOp, oneOp)
    expect(held.allowed).toBe(true)
    try {
      const gateway = createFakeGateway()
      await expect(
        search(userId, 'release process', { gateway }, { budget: tight }),
      ).rejects.toBeInstanceOf(BudgetExceededError)
      expect(gateway.calls.embed).toHaveLength(0)
    } finally {
      if (held.reservationId) await releaseReservation(userId, held.reservationId)
    }
  })

  it('allows the write-embed seam (repair) under cap — kickEmbed reaches the gateway', async () => {
    const { id } = await remember(
      userId,
      { memoryType: 'note', topic: 'repair', content: 'repair candidate ok' },
      'user_api',
    )
    await recordEmbedFailure(userId, id, 'system', 'seed_failure')

    const gateway = createFakeGateway()
    const result = await retryFailedEmbeds(userId, { gateway, budget: underCapBudget })

    expect(gateway.calls.embed).toHaveLength(1)
    expect(result.landed).toBe(1)
  })
})
