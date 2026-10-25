// SPDX-License-Identifier: Apache-2.0
// Integration — the judgment opt-in (issue #225) through core against the real
// runtime role: no row reads off, a set is isolated to its tenant, and every set
// appends a content-free consent record to audit_log. isJudgmentEnabled is what
// the session closer's production repo delegates to (issue #229).
import { closeDb } from '@3ngram/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { dbSessionCloserRepo } from '../../src/admin/session-closer.js'
import {
  getJudgmentPolicy,
  isJudgmentEnabled,
  JUDGMENT_POLICY_AUDIT_ACTION,
  setJudgmentPolicy,
} from '../../src/settings/judgment.js'

let userA: string
let userB: string

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`judgment-core-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`judgment-core-b-${crypto.randomUUID()}@test.local`)
})

afterAll(async () => {
  await closeDb()
  await closePools()
})

describe('judgment opt-in through core (runtime role)', () => {
  it('reads off with no row, for the closer repo too', async () => {
    expect(await getJudgmentPolicy(userA)).toEqual({ mode: 'off', updatedAt: null })
    expect(await isJudgmentEnabled(userA)).toBe(false)
    expect(await dbSessionCloserRepo.isJudgmentEnabled(userA)).toBe(false)
  })

  it('opts in one tenant only and records each change', async () => {
    await setJudgmentPolicy(userA, 'on', 'user_api')
    expect(await isJudgmentEnabled(userA)).toBe(true)
    expect(await dbSessionCloserRepo.isJudgmentEnabled(userA)).toBe(true)
    expect(await isJudgmentEnabled(userB)).toBe(false)

    await setJudgmentPolicy(userA, 'off', 'user_api')
    expect(await isJudgmentEnabled(userA)).toBe(false)

    const audit = await ownerPool.query(
      `SELECT actor_kind, resource, metadata FROM audit_log
       WHERE user_id = $1 AND action = $2 ORDER BY created_at, id`,
      [userA, JUDGMENT_POLICY_AUDIT_ACTION],
    )
    expect(audit.rows).toEqual([
      { actor_kind: 'user_api', resource: 'user_judgment_policy', metadata: { mode: 'on' } },
      { actor_kind: 'user_api', resource: 'user_judgment_policy', metadata: { mode: 'off' } },
    ])
  })
})
