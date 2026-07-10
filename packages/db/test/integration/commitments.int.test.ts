// SPDX-License-Identifier: Apache-2.0
// Integration — commitments FSM against the real runtime role (app_user,
// NOBYPASSRLS) on the CI ephemeral Neon branch. Proves the slice-3 invariants
// that unit tests cannot:
//   - createCommitment lands a row (status 'open') + a `create` event, riding a
//     commitment-type memory via the composite FK; a second commitment for the
//     same memory is a typed CommitmentExistsError
//   - createCommitment REQUIRES a LIVE commitment-type parent: a note-typed or
//     superseded (valid_to set) parent is a typed NotCommitmentMemoryError with
//     NO commitment row / create event written (the FK proves ownership only,
//     not type or liveness)
//   - transitionCommitment sets resolved_at on 'resolved', bumps updated_at, and
//     appends the lifecycle audit event
//   - THE TRIGGER BACKSTOP FIRES: a DIRECT db transitionCommitment with an
//     ILLEGAL pair (bypassing core's canTransition guard) raises a typed
//     IllegalCommitmentTransitionError — the DB enforces the FSM independently
//   - cross-tenant isolation: B cannot transition A's commitment (RLS -> the
//     UPDATE matches zero rows -> CommitmentNotFoundError)
//
// Reuses packages/db integration infra (helpers.ts) per docs/concepts/testing.mdx.

import type { ActorKind } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CommitmentExistsError,
  CommitmentNotFoundError,
  closeDb,
  createCommitment,
  getCommitmentByMemoryId,
  IllegalCommitmentTransitionError,
  NotCommitmentMemoryError,
  transitionCommitment,
  withTenant,
} from '../../src/index.js'
import { commitments } from '../../src/schema/memory.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const ACTOR: ActorKind = 'user_api'

let userA: string
let userB: string

/** Insert a commitment-type memory directly (owner) and return its id. */
async function seedCommitmentMemory(userId: string, content: string): Promise<string> {
  // Bind `content` as two SEPARATE params ($2 text column, $3 ::bytea hash input)
  // rather than reusing one. A single ${param} referenced in two contexts whose
  // inferred types conflict (text column vs ::bytea cast) is deduced
  // inconsistently and fails at PARSE time with "inconsistent types deduced for
  // parameter $n" — the same parse-time param gotcha as the slice-2 ::vector NULL
  // case (see search.ts). Each param now appears in exactly one typed context.
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
     VALUES ($1, 'commitment', 'follow up', $2, encode(sha256($3::bytea), 'hex'))
     RETURNING id`,
    [userId, content, content],
  )
  return r.rows[0].id
}

/**
 * Insert a memory of an arbitrary `memory_type` directly (owner) and return its
 * id. Same two-separate-params discipline as {@link seedCommitmentMemory}: the
 * text column ($3) and the ::bytea hash input ($4) never reuse one param, so no
 * "inconsistent types deduced for parameter $n" parse-time failure.
 */
async function seedTypedMemory(
  userId: string,
  memoryType: string,
  content: string,
): Promise<string> {
  const r = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
     VALUES ($1, $2, 'follow up', $3, encode(sha256($4::bytea), 'hex'))
     RETURNING id`,
    [userId, memoryType, content, content],
  )
  return r.rows[0].id
}

/** Mark a memory superseded (valid_to set) so it is no longer the live row. */
async function supersedeMemory(memoryId: string): Promise<void> {
  await ownerPool.query('UPDATE memories SET valid_to = now() WHERE id = $1', [memoryId])
}

beforeAll(async () => {
  userA = await seedUser('commit-a@test.local')
  userB = await seedUser('commit-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('commitments FSM (runtime role, real withTenant)', () => {
  it('creates a commitment (open) + create event, riding its memory', async () => {
    const memId = await seedCommitmentMemory(userA, 'ship the slice')
    const { id, status } = await createCommitment({
      userId: userA,
      memoryId: memId,
      actorKind: ACTOR,
    })

    expect(status).toBe('open')
    const row = await ownerPool.query(
      'SELECT memory_id, status, resolved_at FROM commitments WHERE id = $1',
      [id],
    )
    expect(row.rows[0].memory_id).toBe(memId)
    expect(row.rows[0].status).toBe('open')
    expect(row.rows[0].resolved_at).toBeNull()

    const events = await ownerPool.query(
      "SELECT count(*) AS n FROM memory_events WHERE memory_id = $1 AND event_kind = 'create'",
      [memId],
    )
    expect(Number(events.rows[0].n)).toBe(1)
  })

  it('rejects a note-typed parent memory (typed NotCommitmentMemoryError, no row written)', async () => {
    const memId = await seedTypedMemory(userA, 'note', 'just a note')
    await expect(
      createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR }),
    ).rejects.toBeInstanceOf(NotCommitmentMemoryError)

    const rows = await ownerPool.query('SELECT id FROM commitments WHERE memory_id = $1', [memId])
    expect(rows.rows).toHaveLength(0)
    const events = await ownerPool.query(
      "SELECT count(*) AS n FROM memory_events WHERE memory_id = $1 AND event_kind = 'create'",
      [memId],
    )
    expect(Number(events.rows[0].n)).toBe(0)
  })

  it('rejects a superseded commitment-typed parent memory (valid_to set)', async () => {
    const memId = await seedCommitmentMemory(userA, 'superseded commitment')
    await supersedeMemory(memId)
    await expect(
      createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR }),
    ).rejects.toBeInstanceOf(NotCommitmentMemoryError)

    const rows = await ownerPool.query('SELECT id FROM commitments WHERE memory_id = $1', [memId])
    expect(rows.rows).toHaveLength(0)
  })

  it('carries only the memoryId on NotCommitmentMemoryError (no content leak)', async () => {
    const memId = await seedTypedMemory(userA, 'note', 'sensitive note body')
    await expect(
      createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR }),
    ).rejects.toMatchObject({ memoryId: memId })
  })

  it('rejects a second commitment for the same memory (typed CommitmentExistsError)', async () => {
    const memId = await seedCommitmentMemory(userA, 'unique per memory')
    await createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR })
    await expect(
      createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR }),
    ).rejects.toBeInstanceOf(CommitmentExistsError)
  })

  it('sets resolved_at, bumps updated_at, and appends a resolve event on resolve', async () => {
    const memId = await seedCommitmentMemory(userA, 'resolve me')
    const { id } = await createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR })

    const before = await ownerPool.query('SELECT updated_at FROM commitments WHERE id = $1', [id])
    const out = await transitionCommitment({
      userId: userA,
      commitmentId: id,
      to: 'resolved',
      actorKind: ACTOR,
    })
    expect(out.status).toBe('resolved')

    const row = await ownerPool.query(
      'SELECT status, resolved_at, updated_at FROM commitments WHERE id = $1',
      [id],
    )
    expect(row.rows[0].status).toBe('resolved')
    expect(row.rows[0].resolved_at).not.toBeNull()
    expect(new Date(row.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0].updated_at).getTime(),
    )

    const ev = await ownerPool.query(
      "SELECT count(*) AS n FROM memory_events WHERE memory_id = $1 AND event_kind = 'resolve'",
      [memId],
    )
    expect(Number(ev.rows[0].n)).toBe(1)
  })

  it('TRIGGER BACKSTOP: a direct illegal transition (core bypassed) raises IllegalCommitmentTransitionError', async () => {
    const memId = await seedCommitmentMemory(userA, 'illegal jump')
    const { id } = await createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR })
    // Drive to 'resolved' legally, then attempt resolved -> expired which is
    // ILLEGAL per COMMITMENT_TRANSITIONS (resolved only -> open). Calling the db
    // helper directly bypasses core's canTransition guard, so ONLY the DB trigger
    // can reject it — proving the backstop.
    await transitionCommitment({
      userId: userA,
      commitmentId: id,
      to: 'resolved',
      actorKind: ACTOR,
    })

    await expect(
      transitionCommitment({ userId: userA, commitmentId: id, to: 'expired', actorKind: ACTOR }),
    ).rejects.toBeInstanceOf(IllegalCommitmentTransitionError)

    // The status did NOT change and no spurious event was appended.
    const row = await ownerPool.query('SELECT status FROM commitments WHERE id = $1', [id])
    expect(row.rows[0].status).toBe('resolved')
  })

  it('carries the real from/to on the backstop error', async () => {
    const memId = await seedCommitmentMemory(userA, 'pair check')
    const { id } = await createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR })
    await transitionCommitment({
      userId: userA,
      commitmentId: id,
      to: 'resolved',
      actorKind: ACTOR,
    })

    await expect(
      transitionCommitment({ userId: userA, commitmentId: id, to: 'expired', actorKind: ACTOR }),
    ).rejects.toMatchObject({ from: 'resolved', to: 'expired' })
  })

  it('isolates commitments by tenant: B cannot transition A’s commitment (RLS)', async () => {
    const memId = await seedCommitmentMemory(userA, 'tenant a only')
    const { id } = await createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR })

    await expect(
      transitionCommitment({ userId: userB, commitmentId: id, to: 'resolved', actorKind: ACTOR }),
    ).rejects.toBeInstanceOf(CommitmentNotFoundError)

    // A's commitment is untouched.
    const row = await ownerPool.query('SELECT status FROM commitments WHERE id = $1', [id])
    expect(row.rows[0].status).toBe('open')
    // B sees no commitments under its own tenant context.
    const seenByB = await withTenant(userB, (tx) =>
      tx.select({ id: commitments.id }).from(commitments),
    )
    expect(seenByB).toHaveLength(0)
  })
})

describe('getCommitmentByMemoryId (memory -> commitment lookup, issue #117 D1)', () => {
  it('resolves the commitment riding a memory for the owning tenant', async () => {
    const memId = await seedCommitmentMemory(userA, 'lookup by memory')
    const { id } = await createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR })

    const found = await getCommitmentByMemoryId(userA, memId)

    expect(found).toEqual({ id, memoryId: memId, status: 'open' })
  })

  it('returns undefined when no commitment rides the memory', async () => {
    const memId = await seedTypedMemory(userA, 'note', 'no commitment here')
    expect(await getCommitmentByMemoryId(userA, memId)).toBeUndefined()
  })

  it('isolates by tenant: B cannot look up A’s commitment by memory id (RLS)', async () => {
    const memId = await seedCommitmentMemory(userA, 'a private commitment')
    await createCommitment({ userId: userA, memoryId: memId, actorKind: ACTOR })

    expect(await getCommitmentByMemoryId(userB, memId)).toBeUndefined()
  })
})
