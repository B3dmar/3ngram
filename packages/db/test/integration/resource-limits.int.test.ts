// SPDX-License-Identifier: Apache-2.0
// Resource-limit correctness against the runtime DB role. These tests exercise
// the transactional count/insert locks that unit mocks cannot prove.

import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerClient } from '../../src/auth-oauth-clients.js'
import {
  insertOauthTokenPair,
  type NewOauthToken,
  rotateOauthRefreshToken,
} from '../../src/auth-oauth-tokens.js'
import { closeDb } from '../../src/client.js'
import { writeImportedMemory } from '../../src/memory-import.js'
import { reviseMemory } from '../../src/memory-revise.js'
import { writeMemory } from '../../src/memory-write.js'
import { ResourceLimitExceededError } from '../../src/resource-limits.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const RUN = randomUUID()
const CLIENT_A = `a-resource-${RUN}`
const CLIENT_B = `b-resource-${RUN}`
const CLIENT_C = `c-resource-${RUN}`
const CLIENT_IDS = [CLIENT_A, CLIENT_B, CLIENT_C]
const ACTOR = 'user_api' as const

let userId: string

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function memory(label: string) {
  return {
    userId,
    memoryType: 'note',
    topic: `resource ${label}`,
    content: `resource-limit-content-${label}`,
    scope: 'personal',
    tags: [],
    contentHash: hash(`resource-limit-content-${label}`),
    actorKind: ACTOR,
  }
}

function tokenPair(clientId: string, label: string): [NewOauthToken, NewOauthToken] {
  const expiresAt = new Date(Date.now() + 3_600_000)
  return [
    {
      tokenHash: `access-${label}-${randomUUID()}`,
      kind: 'access',
      clientId,
      scope: 'memory:read memory:write',
      expiresAt,
    },
    {
      tokenHash: `refresh-${label}-${randomUUID()}`,
      kind: 'refresh',
      clientId,
      scope: 'memory:read memory:write',
      expiresAt,
    },
  ]
}

async function issue(clientId: string, label: string, max?: number): Promise<boolean> {
  const [access, refresh] = tokenPair(clientId, label)
  return insertOauthTokenPair(userId, access, refresh, max)
}

async function cleanOwnedRows(): Promise<void> {
  await resetDomainTables()
  await ownerPool.query('DELETE FROM oauth_tokens WHERE user_id = $1', [userId])
}

beforeAll(async () => {
  userId = await seedUser(`resource-limits-${RUN}@test.local`)
  for (const clientId of CLIENT_IDS) {
    await registerClient({
      clientId,
      clientName: clientId,
      redirectUris: [`https://${clientId}.example.test/callback`],
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: null,
    })
  }
})

beforeEach(cleanOwnedRows)

afterAll(async () => {
  await cleanOwnedRows()
  await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [CLIENT_IDS])
  await closeDb()
  await closePools()
})

describe('live-memory limit', () => {
  it('rejects every live append when max is zero', async () => {
    await expect(writeMemory(memory('zero'), 0)).rejects.toMatchObject({
      resource: 'live_memories',
    })
  })

  it('admits exactly one of two concurrent appends from limit minus one', async () => {
    await writeMemory(memory('existing'), 2)

    const results = await Promise.allSettled([
      writeMemory(memory('racer-a'), 2),
      writeMemory(memory('racer-b'), 2),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(ResourceLimitExceededError),
    })
    const count = await ownerPool.query(
      `SELECT count(*)::int AS n FROM memories
       WHERE user_id = $1 AND status = 'active' AND valid_to IS NULL`,
      [userId],
    )
    expect(count.rows[0].n).toBe(2)
  })

  it('does not charge archived or already-superseded imports', async () => {
    await writeMemory(memory('live'), 1)
    await writeImportedMemory({ ...memory('archived'), status: 'archived' }, 1)
    await writeImportedMemory(
      {
        ...memory('closed'),
        validFrom: new Date('2024-01-01T00:00:00Z'),
        validTo: new Date('2025-01-01T00:00:00Z'),
      },
      1,
    )

    const counts = await ownerPool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active' AND valid_to IS NULL)::int AS live
       FROM memories WHERE user_id = $1`,
      [userId],
    )
    expect(counts.rows[0]).toMatchObject({ total: 3, live: 1 })
  })

  it('allows a net-zero revision while already at cap', async () => {
    const predecessor = await writeMemory(memory('before-revise'), 1)
    const successorInput = memory('after-revise')

    await expect(
      reviseMemory({
        ...successorInput,
        predecessorId: predecessor.id,
        edgeType: 'supersedes',
      }),
    ).resolves.toMatchObject({ id: expect.any(String) })

    const count = await ownerPool.query(
      `SELECT count(*)::int AS n FROM memories
       WHERE user_id = $1 AND status = 'active' AND valid_to IS NULL`,
      [userId],
    )
    expect(count.rows[0].n).toBe(1)
  })

  it('reports a duplicate before the cap, preserving idempotent welcome re-seeds', async () => {
    const input = memory('idempotent')
    await writeMemory(input, 1)

    await expect(writeMemory(input, 1)).rejects.toMatchObject({ name: 'DuplicateMemoryError' })
  })
})

describe('active MCP client limit', () => {
  it('allows the first client, denies a second, and permits same-client reauthorization', async () => {
    await expect(issue(CLIENT_A, 'first', 1)).resolves.toBe(true)
    await expect(issue(CLIENT_B, 'second', 1)).rejects.toMatchObject({
      resource: 'active_mcp_clients',
    })
    await expect(issue(CLIENT_A, 'same-client', 1)).resolves.toBe(true)
  })

  it('rejects first issuance when max is zero', async () => {
    await expect(issue(CLIENT_A, 'zero', 0)).rejects.toMatchObject({
      resource: 'active_mcp_clients',
    })
  })

  it('keeps only the deterministic top client refreshable after a downgrade', async () => {
    const [, refreshA] = tokenPair(CLIENT_A, 'old-a')
    const [, refreshB] = tokenPair(CLIENT_B, 'old-b')
    const [accessA] = tokenPair(CLIENT_A, 'old-a-access')
    const [accessB] = tokenPair(CLIENT_B, 'old-b-access')
    await insertOauthTokenPair(userId, accessA, refreshA)
    await insertOauthTokenPair(userId, accessB, refreshB)
    // Equal recency exercises the documented deterministic client_id ASC tie-break.
    await ownerPool.query(
      `UPDATE oauth_tokens SET created_at = '2025-01-01T00:00:00Z'
       WHERE user_id = $1 AND client_id = ANY($2)`,
      [userId, [CLIENT_A, CLIENT_B]],
    )

    // A losing over-cap client cannot escape convergence by starting a fresh
    // authorization-code flow and minting a newer pair.
    await expect(issue(CLIENT_B, 'loser-reauthorizes', 1)).rejects.toMatchObject({
      resource: 'active_mcp_clients',
    })

    const [nextAccessB, nextRefreshB] = tokenPair(CLIENT_B, 'next-b')
    await expect(
      rotateOauthRefreshToken(userId, refreshB.tokenHash, nextAccessB, nextRefreshB, 1),
    ).rejects.toMatchObject({ resource: 'active_mcp_clients' })

    const [nextAccessA, nextRefreshA] = tokenPair(CLIENT_A, 'next-a')
    await expect(
      rotateOauthRefreshToken(userId, refreshA.tokenHash, nextAccessA, nextRefreshA, 1),
    ).resolves.toBe(true)

    const losingRefresh = await ownerPool.query(
      'SELECT revoked_at FROM oauth_tokens WHERE token_hash = $1',
      [refreshB.tokenHash],
    )
    expect(losingRefresh.rows[0].revoked_at).toBeNull()
  })

  it('leaves dynamic client registration unrestricted', async () => {
    const extraId = `d-resource-${RUN}`
    try {
      await expect(
        registerClient({
          clientId: extraId,
          clientName: 'unrestricted DCR',
          redirectUris: ['https://d-resource.example.test/callback'],
          tokenEndpointAuthMethod: 'none',
          clientSecretHash: null,
        }),
      ).resolves.toMatchObject({ clientId: extraId })
    } finally {
      await ownerPool.query('DELETE FROM oauth_clients WHERE client_id = $1', [extraId])
    }
  })
})
