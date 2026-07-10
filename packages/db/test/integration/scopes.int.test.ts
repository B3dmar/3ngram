// SPDX-License-Identifier: Apache-2.0
// Scopes registry + environment-stats + proposals review
// exercised through the RUNTIME role via withTenant() — the production path.
// Owner bypasses RLS and would prove nothing (docs/concepts/testing.mdx).
//
// Covers the D3 acceptance criteria at the db layer:
//   - scope CRUD round-trip (create -> list -> rename -> set_aliases -> delete)
//   - uniqueness conflict surfaces a typed ScopeNameConflictError
//   - DELETE semantics: deleting a scope leaves a memory's denormalized scope
//     TEXT intact (registry edit only, no FK, no cascade — orchestrator decision)
//   - tenant isolation: user B never sees / mutates user A's scopes
//   - environment stats: bounded counts (by type, active vs superseded, by status)
//   - proposals list/reject round-trip (seed a row directly), reject is an UPDATE
//     not a DELETE, already-decided -> ProposalNotFoundError
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/client.js'
import {
  countProposalsByStatus,
  listProposals,
  ProposalNotFoundError,
  rejectProposal,
} from '../../src/proposals-read.js'
import {
  createScope,
  deleteScope,
  getEnvironmentStats,
  listScopes,
  renameScope,
  ScopeNameConflictError,
  ScopeNotFoundError,
  setScopeAliases,
} from '../../src/scopes.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string
let userB: string

beforeEach(async () => {
  await resetDomainTables()
  userA = await seedUser(`d3-scopes-a-${crypto.randomUUID()}@test.local`)
  userB = await seedUser(`d3-scopes-b-${crypto.randomUUID()}@test.local`)
})

afterAll(closePools)

describe('scopes registry CRUD (runtime role, withTenant)', () => {
  it('round-trips create -> list -> rename -> set_aliases -> delete', async () => {
    await withTenant(userA, async (tx) => {
      const created = await createScope(tx, userA, 'research', ['r'])
      expect(created.name).toBe('research')
      expect(created.aliases).toEqual(['r'])

      const listed = await listScopes(tx)
      expect(listed.map((s) => s.name)).toEqual(['research'])

      const renamed = await renameScope(tx, 'research', 'r-and-d')
      expect(renamed.name).toBe('r-and-d')

      const aliased = await setScopeAliases(tx, 'r-and-d', ['rnd', 'lab'])
      expect(aliased.aliases).toEqual(['rnd', 'lab'])

      await deleteScope(tx, 'r-and-d')
      expect(await listScopes(tx)).toEqual([])
    })
  })

  it('rejects a duplicate name with a typed ScopeNameConflictError', async () => {
    await withTenant(userA, (tx) => createScope(tx, userA, 'work', []))
    await expect(
      withTenant(userA, (tx) => createScope(tx, userA, 'work', [])),
    ).rejects.toBeInstanceOf(ScopeNameConflictError)
  })

  it('rejects renaming onto an existing name with a conflict', async () => {
    await withTenant(userA, async (tx) => {
      await createScope(tx, userA, 'a', [])
      await createScope(tx, userA, 'b', [])
    })
    await expect(withTenant(userA, (tx) => renameScope(tx, 'a', 'b'))).rejects.toBeInstanceOf(
      ScopeNameConflictError,
    )
  })

  it('rejects rename/set_aliases/delete of a missing scope with not-found', async () => {
    await expect(withTenant(userA, (tx) => renameScope(tx, 'ghost', 'x'))).rejects.toBeInstanceOf(
      ScopeNotFoundError,
    )
    await expect(
      withTenant(userA, (tx) => setScopeAliases(tx, 'ghost', ['x'])),
    ).rejects.toBeInstanceOf(ScopeNotFoundError)
    await expect(withTenant(userA, (tx) => deleteScope(tx, 'ghost'))).rejects.toBeInstanceOf(
      ScopeNotFoundError,
    )
  })

  it('DELETE semantics: a memory keeps its scope TEXT after the scope is deleted', async () => {
    // The orchestrator-decided honest semantics: scopes is a registry, memories
    // .scope is denormalized text with NO FK. Deleting the scope is a registry
    // edit only — the memory row and its scope text are untouched and still valid.
    await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, scope)
       VALUES ($1, 'note', 't', 'c', $2, 'research')`,
      [userA, `d3-del-${crypto.randomUUID()}`],
    )
    await withTenant(userA, async (tx) => {
      await createScope(tx, userA, 'research', [])
      await deleteScope(tx, 'research')
    })
    const memo = await ownerPool.query(
      `SELECT scope FROM memories WHERE user_id = $1 AND scope = 'research'`,
      [userA],
    )
    expect(memo.rowCount).toBe(1)
    expect(memo.rows[0].scope).toBe('research')
  })

  it('enforces tenant isolation: B never sees or mutates A scopes', async () => {
    await withTenant(userA, (tx) => createScope(tx, userA, 'a-private', []))
    // B lists nothing of A's.
    expect(await withTenant(userB, (tx) => listScopes(tx))).toEqual([])
    // B cannot rename A's scope — RLS hides the row, so it is not-found for B.
    await expect(
      withTenant(userB, (tx) => renameScope(tx, 'a-private', 'b-grab')),
    ).rejects.toBeInstanceOf(ScopeNotFoundError)
    // B can register the SAME name independently (unique is per-user).
    const bScope = await withTenant(userB, (tx) => createScope(tx, userB, 'a-private', []))
    expect(bScope.name).toBe('a-private')
    // A still sees only its own row.
    const aList = await withTenant(userA, (tx) => listScopes(tx))
    expect(aList.map((s) => s.name)).toEqual(['a-private'])
  })
})

describe('environment stats (bounded counts, runtime role)', () => {
  it('counts memories by type, active vs superseded, and commitments by status', async () => {
    // Seed: 2 active notes, 1 active fact, 1 superseded note (valid_to set), and a
    // commitment memory + its commitment row (open).
    const hash = () => `d3-stats-${crypto.randomUUID()}`
    await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1,'note','t','c',$2), ($1,'note','t','c',$3), ($1,'fact','t','c',$4)`,
      [userA, hash(), hash(), hash()],
    )
    await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, valid_to)
       VALUES ($1,'note','t','c',$2, now())`,
      [userA, hash()],
    )
    const commitMemo = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1,'commitment','t','c',$2) RETURNING id`,
      [userA, hash()],
    )
    await ownerPool.query(
      `INSERT INTO commitments (user_id, memory_id, status) VALUES ($1, $2, 'open')`,
      [userA, commitMemo.rows[0].id],
    )

    const stats = await withTenant(userA, (tx) => getEnvironmentStats(tx))
    // LIVE counts = status='active' AND valid_to IS NULL. The superseded note keeps
    // status='active' (docs/concepts/memory-model.mdx marks it via valid_to only) so it must NOT inflate
    // the live by-type or active totals (Codex P2, comment 3372115945).
    expect(stats.memoriesByType.note).toBe(2) // 2 live notes; the superseded one excluded
    expect(stats.memoriesByType.fact).toBe(1)
    expect(stats.memoriesByType.commitment).toBe(1)
    expect(stats.activeMemories).toBe(4) // 4 live rows; the superseded note excluded
    expect(stats.supersededMemories).toBe(1) // the one with valid_to set
    expect(stats.commitmentsByStatus.open).toBe(1)
  })

  it('a revised memory does NOT count its superseded predecessor in live totals', async () => {
    // Simulate an docs/concepts/memory-model.mdx revise: a predecessor whose validity window is CLOSED
    // (valid_to set) but whose status stays 'active', plus its live successor. The
    // predecessor must be excluded from every LIVE count — only the successor is
    // live (Codex P2, comment 3372115945).
    const h = () => `d3-revise-${crypto.randomUUID()}`
    await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, status, valid_to)
       VALUES ($1,'decision','t','old',$2,'active', now())`,
      [userA, h()],
    )
    await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, status)
       VALUES ($1,'decision','t','new',$2,'active')`,
      [userA, h()],
    )

    const stats = await withTenant(userA, (tx) => getEnvironmentStats(tx))
    expect(stats.memoriesByType.decision).toBe(1) // only the live successor
    expect(stats.activeMemories).toBe(1) // predecessor (valid_to set) excluded
    expect(stats.supersededMemories).toBe(1) // the predecessor is the superseded one
  })

  it('returns zeros for an empty tenant (no firehose, no throw)', async () => {
    const stats = await withTenant(userA, (tx) => getEnvironmentStats(tx))
    expect(stats.activeMemories).toBe(0)
    expect(stats.supersededMemories).toBe(0)
    expect(stats.memoriesByType).toEqual({})
    expect(stats.commitmentsByStatus).toEqual({})
  })
})

describe('review_proposals list/reject (runtime role)', () => {
  /** A proposal needs two parent memories (composite FKs). Returns its id. */
  async function seedProposal(userId: string, status = 'proposed'): Promise<string> {
    const m = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
       VALUES ($1,'fact','t','c',$2), ($1,'fact','t','c',$3) RETURNING id`,
      [userId, `d3-prop-${crypto.randomUUID()}`, `d3-prop-${crypto.randomUUID()}`],
    )
    const [fromId, toId] = [m.rows[0].id, m.rows[1].id]
    const p = await ownerPool.query(
      `INSERT INTO consolidation_proposals
         (user_id, from_id, to_id, edge_type, memory_type, similarity, status)
       VALUES ($1, $2, $3, 'supersedes', 'fact', 0.92, $4) RETURNING id`,
      [userId, fromId, toId, status],
    )
    return p.rows[0].id
  }

  it('lists proposals bounded, filters by status, and rejects (UPDATE not DELETE)', async () => {
    const openId = await seedProposal(userA, 'proposed')
    await seedProposal(userA, 'rejected')

    const all = await withTenant(userA, (tx) => listProposals(tx, { limit: 50 }))
    expect(all.length).toBe(2)

    const onlyOpen = await withTenant(userA, (tx) =>
      listProposals(tx, { status: 'proposed', limit: 50 }),
    )
    expect(onlyOpen.map((p) => p.id)).toEqual([openId])

    const rejected = await withTenant(userA, (tx) => rejectProposal(tx, openId))
    expect(rejected.status).toBe('rejected')
    expect(rejected.decidedAt).not.toBeNull()

    // The row STILL EXISTS (reject is an UPDATE; append-only grant forbids DELETE).
    const after = await withTenant(userA, (tx) => listProposals(tx, { limit: 50 }))
    expect(after.find((p) => p.id === openId)?.status).toBe('rejected')
    const counts = await withTenant(userA, (tx) => countProposalsByStatus(tx))
    expect(counts.rejected).toBe(2)
  })

  it('rejecting an already-decided proposal raises ProposalNotFoundError', async () => {
    const id = await seedProposal(userA, 'rejected')
    await expect(withTenant(userA, (tx) => rejectProposal(tx, id))).rejects.toBeInstanceOf(
      ProposalNotFoundError,
    )
  })

  it('enforces tenant isolation: B cannot list or reject A proposals', async () => {
    const id = await seedProposal(userA, 'proposed')
    expect(await withTenant(userB, (tx) => listProposals(tx, { limit: 50 }))).toEqual([])
    await expect(withTenant(userB, (tx) => rejectProposal(tx, id))).rejects.toBeInstanceOf(
      ProposalNotFoundError,
    )
  })
})
