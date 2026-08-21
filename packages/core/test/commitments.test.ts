// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. The commitment FSM orchestration: core validates a
// transition via the SCHEMA's canTransition BEFORE any db call (hard rule 2),
// so the db transition helper is mocked and asserted called / not-called.
// Integration coverage (trigger backstop, resolved_at, events, cross-tenant)
// lives in test/integration/commitments.int.test.ts against real Postgres.
import { COMMITMENT_TRANSITIONS, type CommitmentStatus } from '@3ngram/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getCommitment = vi.fn()
const getCommitmentByMemoryId = vi.fn()
const dbCreateCommitment = vi.fn()
const dbTransitionCommitment = vi.fn()
const getMemoryById = vi.fn()
const archiveBlockerMemory = vi.fn()

// withTenant runs the body against a fake tx; the body only forwards to
// getMemoryById (also mocked), so a stub tx object suffices.
const FAKE_TX = { __tx: true }

vi.mock('@3ngram/db', () => ({
  getCommitment: (...a: unknown[]) => getCommitment(...a),
  getCommitmentByMemoryId: (...a: unknown[]) => getCommitmentByMemoryId(...a),
  createCommitment: (...a: unknown[]) => dbCreateCommitment(...a),
  transitionCommitment: (...a: unknown[]) => dbTransitionCommitment(...a),
  getMemoryById: (...a: unknown[]) => getMemoryById(...a),
  archiveBlockerMemory: (...a: unknown[]) => archiveBlockerMemory(...a),
  withTenant: (_userId: string, fn: (tx: unknown) => unknown) => fn(FAKE_TX),
  CommitmentNotFoundError: class CommitmentNotFoundError extends Error {
    readonly commitmentId: string
    readonly keyedBy: string
    constructor(commitmentId: string, keyedBy = 'commitment') {
      super('commitment not found for this tenant')
      this.name = 'CommitmentNotFoundError'
      this.commitmentId = commitmentId
      this.keyedBy = keyedBy
    }
  },
  BlockerNotFoundError: class BlockerNotFoundError extends Error {
    readonly memoryId: string
    constructor(memoryId: string) {
      super('no active blocker memory found for this tenant')
      this.name = 'BlockerNotFoundError'
      this.memoryId = memoryId
    }
  },
  CommitmentExistsError: class CommitmentExistsError extends Error {
    constructor() {
      super('exists')
      this.name = 'CommitmentExistsError'
    }
  },
  IllegalCommitmentTransitionError: class IllegalCommitmentTransitionError extends Error {
    constructor() {
      super('illegal')
      this.name = 'IllegalCommitmentTransitionError'
    }
  },
}))

const {
  BlockerNotFoundError,
  CommitmentNotFoundError,
  createCommitment,
  InvalidCommitmentTransitionError,
  resolveByMemoryId,
  transition,
} = await import('../src/write/commitments.js')

const USER = '00000000-0000-7000-8000-000000000001'
const MEMORY = '00000000-0000-7000-8000-0000000000aa'
const COMMITMENT = '00000000-0000-7000-8000-0000000000bb'
const ACTOR = 'user_api' as const

const ALL_STATUSES = Object.keys(COMMITMENT_TRANSITIONS) as CommitmentStatus[]

afterEach(() => {
  getCommitment.mockReset()
  getCommitmentByMemoryId.mockReset()
  dbCreateCommitment.mockReset()
  dbTransitionCommitment.mockReset()
  getMemoryById.mockReset()
  archiveBlockerMemory.mockReset()
})

describe('createCommitment', () => {
  it('forwards memoryId, actor, and metadata to the db helper', async () => {
    dbCreateCommitment.mockResolvedValue({ id: COMMITMENT, status: 'open' })
    const due = new Date('2026-07-01T00:00:00Z')

    const result = await createCommitment(USER, MEMORY, ACTOR, { owner: 'seb', dueAt: due })

    expect(result).toEqual({ id: COMMITMENT, status: 'open' })
    const call = dbCreateCommitment.mock.calls[0]?.[0]
    expect(call.userId).toBe(USER)
    expect(call.memoryId).toBe(MEMORY)
    expect(call.actorKind).toBe(ACTOR)
    expect(call.owner).toBe('seb')
    expect(call.dueAt).toBe(due)
  })
})

describe('transition (schema FSM validation, every legal/illegal pair)', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (from === to) continue
      const legal = (COMMITMENT_TRANSITIONS[from] as readonly CommitmentStatus[]).includes(to)

      it(`${legal ? 'allows' : 'rejects'} ${from} -> ${to}`, async () => {
        getCommitment.mockResolvedValue({ id: COMMITMENT, memoryId: MEMORY, status: from })
        dbTransitionCommitment.mockResolvedValue({ id: COMMITMENT, status: to })

        if (legal) {
          const result = await transition(USER, COMMITMENT, to, ACTOR)
          expect(result).toEqual({ id: COMMITMENT, status: to })
          expect(dbTransitionCommitment).toHaveBeenCalledTimes(1)
          expect(dbTransitionCommitment.mock.calls[0]?.[0]).toMatchObject({ to })
        } else {
          await expect(transition(USER, COMMITMENT, to, ACTOR)).rejects.toBeInstanceOf(
            InvalidCommitmentTransitionError,
          )
          // The illegal pair NEVER reaches the DB — core is the primary guard.
          expect(dbTransitionCommitment).not.toHaveBeenCalled()
        }
      })
    }
  }

  it('treats a same-state transition as a no-op success (no db write)', async () => {
    getCommitment.mockResolvedValue({ id: COMMITMENT, memoryId: MEMORY, status: 'open' })

    const result = await transition(USER, COMMITMENT, 'open', ACTOR)

    expect(result).toEqual({ id: COMMITMENT, status: 'open' })
    expect(dbTransitionCommitment).not.toHaveBeenCalled()
  })

  it('throws CommitmentNotFoundError when the commitment is absent (RLS)', async () => {
    getCommitment.mockResolvedValue(undefined)

    await expect(transition(USER, COMMITMENT, 'resolved', ACTOR)).rejects.toBeInstanceOf(
      CommitmentNotFoundError,
    )
    expect(dbTransitionCommitment).not.toHaveBeenCalled()
  })

  it('carries the real from/to on the validation error', async () => {
    getCommitment.mockResolvedValue({ id: COMMITMENT, memoryId: MEMORY, status: 'resolved' })

    // resolved -> expired is illegal (resolved only -> open).
    await expect(transition(USER, COMMITMENT, 'expired', ACTOR)).rejects.toMatchObject({
      name: 'InvalidCommitmentTransitionError',
      from: 'resolved',
      to: 'expired',
    })
  })
})

describe('resolveByMemoryId (memory-keyed transition for the resolve tool)', () => {
  it('resolves memory -> commitment, then applies the FSM-validated transition', async () => {
    getCommitmentByMemoryId.mockResolvedValue({ id: COMMITMENT, memoryId: MEMORY, status: 'open' })
    dbTransitionCommitment.mockResolvedValue({ id: COMMITMENT, status: 'resolved' })

    const result = await resolveByMemoryId(USER, MEMORY, 'resolved', ACTOR)

    expect(result).toEqual({ id: COMMITMENT, status: 'resolved' })
    expect(getCommitmentByMemoryId.mock.calls[0]).toEqual([USER, MEMORY])
    // The transition targets the RESOLVED commitment id, not the memory id.
    expect(dbTransitionCommitment.mock.calls[0]?.[0]).toMatchObject({
      commitmentId: COMMITMENT,
      to: 'resolved',
    })
  })

  it('serves unresolve: resolved -> open is legal and reaches the db', async () => {
    getCommitmentByMemoryId.mockResolvedValue({
      id: COMMITMENT,
      memoryId: MEMORY,
      status: 'resolved',
    })
    dbTransitionCommitment.mockResolvedValue({ id: COMMITMENT, status: 'open' })

    const result = await resolveByMemoryId(USER, MEMORY, 'open', ACTOR)

    expect(result).toEqual({ id: COMMITMENT, status: 'open' })
    expect(dbTransitionCommitment).toHaveBeenCalledTimes(1)
  })

  it('throws CommitmentNotFoundError when no commitment rides the memory and it is not a blocker', async () => {
    getCommitmentByMemoryId.mockResolvedValue(undefined)
    // A non-blocker memory (e.g. a decision) with no commitment: not resolvable.
    getMemoryById.mockResolvedValue({ id: MEMORY, memoryType: 'decision', status: 'active' })

    await expect(resolveByMemoryId(USER, MEMORY, 'resolved', ACTOR)).rejects.toBeInstanceOf(
      CommitmentNotFoundError,
    )
    expect(dbTransitionCommitment).not.toHaveBeenCalled()
    expect(archiveBlockerMemory).not.toHaveBeenCalled()
  })

  it('throws CommitmentNotFoundError when the memory id is absent / not owned (RLS)', async () => {
    getCommitmentByMemoryId.mockResolvedValue(undefined)
    // RLS hides cross-tenant rows: getMemoryById returns undefined.
    getMemoryById.mockResolvedValue(undefined)

    await expect(resolveByMemoryId(USER, MEMORY, 'resolved', ACTOR)).rejects.toBeInstanceOf(
      CommitmentNotFoundError,
    )
    expect(archiveBlockerMemory).not.toHaveBeenCalled()
  })

  it('archives a BLOCKER memory (no commitment) instead of throwing — issue #271', async () => {
    getCommitmentByMemoryId.mockResolvedValue(undefined)
    getMemoryById.mockResolvedValue({ id: MEMORY, memoryType: 'blocker', status: 'active' })
    archiveBlockerMemory.mockResolvedValue({ id: MEMORY, status: 'archived' })

    const result = await resolveByMemoryId(USER, MEMORY, 'resolved', ACTOR)

    expect(result).toEqual({ id: MEMORY, status: 'archived' })
    expect(archiveBlockerMemory.mock.calls[0]).toEqual([USER, MEMORY, ACTOR, undefined])
    // The commitment FSM path is NOT touched for a blocker.
    expect(dbTransitionCommitment).not.toHaveBeenCalled()
  })

  it('ignores the requested status for a blocker — any target archives it', async () => {
    getCommitmentByMemoryId.mockResolvedValue(undefined)
    getMemoryById.mockResolvedValue({ id: MEMORY, memoryType: 'blocker', status: 'active' })
    archiveBlockerMemory.mockResolvedValue({ id: MEMORY, status: 'archived' })

    // Pass 'expired' — for a blocker it still archives (the status is ignored).
    const result = await resolveByMemoryId(USER, MEMORY, 'expired', ACTOR)

    expect(result.status).toBe('archived')
    expect(archiveBlockerMemory).toHaveBeenCalledTimes(1)
  })

  it('maps a lost blocker-archive race (BlockerNotFoundError) to CommitmentNotFoundError', async () => {
    getCommitmentByMemoryId.mockResolvedValue(undefined)
    getMemoryById.mockResolvedValue({ id: MEMORY, memoryType: 'blocker', status: 'active' })
    archiveBlockerMemory.mockRejectedValue(new BlockerNotFoundError(MEMORY))

    await expect(resolveByMemoryId(USER, MEMORY, 'resolved', ACTOR)).rejects.toBeInstanceOf(
      CommitmentNotFoundError,
    )
  })

  it('rejects an illegal transition BEFORE the db, with the real from/to', async () => {
    getCommitmentByMemoryId.mockResolvedValue({
      id: COMMITMENT,
      memoryId: MEMORY,
      status: 'resolved',
    })

    await expect(resolveByMemoryId(USER, MEMORY, 'expired', ACTOR)).rejects.toMatchObject({
      name: 'InvalidCommitmentTransitionError',
      from: 'resolved',
      to: 'expired',
    })
    expect(dbTransitionCommitment).not.toHaveBeenCalled()
  })

  it('treats a same-state transition as a no-op success (no db write)', async () => {
    getCommitmentByMemoryId.mockResolvedValue({ id: COMMITMENT, memoryId: MEMORY, status: 'open' })

    const result = await resolveByMemoryId(USER, MEMORY, 'open', ACTOR)

    expect(result).toEqual({ id: COMMITMENT, status: 'open' })
    expect(dbTransitionCommitment).not.toHaveBeenCalled()
  })
})
