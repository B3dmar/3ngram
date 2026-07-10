// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. remember()'s validation boundary, content-hash
// computation, and typed duplicate-error propagation, with packages/db's
// writeMemory mocked. Integration coverage (atomicity, RLS, tags round-trip)
// lives in test/integration/remember.int.test.ts against real Postgres.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'

// zod is not a direct dependency of packages/core (validation lives in
// packages/schema); assert the rejection by Zod's stable error name instead of
// importing the class.
const expectZodRejection = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: 'ZodError' })

const writeMemory = vi.fn()

vi.mock('@3ngram/db', () => ({
  writeMemory: (...args: unknown[]) => writeMemory(...args),
  // remember.ts re-exports DuplicateMemoryError from @3ngram/db; the real class
  // is needed so `instanceof` and `.name` assertions hold.
  DuplicateMemoryError: class DuplicateMemoryError extends Error {
    readonly contentHash: string
    constructor(contentHash: string) {
      super('memory with this content already exists for this tenant')
      this.name = 'DuplicateMemoryError'
      this.contentHash = contentHash
    }
  },
}))

const { DuplicateMemoryError, remember } = await import('../src/write/remember.js')

const USER = '00000000-0000-7000-8000-000000000001'
const ACTOR = 'user_api' as const

const validInput = () => ({
  memoryType: 'note',
  topic: 'deploys',
  content: 'staging deploys run on merge to staging',
  tags: ['ops', 'ci'],
})

const mockWrite = writeMemory as unknown as Mock

afterEach(() => {
  mockWrite.mockReset()
})

describe('remember (validation boundary)', () => {
  it('rejects an empty topic before any DB call', async () => {
    await expectZodRejection(remember(USER, { ...validInput(), topic: '' }, ACTOR))
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('rejects an unknown field (strict schema) before any DB call', async () => {
    await expectZodRejection(remember(USER, { ...validInput(), notARealField: 'x' }, ACTOR))
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('rejects more than the tag ceiling before any DB call', async () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `t${i}`)
    await expectZodRejection(remember(USER, { ...validInput(), tags: tooMany }, ACTOR))
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('computes sha256(content) and forwards parsed tags + actor to the db helper', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-1' })
    const input = validInput()

    const result = await remember(USER, input, ACTOR)

    // The result is the written id plus the additive ack-before-embed handle.
    expect(result.id).toBe('mem-1')
    expect(result.embed.settled).toBeInstanceOf(Promise)
    expect(mockWrite).toHaveBeenCalledTimes(1)
    const call = mockWrite.mock.calls[0]?.[0]
    expect(call.userId).toBe(USER)
    expect(call.actorKind).toBe(ACTOR)
    expect(call.tags).toEqual(['ops', 'ci'])
    expect(call.contentHash).toBe(createHash('sha256').update(input.content).digest('hex'))
    // scope defaults at the schema boundary, not in core
    expect(call.scope).toBe('personal')
  })

  it('validates and forwards the live-memory cap to the transactional db write', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-limited' })
    const limits = vi.fn().mockResolvedValue({ maxLiveMemories: 7 })

    await remember(USER, validInput(), ACTOR, { limits })

    expect(limits).toHaveBeenCalledExactlyOnceWith(USER)
    expect(mockWrite).toHaveBeenCalledWith(expect.any(Object), 7)
  })

  it('fails closed on an invalid injected live-memory cap', async () => {
    const limits = vi.fn().mockResolvedValue({ maxLiveMemories: Number.POSITIVE_INFINITY })

    await expectZodRejection(remember(USER, validInput(), ACTOR, { limits }))
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('defaults tags to [] when omitted', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-2' })
    const { tags: _drop, ...noTags } = validInput()

    await remember(USER, noTags, ACTOR)

    expect(mockWrite.mock.calls[0]?.[0].tags).toEqual([])
  })

  it('surfaces the auto-created commitmentId the db helper returns', async () => {
    // The db layer auto-creates an 'open' commitment for a commitment-type memory
    // in the same tx and returns its id; remember() passes
    // it through untouched alongside the additive embed handle.
    mockWrite.mockResolvedValue({ id: 'mem-3', commitmentId: 'commit-1' })

    const result = await remember(USER, { ...validInput(), memoryType: 'commitment' }, ACTOR)

    expect(result.id).toBe('mem-3')
    expect(result.commitmentId).toBe('commit-1')
  })

  it('leaves commitmentId undefined for a non-commitment memory', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-4' })

    const result = await remember(USER, validInput(), ACTOR)

    expect(result.commitmentId).toBeUndefined()
  })
})

describe('remember (typed duplicate error)', () => {
  it('propagates DuplicateMemoryError without swallowing it', async () => {
    mockWrite.mockRejectedValue(new DuplicateMemoryError('abc123'))

    await expect(remember(USER, validInput(), ACTOR)).rejects.toBeInstanceOf(DuplicateMemoryError)
  })
})
