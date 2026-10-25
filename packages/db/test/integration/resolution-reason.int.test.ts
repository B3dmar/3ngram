// SPDX-License-Identifier: Apache-2.0
// Integration — the optional resolve `reason` (issue #234) against the real
// runtime role (app_user, NOBYPASSRLS), so every tenant assertion is an RLS one.
//
// Storage contract (Sebastian's decision): the reason lives on the mutable,
// erasable `commitments.last_resolution_reason` column, NEVER in the
// append-only `memory_events.payload`. Proves:
//   - a transition WITH a reason stores it; one WITHOUT clears it (a reason
//     explains one transition) — for resolve, unresolve, waiting and expired,
//     and for the reasonless writers (sweep expiry, revise demote, an
//     accepted supersedes proposal whose successor is not a commitment)
//   - the audit event still carries ONLY the session provenance
//   - the revise carry moves the reason with the commitment row
//   - the DB length CHECK is a backstop generated from the schema bound
//   - the history read exposes it (null for non-commitments / moved rows) and
//     only to the owning tenant; a cross-tenant transition is still not found
import { MAX_RESOLUTION_REASON_LENGTH } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  applyProposal,
  CommitmentNotFoundError,
  closeDb,
  getMemoryHistory,
  insertProposals,
  reviseMemory,
  sweepCommitments,
  transitionCommitment,
  withTenant,
  writeMemory,
} from '../../src/index.js'
import { closePools, ownerPool, resetDomainTables, seedUser } from './helpers.js'

const ACTOR = 'user_api' as const
const REASON = 'shipped in PR #234'

let userA: string
let userB: string

beforeAll(async () => {
  userA = await seedUser('resolution-reason-a@test.local')
  userB = await seedUser('resolution-reason-b@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

/** A native commitment write: the memory plus its auto-created commitments row. */
async function seedCommitment(
  userId: string,
  tag: string,
): Promise<{ memoryId: string; commitmentId: string }> {
  const written = await writeMemory({
    userId,
    memoryType: 'commitment',
    topic: 'follow up',
    content: `commitment ${tag}`,
    scope: 'work',
    project: '3ngram',
    tags: [],
    contentHash: `hash-${tag}-${crypto.randomUUID()}`,
    actorKind: ACTOR,
  })
  if (written.commitmentId === undefined) throw new Error('expected an auto-created commitment')
  return { memoryId: written.id, commitmentId: written.commitmentId }
}

/** The stored reason, read as the owner (bypasses RLS on purpose — a probe). */
async function storedReason(commitmentId: string): Promise<string | null> {
  const r = await ownerPool.query('SELECT last_resolution_reason FROM commitments WHERE id = $1', [
    commitmentId,
  ])
  return r.rows[0].last_resolution_reason
}

/** Every lifecycle event payload on a memory, oldest first. */
async function eventPayloads(memoryId: string): Promise<Array<{ kind: string; payload: unknown }>> {
  const r = await ownerPool.query(
    `SELECT event_kind, payload FROM memory_events WHERE memory_id = $1 ORDER BY id`,
    [memoryId],
  )
  return r.rows.map((row) => ({ kind: row.event_kind, payload: row.payload }))
}

describe('transitionCommitment reason storage (#234)', () => {
  it('stores the reason on the row, never in the event payload', async () => {
    const { memoryId, commitmentId } = await seedCommitment(userA, 'store')

    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'resolved',
      actorKind: ACTOR,
      expectedFrom: 'open',
      resolutionReason: REASON,
    })

    expect(await storedReason(commitmentId)).toBe(REASON)
    const events = await eventPayloads(memoryId)
    expect(events.map((e) => e.kind)).toEqual(['create', 'resolve'])
    expect(JSON.stringify(events)).not.toContain(REASON)
  })

  it('clears the reason on a later transition that carries none (unresolve)', async () => {
    const { commitmentId } = await seedCommitment(userA, 'clear')
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'resolved',
      actorKind: ACTOR,
      resolutionReason: REASON,
    })

    await transitionCommitment({ userId: userA, commitmentId, to: 'open', actorKind: ACTOR })

    expect(await storedReason(commitmentId)).toBeNull()
  })

  it('replaces, never accumulates: each transition writes its own reason', async () => {
    const { commitmentId } = await seedCommitment(userA, 'replace')
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'waiting',
      actorKind: ACTOR,
      resolutionReason: 'waiting on review',
    })
    expect(await storedReason(commitmentId)).toBe('waiting on review')

    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'expired',
      actorKind: ACTOR,
      resolutionReason: 'deadline passed',
    })
    expect(await storedReason(commitmentId)).toBe('deadline passed')

    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'open',
      actorKind: ACTOR,
      resolutionReason: 'revived',
    })
    expect(await storedReason(commitmentId)).toBe('revived')
  })

  it('stamps the session run on the event payload and nothing else', async () => {
    const { memoryId, commitmentId } = await seedCommitment(userA, 'session')
    const runId = crypto.randomUUID()
    await ownerPool.query(
      `INSERT INTO agent_sessions
         (id, user_id, agent, session_id, source, project, selector, last_seen_at, activation_epoch)
       VALUES ($1, $2, 'codex', $3, 'startup', '3ngram', '{"kind":"all"}'::jsonb, now(), 1)`,
      [runId, userA, `sess-${runId}`],
    )

    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'resolved',
      actorKind: ACTOR,
      sessionRunId: runId,
      resolutionReason: REASON,
    })

    const resolveEvent = (await eventPayloads(memoryId)).find((e) => e.kind === 'resolve')
    expect(resolveEvent?.payload).toEqual({ sessionRunId: runId })
    expect(await storedReason(commitmentId)).toBe(REASON)
  })

  it('backstops the schema bound with a generated length CHECK', async () => {
    const { commitmentId } = await seedCommitment(userA, 'check')
    const atBound = 'x'.repeat(MAX_RESOLUTION_REASON_LENGTH)
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'waiting',
      actorKind: ACTOR,
      resolutionReason: atBound,
    })
    expect(await storedReason(commitmentId)).toBe(atBound)

    // Bypassing the Zod boundary: the DB still refuses an empty or oversize
    // reason, and the failed transition rolls back whole (status unchanged).
    for (const bad of ['', `${atBound}x`]) {
      await expect(
        transitionCommitment({
          userId: userA,
          commitmentId,
          to: 'open',
          actorKind: ACTOR,
          resolutionReason: bad,
        }),
      ).rejects.toThrow()
    }
    const r = await ownerPool.query('SELECT status FROM commitments WHERE id = $1', [commitmentId])
    expect(r.rows[0].status).toBe('waiting')
    expect(await storedReason(commitmentId)).toBe(atBound)
  })

  it("isolates by tenant: B cannot transition A's commitment, reason or not (RLS)", async () => {
    const { commitmentId } = await seedCommitment(userA, 'tenant')

    await expect(
      transitionCommitment({
        userId: userB,
        commitmentId,
        to: 'resolved',
        actorKind: ACTOR,
        resolutionReason: 'forged evidence',
      }),
    ).rejects.toBeInstanceOf(CommitmentNotFoundError)
    expect(await storedReason(commitmentId)).toBeNull()
  })
})

describe('reasonless writers clear a stale reason (#234)', () => {
  it('a sweep expiry clears the reason of the transition before it', async () => {
    const { commitmentId } = await seedCommitment(userA, 'sweep')
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'waiting',
      actorKind: ACTOR,
      resolutionReason: 'waiting on review',
    })
    await ownerPool.query(
      `UPDATE commitments SET due_at = now() - interval '1 day' WHERE id = $1`,
      [commitmentId],
    )

    const result = await withTenant(userA, (tx) => sweepCommitments(tx, userA, new Date()))

    expect(result.expired).toBe(1)
    expect(await storedReason(commitmentId)).toBeNull()
  })

  it('a revise demote (commitment -> note) resolves without a reason, clearing it', async () => {
    const { memoryId, commitmentId } = await seedCommitment(userA, 'demote')
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'waiting',
      actorKind: ACTOR,
      resolutionReason: 'waiting on review',
    })

    await reviseMemory({
      userId: userA,
      memoryType: 'note',
      topic: 'follow up',
      content: 'no longer an obligation',
      scope: 'work',
      project: '3ngram',
      tags: [],
      contentHash: `hash-demote-${crypto.randomUUID()}`,
      actorKind: ACTOR,
      predecessorId: memoryId,
      edgeType: 'supersedes',
    })

    const r = await ownerPool.query('SELECT status FROM commitments WHERE id = $1', [commitmentId])
    expect(r.rows[0].status).toBe('resolved')
    expect(await storedReason(commitmentId)).toBeNull()
  })

  it('an accepted supersedes proposal over a non-commitment successor resolves without a reason, clearing it', async () => {
    const { memoryId, commitmentId } = await seedCommitment(userA, 'proposal')
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'waiting',
      actorKind: ACTOR,
      resolutionReason: 'waiting on review',
    })
    const successor = await writeMemory({
      userId: userA,
      memoryType: 'note',
      topic: 'follow up',
      content: 'the follow-up happened',
      scope: 'work',
      project: '3ngram',
      tags: [],
      contentHash: `hash-proposal-${crypto.randomUUID()}`,
      actorKind: ACTOR,
    })
    await withTenant(userA, (tx) =>
      insertProposals(tx, [
        {
          userId: userA,
          fromId: successor.id,
          toId: memoryId,
          edgeType: 'supersedes',
          memoryType: 'commitment',
          similarity: 0.95,
        },
      ]),
    )
    const proposal = await ownerPool.query(
      'SELECT id FROM consolidation_proposals WHERE user_id = $1 AND to_id = $2',
      [userA, memoryId],
    )

    await withTenant(userA, (tx) => applyProposal(tx, userA, proposal.rows[0].id, ACTOR))

    const r = await ownerPool.query('SELECT status FROM commitments WHERE id = $1', [commitmentId])
    expect(r.rows[0].status).toBe('resolved')
    expect(await storedReason(commitmentId)).toBeNull()
  })

  it('a revise carry (commitment -> commitment) moves the reason with the row', async () => {
    const { memoryId, commitmentId } = await seedCommitment(userA, 'carry')
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'resolved',
      actorKind: ACTOR,
      resolutionReason: REASON,
    })

    const successor = await reviseMemory({
      userId: userA,
      memoryType: 'commitment',
      topic: 'follow up',
      content: 'commitment carry, reworded',
      scope: 'work',
      project: '3ngram',
      tags: [],
      contentHash: `hash-carry-${crypto.randomUUID()}`,
      actorKind: ACTOR,
      predecessorId: memoryId,
      edgeType: 'supersedes',
    })

    const r = await ownerPool.query(
      'SELECT memory_id, status, last_resolution_reason FROM commitments WHERE id = $1',
      [commitmentId],
    )
    expect(r.rows[0]).toEqual({
      memory_id: successor.id,
      status: 'resolved',
      last_resolution_reason: REASON,
    })
    // The history read follows the row: the successor reports it, the
    // superseded predecessor no longer has a commitment and reports null.
    const succHistory = await withTenant(userA, (tx) => getMemoryHistory(tx, successor.id))
    const predHistory = await withTenant(userA, (tx) => getMemoryHistory(tx, memoryId))
    expect(succHistory?.lastResolutionReason).toBe(REASON)
    expect(predHistory?.lastResolutionReason).toBeNull()
  })
})

describe('history read exposure (#234)', () => {
  it('returns the latest reason to the owner, null after a reasonless transition', async () => {
    const { memoryId, commitmentId } = await seedCommitment(userA, 'history')
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'resolved',
      actorKind: ACTOR,
      resolutionReason: REASON,
    })

    const resolved = await withTenant(userA, (tx) => getMemoryHistory(tx, memoryId))
    expect(resolved?.lastResolutionReason).toBe(REASON)

    await transitionCommitment({ userId: userA, commitmentId, to: 'open', actorKind: ACTOR })
    const reopened = await withTenant(userA, (tx) => getMemoryHistory(tx, memoryId))
    expect(reopened?.lastResolutionReason).toBeNull()
  })

  it('is null for a non-commitment memory', async () => {
    const note = await writeMemory({
      userId: userA,
      memoryType: 'note',
      topic: 'plain note',
      content: 'not an obligation',
      scope: 'work',
      project: '3ngram',
      tags: [],
      contentHash: `hash-note-${crypto.randomUUID()}`,
      actorKind: ACTOR,
    })
    const history = await withTenant(userA, (tx) => getMemoryHistory(tx, note.id))
    expect(history?.lastResolutionReason).toBeNull()
  })

  it("is invisible cross-tenant: B's history read of A's memory is absent", async () => {
    const { memoryId, commitmentId } = await seedCommitment(userA, 'cross')
    await transitionCommitment({
      userId: userA,
      commitmentId,
      to: 'resolved',
      actorKind: ACTOR,
      resolutionReason: REASON,
    })

    expect(await withTenant(userB, (tx) => getMemoryHistory(tx, memoryId))).toBeUndefined()
  })
})
