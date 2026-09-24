// SPDX-License-Identifier: Apache-2.0
// Integration — the workstream F1+F2 db helpers against the real runtime role
// (app_user, NOBYPASSRLS) on the CI ephemeral Neon branch. Proves the advisory
// invariants unit tests cannot reach (real RLS, real grants, real pgvector):
//   - insertProposals lands 'proposed' rows scoped by RLS and is IDEMPOTENT (a
//     re-insert of the same OPEN candidate edge is a no-op via proposals_open_idx)
//   - the consolidator NEVER mutates memories: the memories table is byte-for-byte
//     unchanged across an insertProposals call
//   - findSimilarPairs returns near-duplicate pairs over stored embeddings by the
//     pgvector cosine operator, scoped to the tenant by RLS
//   - sweepCommitments expires open|waiting commitments whose due_at is before the
//     grace cutoff (expireBefore) —
//     writing an 'archive' audit event — and clears fired next_surfacing_at, while
//     leaving not-yet-due / not-yet-surfacing rows untouched, and NEVER touches the
//     riding memory
//
// Reuses packages/db integration infra (helpers.ts) per docs/concepts/testing.mdx.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closeDb,
  findSimilarPairs,
  insertProposals,
  listTenantIds,
  sweepCommitments,
  withTenant,
} from '../../src/index.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

let userA: string
let userB: string

/** A 1536-d unit-ish embedding literal that leans on one axis (cheap, distinct). */
function embedding(axis: number): string {
  const vec = new Array(1536).fill(0)
  vec[axis % 1536] = 1
  return `[${vec.join(',')}]`
}

/** Insert a memory with a given type + embedding directly (owner); returns id. */
async function seedMemory(
  userId: string,
  memoryType: string,
  content: string,
  axis: number,
): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, embedding)
     VALUES ($1, $2, 'topic', $3, encode(sha256($4::bytea), 'hex'), $5::vector)
     RETURNING id`,
    [userId, memoryType, content, content, embedding(axis)],
  )
  return r.rows[0].id
}

/** Insert a commitment-type memory + its commitment (owner); returns both ids. */
async function seedCommitment(
  userId: string,
  content: string,
  fields: { dueAt?: Date | null; nextSurfacingAt?: Date | null; status?: string },
): Promise<{ memoryId: string; commitmentId: string }> {
  const m = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
     VALUES ($1, 'commitment', 'topic', $2, encode(sha256($3::bytea), 'hex'))
     RETURNING id`,
    [userId, content, content],
  )
  const memoryId = m.rows[0].id as string
  const c = await ownerPool.query(
    `INSERT INTO commitments (user_id, memory_id, status, due_at, next_surfacing_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      userId,
      memoryId,
      fields.status ?? 'open',
      fields.dueAt ?? null,
      fields.nextSurfacingAt ?? null,
    ],
  )
  return { memoryId, commitmentId: c.rows[0].id as string }
}

beforeAll(async () => {
  userA = await seedUser('worker-a@test.local')
  userB = await seedUser('worker-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await closeDb()
  await closePools()
})

describe('listTenantIds', () => {
  it('enumerates the seeded tenants', async () => {
    const ids = await listTenantIds()
    expect(ids).toContain(userA)
    expect(ids).toContain(userB)
  })
})

describe('insertProposals (F1)', () => {
  it('inserts proposed rows, is idempotent, and never mutates memories', async () => {
    const from = await seedMemory(userA, 'fact', 'a', 1)
    const to = await seedMemory(userA, 'fact', 'b', 2)

    const memoriesBefore = await ownerPool.query(
      'SELECT id, content, content_hash, valid_to, status, updated_at FROM memories ORDER BY id',
    )

    const written = await withTenant(userA, (tx) =>
      insertProposals(tx, [
        {
          userId: userA,
          fromId: from,
          toId: to,
          edgeType: 'extends',
          memoryType: 'fact',
          similarity: 0.95,
          rationale: 'near-dup',
        },
      ]),
    )
    expect(written).toBe(1)

    // Re-insert the SAME open candidate edge -> 0 new rows (proposals_open_idx).
    const again = await withTenant(userA, (tx) =>
      insertProposals(tx, [
        {
          userId: userA,
          fromId: from,
          toId: to,
          edgeType: 'extends',
          memoryType: 'fact',
          similarity: 0.95,
        },
      ]),
    )
    expect(again).toBe(0)

    const rows = await ownerPool.query(
      `SELECT status, edge_type, memory_type FROM consolidation_proposals WHERE user_id = $1`,
      [userA],
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0]).toMatchObject({
      status: 'proposed',
      edge_type: 'extends',
      memory_type: 'fact',
    })

    // ADVISORY-ONLY: the memories table is byte-for-byte unchanged.
    const memoriesAfter = await ownerPool.query(
      'SELECT id, content, content_hash, valid_to, status, updated_at FROM memories ORDER BY id',
    )
    expect(memoriesAfter.rows).toEqual(memoriesBefore.rows)
  })

  it('is RLS-scoped: a tenant cannot read another tenant proposals', async () => {
    const from = await seedMemory(userA, 'fact', 'a', 3)
    const to = await seedMemory(userA, 'fact', 'b', 4)
    await withTenant(userA, (tx) =>
      insertProposals(tx, [
        {
          userId: userA,
          fromId: from,
          toId: to,
          edgeType: 'extends',
          memoryType: 'fact',
          similarity: 0.9,
        },
      ]),
    )
    const visibleToB = await ownerPool.query(
      'SELECT count(*)::int AS n FROM consolidation_proposals WHERE user_id = $1',
      [userB],
    )
    expect(visibleToB.rows[0].n).toBe(0)
  })
})

describe('findSimilarPairs (F1)', () => {
  it('returns near-duplicate pairs by cosine, scoped to the tenant', async () => {
    // Two near-identical (same axis) + one orthogonal memory for userA.
    await seedMemory(userA, 'fact', 'dup-1', 7)
    await seedMemory(userA, 'fact', 'dup-2', 7)
    await seedMemory(userA, 'fact', 'other', 700)
    // userB has its own pair that must NOT leak into userA's scan.
    await seedMemory(userB, 'fact', 'b-dup-1', 9)
    await seedMemory(userB, 'fact', 'b-dup-2', 9)

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    // Exactly the identical-axis pair clears the 0.9 bar; the orthogonal one (sim 0)
    // does not. RLS keeps userB's pair invisible.
    expect(pairs.length).toBe(1)
    expect(pairs[0]?.similarity).toBeGreaterThan(0.99)
    expect(pairs[0]?.fromType).toBe('fact')
  })

  it('orients each pair successor -> predecessor by recency (from is the NEWER memory)', async () => {
    // Two near-duplicate memories with a known created_at order. The pair MUST come
    // back oriented from = successor (newer), to = predecessor (older), so applying
    // a CLOSES_PREDECESSOR edge closes the OLDER row — regardless of UUID order.
    const older = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, embedding, created_at)
       VALUES ($1, 'fact', 'topic', 'older', encode(sha256('older'::bytea), 'hex'), $2::vector,
               now() - interval '2 days')
       RETURNING id, created_at`,
      [userA, embedding(11)],
    )
    const newer = await ownerPool.query(
      `INSERT INTO memories (user_id, memory_type, topic, content, content_hash, embedding, created_at)
       VALUES ($1, 'fact', 'topic', 'newer', encode(sha256('newer'::bytea), 'hex'), $2::vector,
               now() - interval '1 day')
       RETURNING id, created_at`,
      [userA, embedding(11)],
    )

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    expect(pairs.length).toBe(1)
    // Successor (from) is the more recently created memory; predecessor (to) older.
    expect(pairs[0]?.fromId).toBe(newer.rows[0].id)
    expect(pairs[0]?.toId).toBe(older.rows[0].id)

    // The load-bearing invariant the apply side relies on: from.created_at >= to.created_at.
    const fromCreated = await ownerPool.query('SELECT created_at FROM memories WHERE id = $1', [
      pairs[0]?.fromId,
    ])
    const toCreated = await ownerPool.query('SELECT created_at FROM memories WHERE id = $1', [
      pairs[0]?.toId,
    ])
    expect(new Date(fromCreated.rows[0].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(toCreated.rows[0].created_at).getTime(),
    )
  })

  it('excludes superseded memories (status=active but valid_to set) from candidates', async () => {
    // A supersede leaves status='active' and only sets valid_to (memory-revise.ts).
    // Such a closed historical row must NOT form a candidate pair, else the worker
    // could propose an edge against an already-superseded predecessor (Codex P2).
    const live = await seedMemory(userA, 'fact', 'live', 13)
    const superseded = await seedMemory(userA, 'fact', 'superseded', 13)
    // Close the second one's validity by some prior path, keeping status active.
    await ownerPool.query('UPDATE memories SET valid_to = now() WHERE user_id = $1 AND id = $2', [
      userA,
      superseded,
    ])

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    // The only same-axis partner of `live` is closed, so no live pair remains.
    expect(pairs.length).toBe(0)
    // Sanity: the superseded row never appears on either side of any returned pair.
    expect(pairs.every((p) => p.fromId !== superseded && p.toId !== superseded)).toBe(true)
    expect(live).not.toBe(superseded)
  })
})

describe('findSimilarPairs excludes settled pairs (issue #220)', () => {
  /** Insert a proposal row directly (owner) with the given status. */
  async function seedProposal(
    userId: string,
    fromId: string,
    toId: string,
    status: 'proposed' | 'applied' | 'rejected',
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO consolidation_proposals
         (user_id, from_id, to_id, edge_type, memory_type, similarity, status)
       VALUES ($1, $2, $3, 'extends', 'fact', 0.99, $4)`,
      [userId, fromId, toId, status],
    )
  }

  it('does not re-propose a pair whose proposal was rejected', async () => {
    const older = await seedMemory(userA, 'fact', 'rejected-older', 21)
    const newer = await seedMemory(userA, 'fact', 'rejected-newer', 21)
    // Sanity: the pair is a candidate before any proposal exists.
    const before = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    expect(before.length).toBe(1)

    await seedProposal(userA, newer, older, 'rejected')
    const after = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    expect(after.length).toBe(0)
  })

  it('does not re-propose a pair whose proposal was applied, whatever its orientation', async () => {
    const older = await seedMemory(userA, 'fact', 'applied-older', 23)
    const newer = await seedMemory(userA, 'fact', 'applied-newer', 23)
    // Stored the "wrong" way round on purpose: exclusion must be orientation-agnostic.
    await seedProposal(userA, older, newer, 'applied')

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    expect(pairs.length).toBe(0)
  })

  it('does not re-propose a pair with an OPEN proposal (any status counts as settled)', async () => {
    const older = await seedMemory(userA, 'fact', 'open-older', 31)
    const newer = await seedMemory(userA, 'fact', 'open-newer', 31)
    // Before #220 an open proposal was only deduped at insert time by
    // proposals_open_idx; now the pair never reaches the insert at all.
    await seedProposal(userA, newer, older, 'proposed')

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    expect(pairs.length).toBe(0)
  })

  it('does not propose a pair already joined by an additive edge', async () => {
    const older = await seedMemory(userA, 'fact', 'edge-older', 25)
    const newer = await seedMemory(userA, 'fact', 'edge-newer', 25)
    // An `extends` edge leaves BOTH rows live (no valid_to), which is exactly the
    // case the live-only filter cannot catch.
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'extends', 'worker')`,
      [userA, newer, older],
    )

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    expect(pairs.length).toBe(0)
  })

  it('does not propose a pair whose edge is stored in the reverse orientation', async () => {
    const older = await seedMemory(userA, 'fact', 'rev-edge-older', 33)
    const newer = await seedMemory(userA, 'fact', 'rev-edge-newer', 33)
    await ownerPool.query(
      `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
       VALUES ($1, $2, $3, 'derives', 'worker')`,
      [userA, older, newer],
    )

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    expect(pairs.length).toBe(0)
  })

  it('still proposes a fresh successor against a memory whose old pair was settled', async () => {
    const older = await seedMemory(userA, 'fact', 'settled-older', 27)
    const rejectedTwin = await seedMemory(userA, 'fact', 'settled-twin', 27)
    await seedProposal(userA, rejectedTwin, older, 'rejected')
    // A NEW memory id on the same subject is a new question, not the settled one.
    const fresh = await seedMemory(userA, 'fact', 'settled-fresh', 27)

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    const unordered = pairs.map((p) => [p.fromId, p.toId].sort().join('|'))
    expect(unordered).toContain([fresh, older].sort().join('|'))
    expect(unordered).toContain([fresh, rejectedTwin].sort().join('|'))
    expect(unordered).not.toContain([rejectedTwin, older].sort().join('|'))
  })

  it("another tenant's settled pairs do not affect mine", async () => {
    const olderA = await seedMemory(userA, 'fact', 'a-older', 29)
    const newerA = await seedMemory(userA, 'fact', 'a-newer', 29)
    // userB has its own settled pair; it must not affect userA's candidates. (The
    // composite (user_id, id) FKs make a true cross-tenant match unrepresentable,
    // so this is a sanity check on the anti-join, not an RLS proof.)
    const olderB = await seedMemory(userB, 'fact', 'b-older', 29)
    const newerB = await seedMemory(userB, 'fact', 'b-newer', 29)
    await seedProposal(userB, newerB, olderB, 'rejected')

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, userA, 0.9, 50))
    expect(pairs.length).toBe(1)
    expect([pairs[0]?.fromId, pairs[0]?.toId].sort()).toEqual([olderA, newerA].sort())
  })
})

describe('sweepCommitments (F2)', () => {
  it('expires overdue commitments (with archive event) and surfaces due ones', async () => {
    const now = new Date('2026-06-09T12:00:00.000Z')
    const past = new Date('2026-06-01T00:00:00.000Z')
    const future = new Date('2026-12-01T00:00:00.000Z')

    const overdue = await seedCommitment(userA, 'overdue', { dueAt: past })
    const notDue = await seedCommitment(userA, 'not-due', { dueAt: future })
    const dueToSurface = await seedCommitment(userA, 'surface', { nextSurfacingAt: past })
    const notYetSurface = await seedCommitment(userA, 'later', { nextSurfacingAt: future })

    const memoriesBefore = await ownerPool.query(
      'SELECT id, content, content_hash, valid_to, status FROM memories ORDER BY id',
    )

    const result = await withTenant(userA, (tx) => sweepCommitments(tx, userA, now, now))
    expect(result.expired).toBe(1)
    expect(result.surfaced).toBe(1)

    const statuses = await ownerPool.query(
      'SELECT id, status, next_surfacing_at FROM commitments WHERE user_id = $1',
      [userA],
    )
    const byId = new Map(statuses.rows.map((r) => [r.id, r]))
    expect(byId.get(overdue.commitmentId)?.status).toBe('expired')
    expect(byId.get(notDue.commitmentId)?.status).toBe('open')
    expect(byId.get(dueToSurface.commitmentId)?.next_surfacing_at).toBeNull()
    expect(byId.get(notYetSurface.commitmentId)?.next_surfacing_at).not.toBeNull()

    // The overdue expiry wrote an 'archive' audit event by the worker actor.
    const events = await ownerPool.query(
      `SELECT event_kind, actor_kind FROM memory_events
       WHERE user_id = $1 AND memory_id = $2`,
      [userA, overdue.memoryId],
    )
    expect(events.rows).toContainEqual({ event_kind: 'archive', actor_kind: 'worker' })

    // NEVER mutates the riding memories.
    const memoriesAfter = await ownerPool.query(
      'SELECT id, content, content_hash, valid_to, status FROM memories ORDER BY id',
    )
    expect(memoriesAfter.rows).toEqual(memoriesBefore.rows)
  })

  it('keeps a commitment inside the grace window open, expires one beyond it (issue #221)', async () => {
    const now = new Date('2026-06-09T12:00:00.000Z')
    const expireBefore = new Date('2026-05-26T12:00:00.000Z') // now - 14 days
    const dueThreeDaysAgo = new Date('2026-06-06T12:00:00.000Z')
    const dueTwentyDaysAgo = new Date('2026-05-20T12:00:00.000Z')

    // Also due to surface: leg 2 must still clear the fired instant on a row that
    // leg 1 now leaves open (before #221 leg 1 expired it first).
    const insideWindow = await seedCommitment(userA, 'inside', {
      dueAt: dueThreeDaysAgo,
      nextSurfacingAt: dueThreeDaysAgo,
    })
    const beyondWindow = await seedCommitment(userA, 'beyond', {
      dueAt: dueTwentyDaysAgo,
      status: 'waiting',
    })

    const result = await withTenant(userA, (tx) => sweepCommitments(tx, userA, now, expireBefore))
    expect(result.expired).toBe(1)
    expect(result.surfaced).toBe(1)

    const statuses = await ownerPool.query(
      'SELECT id, status, next_surfacing_at FROM commitments WHERE user_id = $1',
      [userA],
    )
    const byId = new Map(statuses.rows.map((r) => [r.id, r]))
    // Past due but inside the window: still open, so briefing keeps it as overdue,
    // and its fired surfacing instant is cleared by leg 2 as for any live row.
    expect(byId.get(insideWindow.commitmentId)?.status).toBe('open')
    expect(byId.get(insideWindow.commitmentId)?.next_surfacing_at).toBeNull()
    // Past the window: expired, from `waiting` as well as from `open`.
    expect(byId.get(beyondWindow.commitmentId)?.status).toBe('expired')

    // Only the expired row got the archive audit event.
    const events = await ownerPool.query(
      `SELECT memory_id FROM memory_events WHERE user_id = $1 AND event_kind = 'archive'`,
      [userA],
    )
    expect(events.rows.map((r) => r.memory_id)).toEqual([beyondWindow.memoryId])
  })
})
