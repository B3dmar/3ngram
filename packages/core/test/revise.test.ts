// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. revise()'s validation boundary, content-hash computation,
// edge-intent -> edge-type mapping, and typed-error propagation, with
// packages/db's reviseMemory mocked. Integration coverage (atomicity, RLS,
// supersession tier-penalty, edge unique violation) lives in
// test/integration/revise.int.test.ts against real Postgres.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'

// zod is not a direct dependency of packages/core (validation lives in
// packages/schema); assert the rejection by Zod's stable error name instead of
// importing the class.
const expectZodRejection = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: 'ZodError' })

const reviseMemory = vi.fn()

class PredecessorNotFoundError extends Error {
  constructor() {
    super('predecessor memory not found for this tenant')
    this.name = 'PredecessorNotFoundError'
  }
}
class PredecessorAlreadySupersededError extends Error {
  constructor() {
    super('predecessor memory is already superseded')
    this.name = 'PredecessorAlreadySupersededError'
  }
}
class EdgeConflictError extends Error {
  constructor() {
    super('an edge of this type already links these memories for this tenant')
    this.name = 'EdgeConflictError'
  }
}
class DuplicateMemoryError extends Error {
  constructor() {
    super('memory with this content already exists for this tenant')
    this.name = 'DuplicateMemoryError'
  }
}

vi.mock('@3ngram/db', () => ({
  reviseMemory: (...args: unknown[]) => reviseMemory(...args),
  DuplicateMemoryError,
  EdgeConflictError,
  PredecessorNotFoundError,
  PredecessorAlreadySupersededError,
}))

const { revise } = await import('../src/write/revise.js')

const USER = '00000000-0000-7000-8000-000000000001'
const PREDECESSOR = '00000000-0000-7000-8000-0000000000aa'
const ACTOR = 'user_api' as const

const validInput = () => ({
  memoryType: 'note',
  topic: 'deploys',
  content: 'staging deploys now run on merge to main',
  tags: ['ops', 'ci'],
  predecessorId: PREDECESSOR,
})

const mockRevise = reviseMemory as unknown as Mock

afterEach(() => {
  mockRevise.mockReset()
})

describe('revise (validation boundary)', () => {
  it('rejects a missing predecessorId before any DB call', async () => {
    const { predecessorId: _drop, ...noPredecessor } = validInput()
    await expectZodRejection(revise(USER, noPredecessor, ACTOR))
    expect(mockRevise).not.toHaveBeenCalled()
  })

  it('rejects a non-uuid predecessorId before any DB call', async () => {
    await expectZodRejection(revise(USER, { ...validInput(), predecessorId: 'not-a-uuid' }, ACTOR))
    expect(mockRevise).not.toHaveBeenCalled()
  })

  it('rejects an edgeIntent outside the supersession family before any DB call', async () => {
    // 'extends'/'derives' are additive edges, not a revision — schema excludes them.
    await expectZodRejection(revise(USER, { ...validInput(), edgeIntent: 'extends' }, ACTOR))
    expect(mockRevise).not.toHaveBeenCalled()
  })

  it('rejects an unknown field (strict schema) before any DB call', async () => {
    await expectZodRejection(revise(USER, { ...validInput(), notARealField: 'x' }, ACTOR))
    expect(mockRevise).not.toHaveBeenCalled()
  })

  it('computes sha256(content) and maps edgeIntent -> edgeType for the db helper', async () => {
    mockRevise.mockResolvedValue({ id: 'successor-1' })
    const input = { ...validInput(), edgeIntent: 'updates' as const }

    const result = await revise(USER, input, ACTOR)

    // The result is the written id plus the additive ack-before-embed handle.
    expect(result.id).toBe('successor-1')
    expect(result.embed.settled).toBeInstanceOf(Promise)
    expect(mockRevise).toHaveBeenCalledTimes(1)
    const call = mockRevise.mock.calls[0]?.[0]
    expect(call.userId).toBe(USER)
    expect(call.actorKind).toBe(ACTOR)
    expect(call.predecessorId).toBe(PREDECESSOR)
    expect(call.edgeType).toBe('updates')
    expect(call.contentHash).toBe(createHash('sha256').update(input.content).digest('hex'))
  })

  it('defaults edgeIntent to supersedes when omitted', async () => {
    mockRevise.mockResolvedValue({ id: 'successor-2' })

    await revise(USER, validInput(), ACTOR)

    expect(mockRevise.mock.calls[0]?.[0].edgeType).toBe('supersedes')
  })
})

describe('revise (typed errors)', () => {
  it('propagates PredecessorNotFoundError without swallowing it', async () => {
    mockRevise.mockRejectedValue(new PredecessorNotFoundError())
    await expect(revise(USER, validInput(), ACTOR)).rejects.toBeInstanceOf(PredecessorNotFoundError)
  })

  it('propagates PredecessorAlreadySupersededError without swallowing it', async () => {
    mockRevise.mockRejectedValue(new PredecessorAlreadySupersededError())
    await expect(revise(USER, validInput(), ACTOR)).rejects.toBeInstanceOf(
      PredecessorAlreadySupersededError,
    )
  })

  it('propagates EdgeConflictError without swallowing it', async () => {
    mockRevise.mockRejectedValue(new EdgeConflictError())
    await expect(revise(USER, validInput(), ACTOR)).rejects.toBeInstanceOf(EdgeConflictError)
  })

  it('propagates DuplicateMemoryError without swallowing it', async () => {
    mockRevise.mockRejectedValue(new DuplicateMemoryError())
    await expect(revise(USER, validInput(), ACTOR)).rejects.toBeInstanceOf(DuplicateMemoryError)
  })
})
