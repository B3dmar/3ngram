// SPDX-License-Identifier: Apache-2.0
// Integration — revise() against the real runtime role (app_user, NOBYPASSRLS)
// on the CI ephemeral Neon branch. Proves the slice-2 invariants that unit
// tests (mocked db) cannot:
//   - atomicity: close-predecessor + insert-successor + insert-edge + events
//     all land in ONE withTenant tx, and roll back together on failure
//   - append-and-supersede: the predecessor stays READABLE (valid_to set, row
//     NOT deleted); only its content_hash slot frees for re-assertion
//   - the typed edge points successor -> predecessor with the right type
//   - cross-tenant revise is rejected (RLS -> PredecessorNotFoundError)
//   - re-revising an already-closed predecessor is a typed conflict
//   - re-asserting the predecessor's EXACT content as the successor is legal
//   - the edge unique index surfaces a typed EdgeConflictError
//   - supersession tier-penalty applies post-revise (searchFused ranks the
//     superseded predecessor below its successor)
//
// VERIFY-FIRST (resolved): the runtime role HAS UPDATE on memories
// (provision-roles.sql), so closing valid_to as app_user under RLS works.
//
// Reuses packages/db integration infra (helpers.ts).

import {
  closeDb,
  DuplicateMemoryError,
  EdgeConflictError,
  insertEdge,
  PredecessorAlreadySupersededError,
  PredecessorNotFoundError,
  searchFused,
  withTenant,
} from '@3ngram/db'
import type { ActorKind } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { CommitmentNotFoundError, resolveByMemoryId } from '../../src/write/commitments.js'
import { remember } from '../../src/write/remember.js'
import { revise } from '../../src/write/revise.js'

let userA: string
let userB: string

const ACTOR: ActorKind = 'user_api'

const baseMemory = () => ({
  memoryType: 'note',
  topic: 'release process',
  content: 'releases cut from main after the staging soak',
  tags: ['ops', 'release'],
})

const successor = (predecessorId: string) => ({
  memoryType: 'note',
  topic: 'release process',
  content: 'releases cut from main after a 24h staging soak window',
  tags: ['ops', 'release'],
  predecessorId,
})

beforeAll(async () => {
  userA = await seedUser('revise-a@test.local')
  userB = await seedUser('revise-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('revise (runtime role, real withTenant)', () => {
  it('closes the predecessor, appends the successor, writes the edge + events atomically', async () => {
    const { id: predId } = await remember(userA, baseMemory(), ACTOR)
    const { id: succId } = await revise(userA, successor(predId), ACTOR)

    expect(succId).not.toBe(predId)

    // Predecessor: STILL PRESENT (append-and-supersede — never deleted), with
    // valid_to set and content UNCHANGED.
    const pred = await ownerPool.query(
      'SELECT valid_to, content, status FROM memories WHERE id = $1',
      [predId],
    )
    expect(pred.rowCount).toBe(1)
    expect(pred.rows[0].valid_to).not.toBeNull()
    expect(pred.rows[0].content).toBe(baseMemory().content)

    // Successor: live (valid_to NULL), NULL embedding (embed-on-write is later).
    const succ = await ownerPool.query(
      'SELECT valid_to, embedding, content FROM memories WHERE id = $1',
      [succId],
    )
    expect(succ.rows[0].valid_to).toBeNull()
    expect(succ.rows[0].embedding).toBeNull()
    expect(succ.rows[0].content).toBe(successor(predId).content)

    // Edge: from successor TO predecessor, type supersedes (direction is
    // load-bearing for search supersession ranking).
    const edge = await ownerPool.query(
      'SELECT from_id, to_id, edge_type, created_by FROM memory_edges WHERE user_id = $1',
      [userA],
    )
    expect(edge.rowCount).toBe(1)
    expect(edge.rows[0].from_id).toBe(succId)
    expect(edge.rows[0].to_id).toBe(predId)
    expect(edge.rows[0].edge_type).toBe('supersedes')

    // Events: revise() emits a create for the successor and a supersede for the
    // predecessor. (A separate create for predId already exists from remember();
    // we assert on the specific (memory_id, event_kind) pairs to avoid relying on
    // non-deterministic row order across the two create rows.)
    const succCreate = await ownerPool.query(
      "SELECT count(*) AS n FROM memory_events WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'create'",
      [userA, succId],
    )
    expect(Number(succCreate.rows[0].n)).toBe(1)
    const predSupersede = await ownerPool.query(
      "SELECT count(*) AS n FROM memory_events WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'supersede'",
      [userA, predId],
    )
    expect(Number(predSupersede.rows[0].n)).toBe(1)
  })

  it('rolls back the predecessor close when a LATER statement fails (atomic all-or-nothing)', async () => {
    // The predecessor UPDATE (valid_to) runs FIRST; the duplicate-content guard
    // throws AFTER it, while inserting the successor. If the tx were not atomic
    // the predecessor would be left closed with no successor — an orphaned
    // supersession. The whole tx must roll back: predecessor stays live, no
    // successor, no edge, no events.
    const { id: predId } = await remember(userA, baseMemory(), ACTOR)
    const otherContent = 'an unrelated live memory the successor will collide with'
    await remember(userA, { ...baseMemory(), content: otherContent }, ACTOR)

    const memBefore = await ownerPool.query(
      'SELECT count(*) AS n FROM memories WHERE user_id = $1',
      [userA],
    )

    await expect(
      revise(userA, { ...successor(predId), content: otherContent }, ACTOR),
    ).rejects.toBeInstanceOf(DuplicateMemoryError)

    // Predecessor close rolled back -> still live.
    const pred = await ownerPool.query('SELECT valid_to FROM memories WHERE id = $1', [predId])
    expect(pred.rows[0].valid_to).toBeNull()
    // No new memory row, no edge, no events from the failed revise.
    const memAfter = await ownerPool.query(
      'SELECT count(*) AS n FROM memories WHERE user_id = $1',
      [userA],
    )
    expect(memAfter.rows[0].n).toBe(memBefore.rows[0].n)
    const edges = await ownerPool.query(
      'SELECT count(*) AS n FROM memory_edges WHERE user_id = $1',
      [userA],
    )
    expect(Number(edges.rows[0].n)).toBe(0)
    const events = await ownerPool.query(
      "SELECT count(*) AS n FROM memory_events WHERE user_id = $1 AND event_kind = 'supersede'",
      [userA],
    )
    expect(Number(events.rows[0].n)).toBe(0)
  })

  it('rejects a cross-tenant revise (RLS hides the predecessor -> NotFound)', async () => {
    const { id: predId } = await remember(userA, baseMemory(), ACTOR)

    // userB tries to revise userA's memory: RLS returns zero rows.
    await expect(revise(userB, successor(predId), ACTOR)).rejects.toBeInstanceOf(
      PredecessorNotFoundError,
    )

    // userA's predecessor is untouched (still live), no successor / edge leaked.
    const pred = await ownerPool.query('SELECT valid_to FROM memories WHERE id = $1', [predId])
    expect(pred.rows[0].valid_to).toBeNull()
    const bRows = await ownerPool.query('SELECT count(*) AS n FROM memories WHERE user_id = $1', [
      userB,
    ])
    expect(Number(bRows.rows[0].n)).toBe(0)
  })

  it('rejects re-revising an already-superseded predecessor (typed conflict)', async () => {
    const { id: predId } = await remember(userA, baseMemory(), ACTOR)
    await revise(userA, successor(predId), ACTOR)

    await expect(revise(userA, successor(predId), ACTOR)).rejects.toBeInstanceOf(
      PredecessorAlreadySupersededError,
    )
  })

  it('rejects a revise whose predecessor does not exist (typed NotFound)', async () => {
    const ghost = '00000000-0000-7000-8000-0000000000ff'
    await expect(revise(userA, successor(ghost), ACTOR)).rejects.toBeInstanceOf(
      PredecessorNotFoundError,
    )
  })

  it('allows re-asserting the predecessor EXACT content as the successor (closing frees the hash slot)', async () => {
    const { id: predId } = await remember(userA, baseMemory(), ACTOR)
    // Successor content == predecessor content. Legal because closing the
    // predecessor frees its live-hash slot before the successor INSERT.
    const sameContent = { ...baseMemory(), predecessorId: predId }
    await expect(revise(userA, sameContent, ACTOR)).resolves.toMatchObject({
      id: expect.any(String),
    })
  })

  it('surfaces a typed EdgeConflictError on the edge unique index', async () => {
    // Stage two live memories and a pre-existing supersedes edge between them,
    // then try to insert the SAME edge again via the helper.
    const { id: a } = await remember(userA, { ...baseMemory(), content: 'edge node one' }, ACTOR)
    const { id: b } = await remember(userA, { ...baseMemory(), content: 'edge node two' }, ACTOR)

    await withTenant(userA, (tx) =>
      insertEdge(tx, {
        userId: userA,
        fromId: a,
        toId: b,
        edgeType: 'supersedes',
        createdBy: ACTOR,
      }),
    )

    await expect(
      withTenant(userA, (tx) =>
        insertEdge(tx, {
          userId: userA,
          fromId: a,
          toId: b,
          edgeType: 'supersedes',
          createdBy: ACTOR,
        }),
      ),
    ).rejects.toBeInstanceOf(EdgeConflictError)
  })

  it('does NOT tier-demote the predecessor when edgeIntent is updates (debt: slice-4 review)', async () => {
    // search.ts penalizes ONLY edge_type='supersedes' (e.to_id = predecessor).
    // An 'updates' revise links the memories but is NOT a supersession, so the
    // predecessor must NOT be tier-demoted. Both rows match the term; the
    // predecessor keeps a competitive score and is NOT forced below its successor
    // by the penalty (the negative companion to the supersedes test below).
    const { id: predId } = await remember(
      userA,
      { ...baseMemory(), content: 'terraform module pins the aws provider version' },
      ACTOR,
    )
    const { id: succId } = await revise(
      userA,
      {
        ...successor(predId),
        content: 'terraform module pins the aws and gcp provider versions',
        edgeIntent: 'updates' as const,
      },
      ACTOR,
    )

    const hits = await withTenant(userA, (tx) => searchFused(tx, userA, 'terraform provider', 10))
    const predHit = hits.find((h) => h.id === predId)
    const succHit = hits.find((h) => h.id === succId)

    // Both retrievable...
    expect(predHit).toBeDefined()
    expect(succHit).toBeDefined()
    // ...and the predecessor is NOT tier-demoted: its score is NOT pushed below
    // zero by a supersession penalty (which would be score < 0 given the default
    // penalty of 2 exceeds the max base score). An 'updates' edge applies none.
    expect(predHit?.score ?? -1).toBeGreaterThanOrEqual(0)
    // The edge that was written is 'updates', never 'supersedes'.
    const edge = await ownerPool.query(
      'SELECT edge_type FROM memory_edges WHERE user_id = $1 AND from_id = $2 AND to_id = $3',
      [userA, succId, predId],
    )
    expect(edge.rows[0].edge_type).toBe('updates')
  })

  it('tier-penalizes the superseded predecessor in searchFused (supersedes intent)', async () => {
    // Both memories share the searched term so both match FTS; supersession
    // ranking (search.ts: e.to_id = predecessor, edge_type='supersedes') must
    // sink the predecessor BELOW its successor, NOT filter it out (docs/concepts/memory-model.mdx).
    const { id: predId } = await remember(
      userA,
      { ...baseMemory(), content: 'kubernetes rollout uses a blue-green strategy' },
      ACTOR,
    )
    const { id: succId } = await revise(
      userA,
      {
        ...successor(predId),
        content: 'kubernetes rollout now uses a canary strategy',
      },
      ACTOR,
    )

    const hits = await withTenant(userA, (tx) => searchFused(tx, userA, 'kubernetes rollout', 10))
    const ids = hits.map((h) => h.id)

    // Both retrievable (ranking, not filtering)...
    expect(ids).toContain(succId)
    expect(ids).toContain(predId)
    // ...but the live successor ranks ABOVE the superseded predecessor.
    expect(ids.indexOf(succId)).toBeLessThan(ids.indexOf(predId))
    const succHit = hits.find((h) => h.id === succId)
    const predHit = hits.find((h) => h.id === predId)
    expect(succHit?.score).toBeGreaterThan(predHit?.score ?? Number.POSITIVE_INFINITY)
  })
})

// COMMITMENT CARRY across revision: the
// obligation follows the LIVE memory so a revised commitment stays resolvable.
// These two runtime-role cases (a: carry, d: auto-create-on-promote) prove the
// fix end-to-end against real RLS; the branch matrix is unit-covered separately.
describe('revise (commitment carry across revision, real withTenant)', () => {
  const commitmentBase = () => ({
    memoryType: 'commitment',
    topic: 'follow up',
    content: 'ping the team about the launch checklist',
    tags: ['mcp'],
  })

  const commitmentSuccessor = (predecessorId: string) => ({
    memoryType: 'commitment',
    topic: 'follow up',
    content: 'ping the team about the launch checklist by EOD friday',
    tags: ['mcp'],
    predecessorId,
  })

  it('(a) MOVES the commitment row to a commitment-type successor; resolve keys on the successor', async () => {
    // remember a commitment memory -> auto-creates an 'open' commitment row.
    const { id: predId, commitmentId } = await remember(userA, commitmentBase(), ACTOR)
    expect(commitmentId).toEqual(expect.any(String))

    const { id: succId } = await revise(userA, commitmentSuccessor(predId), ACTOR)

    // EXACTLY ONE commitment row for the tenant, now keyed to the SUCCESSOR
    // memory (the obligation's identity survived the revision — same row id).
    const rows = await ownerPool.query(
      'SELECT id, memory_id, status FROM commitments WHERE user_id = $1',
      [userA],
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].id).toBe(commitmentId)
    expect(rows.rows[0].memory_id).toBe(succId)
    expect(rows.rows[0].status).toBe('open')

    // resolve(successorId) WORKS (the bug: it threw CommitmentNotFound before).
    await expect(resolveByMemoryId(userA, succId, 'resolved', ACTOR)).resolves.toMatchObject({
      id: commitmentId,
      status: 'resolved',
    })
    // resolve(predecessorId) is now NotFound — correct, it is superseded.
    await expect(resolveByMemoryId(userA, predId, 'resolved', ACTOR)).rejects.toBeInstanceOf(
      CommitmentNotFoundError,
    )
  })

  it('(d) AUTO-CREATES a commitment when promoting a note into a commitment successor', async () => {
    // A note memory has no commitment row; revising it INTO a commitment must
    // mint a fresh 'open' obligation (symmetry with remember's auto-create).
    const { id: predId } = await remember(userA, baseMemory(), ACTOR)
    const promoted = {
      memoryType: 'commitment',
      topic: 'release process',
      content: 'now an actionable commitment to soak staging for 24h',
      tags: ['ops', 'release'],
      predecessorId: predId,
    }
    const { id: succId } = await revise(userA, promoted, ACTOR)

    const rows = await ownerPool.query(
      'SELECT memory_id, status FROM commitments WHERE user_id = $1',
      [userA],
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].memory_id).toBe(succId)
    expect(rows.rows[0].status).toBe('open')

    // The freshly promoted memory is immediately resolvable.
    await expect(resolveByMemoryId(userA, succId, 'resolved', ACTOR)).resolves.toMatchObject({
      status: 'resolved',
    })
  })

  it('(b) RESOLVES the predecessor row when demoting a commitment to a note (issue #127)', async () => {
    // Demote (commitment -> note): the obligation is
    // explicitly CLOSED (status 'resolved', resolved_at stamped) in the same tx,
    // never stranded 'open' on the now-superseded predecessor where briefing's
    // valid_to IS NULL join made it silently invisible. The successor is a plain
    // note with no commitment row of its own.
    const { id: predId, commitmentId } = await remember(userA, commitmentBase(), ACTOR)
    const demoted = {
      memoryType: 'note',
      topic: 'follow up',
      content: 'this is just a note now, no longer an obligation',
      tags: ['mcp'],
      predecessorId: predId,
    }
    const { id: succId } = await revise(userA, demoted, ACTOR)

    const rows = await ownerPool.query(
      'SELECT id, memory_id, status, resolved_at FROM commitments WHERE user_id = $1',
      [userA],
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].id).toBe(commitmentId)
    // The row stays keyed to the PREDECESSOR (no move to the note successor)...
    expect(rows.rows[0].memory_id).toBe(predId)
    // ...but is resolved with the DB-clock timestamp, not stranded 'open'.
    expect(rows.rows[0].status).toBe('resolved')
    expect(rows.rows[0].resolved_at).not.toBeNull()
    // The 'resolve' audit event landed on the predecessor's event stream (the
    // transitionCommitment pattern).
    const events = await ownerPool.query(
      "SELECT count(*) AS n FROM memory_events WHERE user_id = $1 AND memory_id = $2 AND event_kind = 'resolve'",
      [userA, predId],
    )
    expect(Number(events.rows[0].n)).toBe(1)
    // The note successor has no commitment to resolve.
    await expect(resolveByMemoryId(userA, succId, 'resolved', ACTOR)).rejects.toBeInstanceOf(
      CommitmentNotFoundError,
    )
  })

  it('(c) note -> note revise touches no commitments (no row to move, none created)', async () => {
    const { id: predId } = await remember(userA, baseMemory(), ACTOR)
    await revise(userA, successor(predId), ACTOR)

    const rows = await ownerPool.query('SELECT count(*) AS n FROM commitments WHERE user_id = $1', [
      userA,
    ])
    expect(Number(rows.rows[0].n)).toBe(0)
  })
})
