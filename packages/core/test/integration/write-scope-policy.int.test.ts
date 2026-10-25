// SPDX-License-Identifier: Apache-2.0
// Integration — the write-scope policy (issue #235) end to end through core
// against the real runtime role (app_user, NOBYPASSRLS):
//
//   configure (setWriteDefault) -> remember without scope -> where it landed
//
// Pins what a mocked-db unit test cannot: the policy row is read under the
// caller's tenant, a `require` rejection writes no row and spends nothing (it
// lands before the budget gate and the embed), one tenant's policy never
// affects another's writes, and the product path from #322: a memory written
// under a `default` policy is listed by that scope's briefing.
//
// Policy rows are not in resetDomainTables(), so each test seeds fresh users.
import { closeDb } from '@3ngram/db'
import { createFakeGateway } from '@3ngram/llm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { describeEnvironment } from '../../src/admin/environment.js'
import type { BudgetEnforcement } from '../../src/budget/index.js'
import { briefing } from '../../src/read/briefing.js'
import {
  createScope,
  deleteScope,
  renameScope,
  ScopeNotFoundError,
} from '../../src/scope/scopes.js'
import { setWriteDefault, UnscopedWriteError } from '../../src/scope/write-policy.js'
import { remember } from '../../src/write/remember.js'

const ACTOR = 'user_mcp' as const
const NOW = new Date('2026-10-25T12:00:00.000Z')
// Any metered op is over a zero cap: if the budget gate ran first, the error
// would be BudgetExceededError instead of the policy rejection.
const overCapBudget: BudgetEnforcement = {
  resolveLimits: async () => ({}),
  config: { defaultCapUsd: 0, defaultWindowDays: 30 },
}

let userA: string
let userB: string

const input = (content: string) => ({ memoryType: 'decision', topic: 'filing', content })
const scopesOf = async (userId: string) =>
  (
    await ownerPool.query('SELECT scope FROM memories WHERE user_id = $1 ORDER BY recorded_at', [
      userId,
    ])
  ).rows.map((r: { scope: string }) => r.scope)
const usageRows = async (userId: string) =>
  (await ownerPool.query('SELECT id FROM llm_usage WHERE user_id = $1', [userId])).rowCount

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`write-policy-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`write-policy-b-${crypto.randomUUID()}@test.local`)
})
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('write-scope policy through remember (runtime role)', () => {
  it("off (no policy row) keeps the shipped 'personal' literal", async () => {
    const written = await remember(userA, input('lands in personal'), ACTOR)
    expect(written.scope).toBe('personal')
    expect(await scopesOf(userA)).toEqual(['personal'])
    expect((await describeEnvironment(userA)).writeScopePolicy).toEqual({
      mode: 'off',
      scope: null,
    })
  })

  it('default fills an omitted scope, and that scope’s briefing lists the memory (#322)', async () => {
    await createScope(userA, 'work', [])
    await setWriteDefault(userA, { mode: 'default', scope: 'work' })

    // A commitment: briefing always carries the commitments section.
    const written = await remember(
      userA,
      { memoryType: 'commitment', topic: 'filing', content: 'lands in work by policy' },
      ACTOR,
    )

    expect(written.scope).toBe('work')
    expect(await scopesOf(userA)).toEqual(['work'])
    const work = await briefing(userA, {
      selector: { kind: 'scope', scope: 'work' },
      mode: 'full',
      now: NOW,
    })
    expect(work.commitments.items.map((c) => c.memoryId)).toContain(written.id)
    const personal = await briefing(userA, {
      selector: { kind: 'scope', scope: 'personal' },
      mode: 'full',
      now: NOW,
    })
    expect(personal.commitments.items.map((c) => c.memoryId)).not.toContain(written.id)
    expect((await describeEnvironment(userA)).writeScopePolicy).toEqual({
      mode: 'default',
      scope: 'work',
    })
  })

  it('an explicit scope wins over default and require', async () => {
    await createScope(userA, 'work', [])
    await setWriteDefault(userA, { mode: 'default', scope: 'work' })
    await remember(userA, { ...input('explicit under default'), scope: 'personal' }, ACTOR)
    await setWriteDefault(userA, { mode: 'require', scope: null })
    await remember(userA, { ...input('explicit under require'), scope: 'client-x' }, ACTOR)
    expect(await scopesOf(userA)).toEqual(['personal', 'client-x'])
  })

  it('require rejects an omitted scope before the budget gate: no row, no embed, no usage', async () => {
    await setWriteDefault(userA, { mode: 'require', scope: null })
    const gateway = createFakeGateway()

    await expect(
      remember(userA, input('must not land'), ACTOR, { gateway, budget: overCapBudget }),
    ).rejects.toBeInstanceOf(UnscopedWriteError)

    expect(await scopesOf(userA)).toEqual([])
    expect(gateway.calls.embed).toHaveLength(0)
    expect(await usageRows(userA)).toBe(0)
    const events = await ownerPool.query('SELECT id FROM memory_events WHERE user_id = $1', [userA])
    expect(events.rowCount).toBe(0)
  })

  it("one tenant's policy never affects another tenant's writes", async () => {
    await createScope(userA, 'work', [])
    await setWriteDefault(userA, { mode: 'default', scope: 'work' })
    expect((await remember(userB, input('b unscoped, a default'), ACTOR)).scope).toBe('personal')

    await setWriteDefault(userA, { mode: 'require', scope: null })
    expect((await remember(userB, input('b unscoped, a require'), ACTOR)).scope).toBe('personal')
    expect(await scopesOf(userB)).toEqual(['personal', 'personal'])
    expect(await scopesOf(userA)).toEqual([])
    expect((await describeEnvironment(userB)).writeScopePolicy).toEqual({
      mode: 'off',
      scope: null,
    })
  })

  it("a scope registered only by another tenant cannot become this tenant's default", async () => {
    await createScope(userA, 'shared-name', [])
    await expect(
      setWriteDefault(userB, { mode: 'default', scope: 'shared-name' }),
    ).rejects.toBeInstanceOf(ScopeNotFoundError)
    expect((await describeEnvironment(userB)).writeScopePolicy).toEqual({
      mode: 'off',
      scope: null,
    })
  })

  it('an alias is rejected as not found: set_write_default takes the canonical name', async () => {
    await createScope(userA, 'work', ['job'])
    await expect(setWriteDefault(userA, { mode: 'default', scope: 'job' })).rejects.toBeInstanceOf(
      ScopeNotFoundError,
    )
    expect((await describeEnvironment(userA)).writeScopePolicy).toEqual({
      mode: 'off',
      scope: null,
    })
  })

  it('a registry rename carries the write default; a delete fails it closed to require', async () => {
    await createScope(userA, 'work', [])
    await setWriteDefault(userA, { mode: 'default', scope: 'work' })

    await renameScope(userA, 'work', 'job')
    expect((await describeEnvironment(userA)).writeScopePolicy).toEqual({
      mode: 'default',
      scope: 'job',
    })
    expect((await remember(userA, input('after rename'), ACTOR)).scope).toBe('job')

    await deleteScope(userA, 'job')
    expect((await describeEnvironment(userA)).writeScopePolicy).toEqual({
      mode: 'require',
      scope: null,
    })
    await expect(remember(userA, input('after delete'), ACTOR)).rejects.toBeInstanceOf(
      UnscopedWriteError,
    )
  })
})
