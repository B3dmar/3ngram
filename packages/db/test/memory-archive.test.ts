// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. LOCK ORDER of the two archive helpers (Codex P2).
//
// resolveSessionProvenance may take the tenant/project attach advisory lock;
// reviseMemory therefore resolves provenance BEFORE it locks any memory row.
// The archive helpers used to do the opposite (UPDATE ... RETURNING project,
// then provenance), an AB-BA inversion that deadlocked an omitted-id archive
// against a concurrent revise on the same project. A deadlock is not
// deterministically reproducible in a test, so what is pinned here is the
// property that prevents it: the ORDER of operations, plus the not-found and
// lost-race semantics the unlocked SELECT has to preserve.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryEvents } from '../src/schema/memory.js'

const fakeTxSentinel = { kind: 'fake-tx' as const }
const withTenant = vi.fn(
  async (_userId: string, fn: (tx: typeof fakeTxSentinel) => Promise<unknown>) =>
    fn(fakeTxSentinel),
)
vi.mock('../src/client.js', () => ({ withTenant: (...a: unknown[]) => withTenant(...a) }))

// Ops are recorded through the module boundary: the fake tx cannot see the
// advisory lock resolveSessionProvenance takes internally, so the call itself is
// the ordering marker.
let ops: string[] = []
vi.mock('../src/session-provenance.js', () => ({
  resolveSessionProvenance: async () => {
    ops.push('provenance')
    return RUN_ID
  },
  sessionPayload: (id: string | undefined) => (id === undefined ? undefined : { sessionRunId: id }),
  UnknownSessionRunError: class UnknownSessionRunError extends Error {},
}))
vi.mock('../src/memory-write.js', () => ({
  insertMemoryWithEvent: async () => ({ id: MEMORY_ID }),
  DuplicateMemoryError: class DuplicateMemoryError extends Error {},
}))
vi.mock('../src/memory-edges.js', () => ({
  insertEdge: async () => undefined,
  EdgeConflictError: class EdgeConflictError extends Error {},
}))
vi.mock('../src/pg-errors.js', () => ({ isUniqueViolation: () => false }))

const { ActiveMemoryNotFoundError, archiveBlockerMemory, archiveMemory, BlockerNotFoundError } =
  await import('../src/memory-revise.js')

const USER = '00000000-0000-7000-8000-000000000001'
const MEMORY_ID = '00000000-0000-7000-8000-0000000000aa'
const RUN_ID = '01890b6e-0000-7000-8000-0000000000bb'
const NOW = new Date('2026-08-21T12:00:00.000Z')

/**
 * Fake tenant tx recording an ordered op log. `found` drives the pre-lock
 * project SELECT; `updateHits` drives the guarded UPDATE's `.returning()`, so a
 * hit-then-miss models a concurrent archive winning between the two.
 */
function makeTx(opts: { found: boolean; updateHits?: boolean }) {
  const inserts: { table: unknown; values: Record<string, unknown> }[] = []
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            ops.push('select')
            return opts.found ? [{ project: '3ngram' }] : []
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () =>
          Object.assign(Promise.resolve(undefined), {
            returning: async () => {
              ops.push('update')
              return opts.updateHits === false ? [] : [{ id: MEMORY_ID }]
            },
          }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        ops.push('insert')
        inserts.push({ table, values })
        return Promise.resolve(undefined)
      },
    }),
  }
  withTenant.mockImplementationOnce(async (_u: string, fn) =>
    fn(tx as unknown as typeof fakeTxSentinel),
  )
  return { inserts }
}

afterEach(() => {
  ops = []
  withTenant.mockClear()
})

const cases = [
  {
    name: 'archiveMemory',
    run: () => archiveMemory(USER, MEMORY_ID, 'user_api', RUN_ID, NOW),
    notFound: ActiveMemoryNotFoundError,
  },
  {
    name: 'archiveBlockerMemory',
    run: () => archiveBlockerMemory(USER, MEMORY_ID, 'user_api', RUN_ID, NOW),
    notFound: BlockerNotFoundError,
  },
] as const

describe.each(cases)('$name lock order', ({ run, notFound }) => {
  it('resolves provenance BEFORE the memory row UPDATE', async () => {
    const { inserts } = makeTx({ found: true })

    await expect(run()).resolves.toEqual({ id: MEMORY_ID, status: 'archived' })

    // The unlocked project SELECT, then the advisory-lock-taking provenance
    // resolution, then the row lock. Never provenance after the UPDATE.
    expect(ops).toEqual(['select', 'provenance', 'update', 'insert'])
    const events = inserts.filter((i) => i.table === memoryEvents)
    expect(events).toHaveLength(1)
    expect(events[0]?.values).toMatchObject({
      eventKind: 'archive',
      payload: { sessionRunId: RUN_ID },
    })
  })

  it('throws not-found from the SELECT without resolving provenance or writing', async () => {
    makeTx({ found: false })

    await expect(run()).rejects.toBeInstanceOf(notFound)

    expect(ops).toEqual(['select'])
  })

  it('throws not-found when a concurrent archive wins between the SELECT and the UPDATE', async () => {
    // The SELECT took no row lock, so the guard on the UPDATE is load-bearing:
    // zero rows must stay the same typed error the single-UPDATE version raised,
    // and no audit event may be appended.
    const { inserts } = makeTx({ found: true, updateHits: false })

    await expect(run()).rejects.toBeInstanceOf(notFound)

    expect(ops).toEqual(['select', 'provenance', 'update'])
    expect(inserts).toHaveLength(0)
  })
})
