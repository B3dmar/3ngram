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
//   - sweepCommitments expires overdue (due_at past) open|waiting commitments —
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

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, 0.9, 50))
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

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, 0.9, 50))
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

    const pairs = await withTenant(userA, (tx) => findSimilarPairs(tx, 0.9, 50))
    // The only same-axis partner of `live` is closed, so no live pair remains.
    expect(pairs.length).toBe(0)
    // Sanity: the superseded row never appears on either side of any returned pair.
    expect(pairs.every((p) => p.fromId !== superseded && p.toId !== superseded)).toBe(true)
    expect(live).not.toBe(superseded)
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

    const result = await withTenant(userA, (tx) => sweepCommitments(tx, userA, now))
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
})
