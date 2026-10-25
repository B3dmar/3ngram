// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. The archive (issue #217) and reaffirm (issue #218)
// dispositions' ORDER OF OPERATIONS and their per-row verdicts. A deadlock or a lost race is not
// deterministically reproducible against Postgres, so what is pinned here is the
// property that prevents each: the account guard first, provenance before the
// row lock, the decision re-made under the lock, and no write or event for a
// row that is not archived. The integration suites prove the SQL.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitments, memoryEvents } from '../src/schema/memory.js'

const fakeTxSentinel = { kind: 'fake-tx' as const }
const withTenant = vi.fn(
  async (_userId: string, fn: (tx: typeof fakeTxSentinel) => Promise<unknown>) =>
    fn(fakeTxSentinel),
)
vi.mock('../src/client.js', () => ({ withTenant: (...a: unknown[]) => withTenant(...a) }))

let ops: string[] = []
vi.mock('../src/credential-guard.js', () => ({
  guardSessionMutation: async () => {
    ops.push('guard')
  },
}))
vi.mock('../src/session-provenance.js', () => ({
  resolveSessionProvenance: async () => {
    ops.push('provenance')
    return RUN_ID
  },
  sessionPayload: (id: string | undefined) => (id === undefined ? undefined : { sessionRunId: id }),
}))

const {
  ActiveMemoryNotFoundError,
  archiveMemory,
  archiveMemoryDisposition,
  reaffirmMemoryDisposition,
} = await import('../src/memory-disposition.js')

const USER = '00000000-0000-7000-8000-000000000001'
const MEMORY_ID = '00000000-0000-7000-8000-0000000000aa'
const RUN_ID = '01890b6e-0000-7000-8000-0000000000bb'

interface Row {
  status: string
  validTo: Date | null
  memoryType: string
  project: string | null
}
const live = (memoryType = 'decision'): Row => ({
  status: 'active',
  validTo: null,
  memoryType,
  project: '3ngram',
})

/**
 * Fake tenant tx: `peek` is the unlocked memory read, `locked` the FOR UPDATE
 * re-read (defaults to `peek`), `commitment` the commitment status the reads
 * see (`lockedCommitment` overrides it for the share-locked read).
 */
function makeTx(opts: {
  peek?: Row
  locked?: Row | null
  commitment?: string
  lockedCommitment?: string
}) {
  const inserts: { table: unknown; values: Record<string, unknown> }[] = []
  const updates: Record<string, unknown>[] = []
  const memoryRows = (locked: boolean) => {
    const row = locked && opts.locked !== undefined ? opts.locked : opts.peek
    return row ? [row] : []
  }
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            const label = table === commitments ? 'commitment' : 'memory'
            const rows = (locked: boolean) => {
              if (table !== commitments) return memoryRows(locked)
              const status = locked ? (opts.lockedCommitment ?? opts.commitment) : opts.commitment
              return status === undefined ? [] : [{ status }]
            }
            return {
              for: async (strength: string) => {
                ops.push(`${label}:${strength}`)
                return rows(true)
              },
              // biome-ignore lint/suspicious/noThenProperty: mirrors drizzle's thenable select builder
              then: (onOk: (rows: unknown) => unknown, onErr?: (err: unknown) => unknown) => {
                ops.push(`${label}:read`)
                return Promise.resolve(rows(false)).then(onOk, onErr)
              },
            }
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          ops.push('update')
          updates.push(values)
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        ops.push('insert')
        inserts.push({ table, values })
      },
    }),
  }
  withTenant.mockImplementationOnce(async (_u: string, fn) =>
    fn(tx as unknown as typeof fakeTxSentinel),
  )
  return { inserts, updates }
}

const dispose = () =>
  archiveMemoryDisposition({ userId: USER, memoryId: MEMORY_ID, actorKind: 'user_mcp' })

afterEach(() => {
  ops = []
  withTenant.mockReset()
})

describe('archive disposition order of operations (#217)', () => {
  it('guard, peek, provenance, locked re-read, UPDATE status only, archive event', async () => {
    const { inserts, updates } = makeTx({ peek: live() })

    await expect(dispose()).resolves.toEqual({ memoryId: MEMORY_ID, outcome: 'archived' })

    expect(ops).toEqual([
      'guard',
      'memory:read',
      'commitment:read',
      'provenance',
      'memory:update',
      'commitment:share',
      'update',
      'insert',
    ])
    // Status (and the updated_at stamp) only: content, topic, tags and the
    // bi-temporal columns are never in the SET.
    expect(Object.keys(updates[0] ?? {}).sort()).toEqual(['status', 'updatedAt'])
    expect(updates[0]?.status).toBe('archived')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.table).toBe(memoryEvents)
    expect(inserts[0]?.values).toMatchObject({
      eventKind: 'archive',
      actorKind: 'user_mcp',
      payload: { sessionRunId: RUN_ID, disposition: 'archive' },
    })
  })

  it.each([
    ['not_found', undefined, { outcome: 'rejected', reason: 'not_found' }],
    ['already archived', { ...live(), status: 'archived' }, { outcome: 'already_archived' }],
    [
      'archived and closed (a resolved blocker)',
      { ...live('blocker'), status: 'archived', validTo: new Date() },
      { outcome: 'already_archived' },
    ],
    [
      'superseded',
      { ...live(), validTo: new Date() },
      { outcome: 'rejected', reason: 'superseded' },
    ],
    ['a blocker', live('blocker'), { outcome: 'rejected', reason: 'blocker' }],
  ] as const)('%s: decided from the peek, before provenance, writing nothing', async (_name, peek, verdict) => {
    const { inserts, updates } = makeTx(peek === undefined ? {} : { peek: { ...peek } })

    await expect(dispose()).resolves.toEqual({ memoryId: MEMORY_ID, ...verdict })

    expect(ops).not.toContain('provenance')
    expect(updates).toHaveLength(0)
    expect(inserts).toHaveLength(0)
  })

  it.each(['open', 'waiting'])('rejects a memory riding a %s commitment', async (status) => {
    const { inserts } = makeTx({ peek: live('commitment'), commitment: status })

    await expect(dispose()).resolves.toEqual({
      memoryId: MEMORY_ID,
      outcome: 'rejected',
      reason: 'open_commitment',
    })
    expect(ops).not.toContain('provenance')
    expect(inserts).toHaveLength(0)
  })

  it.each(['resolved', 'expired'])('archives a memory whose commitment is %s', async (status) => {
    makeTx({ peek: live('commitment'), commitment: status })

    await expect(dispose()).resolves.toEqual({ memoryId: MEMORY_ID, outcome: 'archived' })
  })

  it('re-decides under the row lock: a concurrent revise that won is reported, not overwritten', async () => {
    const { inserts, updates } = makeTx({
      peek: live(),
      locked: { ...live(), validTo: new Date() },
    })

    await expect(dispose()).resolves.toEqual({
      memoryId: MEMORY_ID,
      outcome: 'rejected',
      reason: 'superseded',
    })
    expect(updates).toHaveLength(0)
    expect(inserts).toHaveLength(0)
  })

  it('re-reads the commitment under a share lock: a concurrent unresolve is honoured', async () => {
    // The peek sees no live obligation; the locked pass sees one reopened.
    const { inserts } = makeTx({ peek: live('commitment'), lockedCommitment: 'open' })

    await expect(dispose()).resolves.toEqual({
      memoryId: MEMORY_ID,
      outcome: 'rejected',
      reason: 'open_commitment',
    })
    expect(ops).toContain('commitment:share')
    expect(inserts).toHaveLength(0)
  })
})

describe('REST archive (generic policy) keeps its contract (#217)', () => {
  it('archives any active type, a blocker and a live commitment included', async () => {
    makeTx({ peek: live('blocker') })
    await expect(archiveMemory(USER, MEMORY_ID, 'user_api')).resolves.toEqual({
      id: MEMORY_ID,
      status: 'archived',
    })
    // The generic policy reads no commitment row.
    expect(ops.filter((op) => op.startsWith('commitment'))).toEqual([])
  })

  it.each([
    ['not found', {}],
    ['already archived', { peek: { ...live(), status: 'archived' } }],
    ['superseded', { peek: { ...live(), validTo: new Date() } }],
  ] as const)('%s is the typed miss', async (_name, opts) => {
    makeTx(opts)
    await expect(archiveMemory(USER, MEMORY_ID, 'user_api')).rejects.toBeInstanceOf(
      ActiveMemoryNotFoundError,
    )
  })
})

describe('reaffirm disposition order of operations (#218)', () => {
  const reaffirm = () =>
    reaffirmMemoryDisposition({ userId: USER, memoryId: MEMORY_ID, actorKind: 'user_api' })

  it('guard, peek, provenance, locked re-read, UPDATE last_reviewed_at ONLY, reaffirm event', async () => {
    const { inserts, updates } = makeTx({ peek: live() })

    await expect(reaffirm()).resolves.toEqual({ memoryId: MEMORY_ID, outcome: 'reaffirmed' })

    expect(ops).toEqual(['guard', 'memory:read', 'provenance', 'memory:update', 'update', 'insert'])
    // No status, no updated_at, no content, topic, recorded_at or valid time.
    expect(Object.keys(updates[0] ?? {})).toEqual(['lastReviewedAt'])
    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.table).toBe(memoryEvents)
    expect(inserts[0]?.values).toMatchObject({
      eventKind: 'reaffirm',
      actorKind: 'user_api',
      payload: { sessionRunId: RUN_ID, disposition: 'reaffirm' },
    })
  })

  it('a blocker or a live commitment can be reaffirmed: a review is not an exit', async () => {
    makeTx({ peek: live('blocker') })
    await expect(reaffirm()).resolves.toMatchObject({ outcome: 'reaffirmed' })
    makeTx({ peek: live('commitment'), commitment: 'open' })
    await expect(reaffirm()).resolves.toMatchObject({ outcome: 'reaffirmed' })
  })

  it.each([
    ['not_found', undefined, 'not_found'],
    ['archived', { ...live(), status: 'archived' }, 'archived'],
    ['superseded', { ...live(), validTo: new Date() }, 'superseded'],
  ] as const)('%s: rejected from the peek, before provenance, writing nothing', async (_name, peek, reason) => {
    const { inserts, updates } = makeTx(peek === undefined ? {} : { peek: { ...peek } })

    await expect(reaffirm()).resolves.toEqual({ memoryId: MEMORY_ID, outcome: 'rejected', reason })
    expect(ops).not.toContain('provenance')
    expect(updates).toHaveLength(0)
    expect(inserts).toHaveLength(0)
  })

  it('re-decides under the row lock: a concurrent archive that won is reported', async () => {
    const { inserts, updates } = makeTx({ peek: live(), locked: { ...live(), status: 'archived' } })

    await expect(reaffirm()).resolves.toEqual({
      memoryId: MEMORY_ID,
      outcome: 'rejected',
      reason: 'archived',
    })
    expect(updates).toHaveLength(0)
    expect(inserts).toHaveLength(0)
  })
})
