// SPDX-License-Identifier: Apache-2.0
// Integration — first-account provisioning against the real
// runtime role (app_user, NOBYPASSRLS) on the CI ephemeral Neon branch. Proves
// the non-empty first recall, which unit tests (mocked db) cannot:
//   - a verified account gets the default scopes registered under its tenant
//   - exactly one welcome memory is seeded via the append write path (RLS + event)
//   - a tenant search returns the welcome memory, and ONLY to its owner (isolation)
//   - a re-seed (the deferred dashboard re-attempt) is idempotent
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
import { getOnboardingStatus } from '../../src/auth/onboarding.js'
import { provisionVerifiedAccount, WELCOME_MEMORY } from '../../src/auth/provisioning.js'
import { search } from '../../src/read/search.js'
import { listScopes } from '../../src/scope/scopes.js'
import { remember } from '../../src/write/remember.js'
import { revise } from '../../src/write/revise.js'
import { reviseDisposition } from '../../src/write/revise-disposition.js'

let userA: string
let userB: string
const gateway = createFakeGateway()

beforeAll(async () => {
  userA = await seedUser('provision-a@test.local')
  userB = await seedUser('provision-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('provisionVerifiedAccount (runtime role, real withTenant)', () => {
  it('excludes a delayed seed but counts user-authored welcome lookalikes and other system notes', async () => {
    expect((await getOnboardingStatus(userA)).userMemoryCount).toBe(0)
    await provisionVerifiedAccount(userA)
    expect((await getOnboardingStatus(userA)).userMemoryCount).toBe(0)
    await remember(userA, { ...WELCOME_MEMORY, content: 'My own welcome note' }, 'user_mcp')
    await remember(userA, { ...WELCOME_MEMORY, content: 'A different system note' }, 'system')
    expect((await getOnboardingStatus(userA)).userMemoryCount).toBe(2)
    expect((await getOnboardingStatus(userB)).userMemoryCount).toBe(0)
    await remember(userB, WELCOME_MEMORY, 'user_mcp')
    expect((await getOnboardingStatus(userB)).userMemoryCount).toBe(1)
  })

  it('counts a revised welcome as user work and ignores archived or superseded versions', async () => {
    await provisionVerifiedAccount(userA)
    const { rows } = await ownerPool.query('SELECT id FROM memories WHERE user_id = $1', [userA])
    const result = await revise(
      userA,
      {
        ...WELCOME_MEMORY,
        predecessorId: rows[0].id,
        content: 'My edited welcome memory',
        edgeIntent: 'supersedes',
      },
      'user_mcp',
    )
    expect((await getOnboardingStatus(userA)).userMemoryCount).toBe(1)
    await reviseDisposition(userA, { kind: 'archive', memoryIds: [result.id] }, 'user_mcp')
    expect((await getOnboardingStatus(userA)).userMemoryCount).toBe(0)
  })

  it('registers the default scopes and seeds one welcome memory under the tenant', async () => {
    await provisionVerifiedAccount(userA, { gateway })

    const scopes = await listScopes(userA)
    expect(scopes.map((s) => s.name).sort()).toEqual(['personal', 'work'])

    const rows = await ownerPool.query(
      'SELECT topic, scope, memory_type, status FROM memories WHERE user_id = $1',
      [userA],
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].topic).toBe('Welcome to 3ngram')
    expect(rows.rows[0].scope).toBe('personal')
    expect(rows.rows[0].memory_type).toBe('note')
    expect(rows.rows[0].status).toBe('active')
  })

  it('returns the welcome memory on a tenant search, and only to its owner', async () => {
    await provisionVerifiedAccount(userA, { gateway })

    const hits = await search(userA, 'welcome', { gateway })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.some((h) => h.topic === 'Welcome to 3ngram')).toBe(true)

    // Tenant isolation: userB provisioned nothing, so its search never sees A's seed.
    const otherHits = await search(userB, 'welcome', { gateway })
    expect(otherHits).toHaveLength(0)
  })

  it('reports an archived seed as existing without recreating or restoring it', async () => {
    expect(await provisionVerifiedAccount(userA)).toBe('created')
    await ownerPool.query("UPDATE memories SET status = 'archived' WHERE user_id = $1", [userA])
    expect(await provisionVerifiedAccount(userA)).toBe('already_exists')
    const rows = await ownerPool.query('SELECT status FROM memories WHERE user_id = $1', [userA])
    expect(rows.rows).toEqual([{ status: 'archived' }])
    expect((await getOnboardingStatus(userA)).userMemoryCount).toBe(0)
  })

  it('is idempotent — a deferred re-seed (T019) duplicates neither scopes nor memory', async () => {
    await provisionVerifiedAccount(userA, { gateway })
    await provisionVerifiedAccount(userA, { gateway })

    expect(await listScopes(userA)).toHaveLength(2)
    const rows = await ownerPool.query(
      'SELECT count(*)::int AS n FROM memories WHERE user_id = $1',
      [userA],
    )
    expect(rows.rows[0].n).toBe(1)
  })

  it('charges the welcome memory as live while keeping an at-cap re-seed idempotent', async () => {
    const limits = async () => ({ maxLiveMemories: 1 })
    await provisionVerifiedAccount(userA, { limits })
    await expect(provisionVerifiedAccount(userA, { limits })).resolves.toBe('already_exists')

    await expect(
      remember(
        userA,
        { memoryType: 'note', topic: 'second', content: 'a second live memory' },
        'system',
        { limits },
      ),
    ).rejects.toMatchObject({ resource: 'live_memories' })
  })
})
