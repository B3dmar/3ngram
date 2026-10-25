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
// Write-scope policy read (issue #235): null = no stored row = mode 'off'.
const getWriteScopePolicy = vi.fn(async (_tx: unknown, _userId: string): Promise<unknown> => null)
const listScopes = vi.fn(async (_tx: unknown, _userId: string): Promise<unknown[]> => [])
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
  fn({ kind: 'tenant-tx' }),
)

vi.mock('@3ngram/db', () => ({
  writeMemory: (...args: unknown[]) => writeMemory(...args),
  getWriteScopePolicy: (tx: unknown, userId: string) => getWriteScopePolicy(tx, userId),
  listScopes: (tx: unknown, userId: string) => listScopes(tx, userId),
  withTenant: (userId: string, fn: (tx: unknown) => Promise<unknown>) => withTenant(userId, fn),
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
  UnknownSessionRunError: class UnknownSessionRunError extends Error {
    readonly sessionRunId: string
    constructor(sessionRunId: string) {
      super('session run is not owned by this tenant')
      this.name = 'UnknownSessionRunError'
      this.sessionRunId = sessionRunId
    }
  },
}))

const { DuplicateMemoryError, remember } = await import('../src/write/remember.js')
const { UnscopedWriteError } = await import('../src/scope/write-policy.js')

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
  getWriteScopePolicy.mockReset()
  getWriteScopePolicy.mockResolvedValue(null)
  withTenant.mockClear()
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
    // No scope and no stored write policy: the shipped 'personal' literal,
    // applied by core's write-scope resolution (issue #235), echoed on the result.
    expect(call.scope).toBe('personal')
    expect(result.scope).toBe('personal')
  })

  it('forwards sessionRunId on the native write', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-session' })
    const runId = '01890b6e-0000-7000-8000-000000000001'
    await remember(USER, { ...validInput(), sessionRunId: runId }, ACTOR)
    expect(mockWrite.mock.calls[0]?.[0].sessionRunId).toBe(runId)
  })

  it('validates and forwards the live-memory cap to the transactional db write', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-limited' })
    const limits = vi.fn().mockResolvedValue({ maxLiveMemories: 7 })

    await remember(USER, validInput(), ACTOR, { limits })

    expect(limits).toHaveBeenCalledExactlyOnceWith(USER)
    // Third positional arg is the optional facts list — undefined here, which
    // is what keeps a write without facts identical to the shipped call.
    expect(mockWrite).toHaveBeenCalledWith(expect.any(Object), 7, undefined)
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

  it('converts an explicit commitment deadline to a Date and forwards the owner (issue #165)', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-5', commitmentId: 'commit-5' })

    await remember(
      USER,
      {
        ...validInput(),
        memoryType: 'commitment',
        dueAt: '2026-11-30T17:00:00.000Z',
        owner: 'sebastian',
      },
      ACTOR,
    )

    const call = mockWrite.mock.calls[0]?.[0]
    expect(call.commitment.dueAt).toEqual(new Date('2026-11-30T17:00:00.000Z'))
    expect(call.commitment.owner).toBe('sebastian')
  })

  it('writes an undated commitment with no deadline, never an inferred one', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-6', commitmentId: 'commit-6' })
    const input = { ...validInput(), memoryType: 'commitment', content: 'ship it by next Friday' }

    await remember(USER, input, ACTOR)

    const call = mockWrite.mock.calls[0]?.[0]
    expect(call.commitment.dueAt).toBeUndefined()
    expect(call.commitment.owner).toBeUndefined()
  })

  it('rejects a deadline on a non-commitment before any DB call', async () => {
    await expectZodRejection(
      remember(USER, { ...validInput(), dueAt: '2026-11-30T17:00:00Z' }, ACTOR),
    )
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('leaves commitmentId undefined for a non-commitment memory', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-4' })

    const result = await remember(USER, validInput(), ACTOR)

    expect(result.commitmentId).toBeUndefined()
  })
})

describe('remember (structured facts)', () => {
  const fact = { subject: 'lift.back_squat', predicate: 'top_set.weight_kg', value: '98' }

  it('forwards parsed facts to the db write and surfaces the returned factIds', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-5', factIds: ['fact-1'] })

    const result = await remember(USER, { ...validInput(), facts: [fact] }, ACTOR)

    // Facts ride the SAME db call as the memory — core adds no second write.
    expect(mockWrite).toHaveBeenCalledTimes(1)
    expect(mockWrite.mock.calls[0]?.[2]).toEqual([fact])
    expect(result.factIds).toEqual(['fact-1'])
  })

  it('coerces fact timestamps at the boundary, so db receives Dates', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-6', factIds: ['fact-2'] })

    await remember(
      USER,
      { ...validInput(), facts: [{ ...fact, validFrom: '2026-01-01T00:00:00.000Z' }] },
      ACTOR,
    )

    expect(mockWrite.mock.calls[0]?.[2]?.[0].validFrom).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    )
  })

  it('passes no facts and returns no factIds when the key is omitted or empty', async () => {
    mockWrite.mockResolvedValue({ id: 'mem-7' })
    const omitted = await remember(USER, validInput(), ACTOR)
    expect(mockWrite.mock.calls[0]?.[2]).toBeUndefined()
    expect(omitted.factIds).toBeUndefined()

    mockWrite.mockResolvedValue({ id: 'mem-8' })
    const empty = await remember(USER, { ...validInput(), facts: [] }, ACTOR)
    // The empty list is threaded through as an empty list (core does not
    // normalize it away); the db layer is what collapses it to "no factIds",
    // so both halves are pinned.
    expect(mockWrite.mock.calls[1]?.[2]).toEqual([])
    expect(empty.factIds).toBeUndefined()
  })

  it('rejects an invalid fact before any DB call', async () => {
    await expectZodRejection(
      remember(USER, { ...validInput(), facts: [{ ...fact, value: '' }] }, ACTOR),
    )
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('rejects a validTo with no validFrom before any DB call', async () => {
    await expectZodRejection(
      remember(
        USER,
        { ...validInput(), facts: [{ ...fact, validTo: '2026-01-01T00:00:00.000Z' }] },
        ACTOR,
      ),
    )
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('rejects more than the per-write fact ceiling before any DB call', async () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ ...fact, predicate: `p${i}` }))
    await expectZodRejection(remember(USER, { ...validInput(), facts: many }, ACTOR))
    expect(mockWrite).not.toHaveBeenCalled()
  })
})

describe('remember (typed duplicate error)', () => {
  it('propagates DuplicateMemoryError without swallowing it', async () => {
    mockWrite.mockRejectedValue(new DuplicateMemoryError('abc123'))

    await expect(remember(USER, validInput(), ACTOR)).rejects.toBeInstanceOf(DuplicateMemoryError)
  })
})

describe('remember (write-scope policy, issue #235)', () => {
  const policy = (mode: string, defaultScope: string | null) => ({
    mode,
    defaultScope,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  })
  // Every injected guard a write can charge or consult, as spies.
  const guards = () => ({
    access: {
      assertRead: vi.fn(async (_userId: string) => undefined),
      assertWrite: vi.fn(async (_userId: string) => undefined),
    },
    budget: {
      config: { defaultCapUsd: 1, defaultWindowDays: 30 },
      resolveLimits: vi.fn(async (_userId: string) => ({})),
    },
    limits: vi.fn(async (_userId: string) => ({})),
  })

  it("mode 'off' (stored row) writes the shipped 'personal' literal", async () => {
    getWriteScopePolicy.mockResolvedValue(policy('off', null))
    mockWrite.mockResolvedValue({ id: 'mem-off' })

    const result = await remember(USER, validInput(), ACTOR)

    expect(mockWrite.mock.calls[0]?.[0].scope).toBe('personal')
    expect(result.scope).toBe('personal')
  })

  it("mode 'default' fills an omitted scope with the configured scope", async () => {
    getWriteScopePolicy.mockResolvedValue(policy('default', 'work'))
    mockWrite.mockResolvedValue({ id: 'mem-default' })

    const result = await remember(USER, validInput(), ACTOR)

    expect(mockWrite.mock.calls[0]?.[0].scope).toBe('work')
    expect(result.scope).toBe('work')
    // One tenant-scoped read, keyed by the authenticated user id.
    expect(withTenant).toHaveBeenCalledExactlyOnceWith(USER, expect.any(Function))
    expect(getWriteScopePolicy).toHaveBeenCalledExactlyOnceWith({ kind: 'tenant-tx' }, USER)
  })

  it.each([
    ['default', 'work'],
    ['require', null],
  ])("an explicit scope wins under mode '%s' and skips the policy read", async (mode, scope) => {
    getWriteScopePolicy.mockResolvedValue(policy(mode, scope))
    mockWrite.mockResolvedValue({ id: 'mem-explicit' })

    const result = await remember(USER, { ...validInput(), scope: 'client-x' }, ACTOR)

    expect(mockWrite.mock.calls[0]?.[0].scope).toBe('client-x')
    expect(result.scope).toBe('client-x')
    expect(getWriteScopePolicy).not.toHaveBeenCalled()
  })

  it("an explicit 'personal' under mode 'default' stays 'personal' (omission is not explicit input)", async () => {
    getWriteScopePolicy.mockResolvedValue(policy('default', 'work'))
    mockWrite.mockResolvedValue({ id: 'mem-personal' })

    await remember(USER, { ...validInput(), scope: 'personal' }, ACTOR)

    expect(mockWrite.mock.calls[0]?.[0].scope).toBe('personal')
  })

  it("mode 'require' rejects an omitted scope before access, budget, limits, or any write", async () => {
    getWriteScopePolicy.mockResolvedValue(policy('require', null))
    listScopes.mockResolvedValue([{ name: 'personal' }, { name: 'work' }])
    const opts = guards()

    const rejection = remember(USER, validInput(), ACTOR, opts)

    await expect(rejection).rejects.toBeInstanceOf(UnscopedWriteError)
    // Transport-neutral recovery: "pass scope" plus the registered names, so
    // the fix is actionable over REST as well as MCP.
    await expect(rejection).rejects.toThrow(/pass scope; registered scopes: personal, work$/)
    // Same tenant transaction as the policy read, keyed by the caller.
    expect(listScopes).toHaveBeenCalledExactlyOnceWith({ kind: 'tenant-tx' }, USER)
    expect(withTenant).toHaveBeenCalledOnce()
    expect(opts.access.assertWrite).not.toHaveBeenCalled()
    expect(opts.budget.resolveLimits).not.toHaveBeenCalled()
    expect(opts.limits).not.toHaveBeenCalled()
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('the rejection message carries no memory content', async () => {
    getWriteScopePolicy.mockResolvedValue(policy('require', null))

    const error = await remember(USER, validInput(), ACTOR).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(UnscopedWriteError)
    expect((error as Error).message).not.toContain(validInput().content)
    expect((error as Error).message).not.toContain(validInput().topic)
  })

  it('a malformed payload is rejected before the policy is read', async () => {
    await expectZodRejection(remember(USER, { ...validInput(), topic: '' }, ACTOR))
    expect(getWriteScopePolicy).not.toHaveBeenCalled()
  })
})
