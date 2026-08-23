// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. The hook-facing lifecycle SEMANTICS
// (docs/concepts/session-continuity.mdx layers 1 and 6): what open/close/
// heartbeat decide, which statements they emit, and — the part a real
// two-transaction race cannot pin deterministically — the ORDER in which they
// take the advisory lock and the row lock.
//
// The fake tx replays the exact observation sequence each transaction sees and
// records every SELECT's row-lock strength plus every UPDATE's `set` values,
// which is what separates a heartbeat (lastSeenAt only) from a resurrect
// (closedAt + activationEpoch) and a first close from an idempotent repeat. The
// end-to-end path with real RLS lives in
// packages/db/test/integration/session-lifecycle.int.test.ts.
import { SESSION_LEASE_MS } from '@3ngram/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lockSessionAttach = vi.fn(async () => undefined)
vi.mock('../src/client.js', () => ({
  lockSessionAttach: (...a: unknown[]) => lockSessionAttach(...a),
}))

const {
  AgentSessionNotFoundError,
  AgentSessionParamsConflictError,
  closeSession,
  heartbeatSession,
  openSession,
} = await import('../src/session-lifecycle.js')

const USER = '00000000-0000-7000-8000-000000000001'
const RUN = '01890b6e-0000-7000-8000-0000000000aa'
const NOW = new Date('2026-08-23T12:00:00.000Z')
const PROJECT = '3ngram'
const KEY = { agent: 'claude-code', sessionId: 'conv-abc' }

type Row = Record<string, unknown> | undefined

const row = (over: Record<string, unknown> = {}) => ({
  id: RUN,
  ...KEY,
  source: 'startup',
  project: PROJECT,
  scope: 'work',
  selector: { kind: 'all' },
  activationEpoch: 1,
  openedAt: NOW,
  closedAt: null,
  lastSeenAt: NOW,
  briefingDeliveredAt: NOW,
  briefedMemories: [],
  ...over,
})

const stale = (over: Record<string, unknown> = {}) =>
  row({ lastSeenAt: new Date(NOW.getTime() - SESSION_LEASE_MS - 60_000), ...over })

/**
 * Fake tenant tx. `reads` feeds SELECTs FIFO, `updates` feeds each
 * `.returning()` of an UPDATE (undefined = the guarded WHERE matched nothing),
 * `insert` feeds the INSERT.
 */
function makeTx(script: { reads?: Row[]; updates?: Row[]; insert?: Row } = {}) {
  const reads = [...(script.reads ?? [])]
  const updateRows = [...(script.updates ?? [])]
  const rowLocks: boolean[] = []
  const sets: Record<string, unknown>[] = []
  const inserted: Record<string, unknown>[] = []
  const read = async (rowLocked: boolean) => {
    rowLocks.push(rowLocked)
    const next = reads.shift()
    return next === undefined ? [] : [next]
  }
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: (strength: string) => read(strength === 'update'),
          // biome-ignore lint/suspicious/noThenProperty: mirrors drizzle's thenable select builder
          then: (onOk: (rows: unknown) => unknown, onErr?: (err: unknown) => unknown) =>
            read(false).then(onOk, onErr),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(values)
          return script.insert === undefined ? [] : [script.insert]
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            sets.push(values)
            const next = updateRows.shift()
            return next === undefined ? [] : [next]
          },
        }),
      }),
    }),
  }
  return { tx: tx as unknown as Parameters<typeof openSession>[0], rowLocks, sets, inserted }
}

const openInput = (over: Record<string, unknown> = {}) => ({
  ...KEY,
  source: 'startup' as const,
  project: PROJECT,
  scope: 'work',
  selector: { kind: 'all' as const },
  ...over,
})

const isResurrect = (values: Record<string, unknown>) => 'activationEpoch' in values
const lockedProjects = () => lockSessionAttach.mock.calls.map((c) => (c as unknown[])[2])

/** A monotonic lease write: GREATEST(last_seen_at, <now>) rather than a bare now. */
function expectMonotonicLastSeen(values: Record<string, unknown>): void {
  expect(values.lastSeenAt).not.toBeInstanceOf(Date)
  const chunks = (values.lastSeenAt as { queryChunks?: unknown[] }).queryChunks
  expect(Array.isArray(chunks)).toBe(true)
}

beforeEach(() => {
  lockSessionAttach.mockClear()
})

describe('openSession — insert', () => {
  it('inserts a startup row and stamps the briefing the hook reported', async () => {
    const briefedMemories = [{ id: RUN, topic: 'ship 5a', status: 'open' }]
    const { tx, inserted } = makeTx({ insert: row() })

    const result = await openSession(tx, USER, openInput({ briefedMemories }), NOW)

    expect(result.created).toBe(true)
    expect(result.reopened).toBe(false)
    expect(inserted[0]).toMatchObject({
      userId: USER,
      agent: KEY.agent,
      sessionId: KEY.sessionId,
      source: 'startup',
      project: PROJECT,
      scope: 'work',
      briefedMemories,
      briefingDeliveredAt: NOW,
    })
    // activation_epoch is the column default (1) — never client-supplied.
    expect(inserted[0]).not.toHaveProperty('activationEpoch')
  })

  it('omits the briefing stamp entirely when no briefing was delivered', async () => {
    const { tx, inserted } = makeTx({ insert: row() })

    await openSession(tx, USER, openInput({ source: 'resume' }), NOW)

    expect(inserted[0]).not.toHaveProperty('briefedMemories')
    expect(inserted[0]).not.toHaveProperty('briefingDeliveredAt')
  })

  it('stamps an EMPTY briefing — a briefing that surfaced nothing is still a delivery', async () => {
    const { tx, inserted } = makeTx({ insert: row() })

    await openSession(tx, USER, openInput({ briefedMemories: [] }), NOW)

    expect(inserted[0]).toMatchObject({ briefedMemories: [], briefingDeliveredAt: NOW })
  })

  it('inserts rather than 404s when a resume finds no row', async () => {
    // The lease is the liveness signal for a session that is demonstrably
    // alive; refusing to record it makes the crash path worse.
    const { tx, inserted } = makeTx({ insert: row() })

    const result = await openSession(tx, USER, openInput({ source: 'resume' }), NOW)

    expect(result.created).toBe(true)
    expect(inserted[0]).toMatchObject({ source: 'resume' })
  })

  it('writes project NULL rather than a fake facet when the hook omits it', async () => {
    const { tx, inserted } = makeTx({ insert: row({ project: null }) })

    await openSession(tx, USER, { ...KEY, source: 'startup', selector: { kind: 'all' } }, NOW)

    expect(inserted[0]).toMatchObject({ project: null, scope: null })
    expect(lockedProjects()).toEqual([null])
  })
})

describe('openSession — idempotency by natural key', () => {
  it('is a no-op heartbeat when a startup repeats with the same params', async () => {
    // Duplicate hook delivery: same natural key, same identity params. It must
    // not advance the epoch (a fence) and must not restamp the briefing.
    const { tx, sets } = makeTx({ reads: [row(), row()], updates: [row()] })

    const result = await openSession(tx, USER, openInput(), NOW)

    expect(result).toMatchObject({ created: false, reopened: false })
    expect(sets).toHaveLength(1)
    expect(isResurrect(sets[0] as Record<string, unknown>)).toBe(false)
    expect(sets[0]).not.toHaveProperty('closedAt')
    expect(sets[0]).not.toHaveProperty('briefedMemories')
    expectMonotonicLastSeen(sets[0] as Record<string, unknown>)
  })

  it('409s a startup whose identity params disagree with the stored row', async () => {
    for (const changed of [
      { project: 'other' },
      { scope: 'personal' },
      { selector: { kind: 'scope' as const, scope: 'work' } },
    ]) {
      const { tx, sets } = makeTx({ reads: [row(), row()] })
      await expect(openSession(tx, USER, openInput(changed), NOW)).rejects.toBeInstanceOf(
        AgentSessionParamsConflictError,
      )
      expect(sets).toHaveLength(0)
    }
  })

  it('does NOT compare params on resume — a moved cwd must not break a live lease', async () => {
    // resume may legitimately omit `project`; the page freezes the row's
    // identity, so comparing here would 409 every resume of a live session.
    const { tx, sets } = makeTx({ reads: [row(), row()], updates: [row({ activationEpoch: 2 })] })

    const result = await openSession(tx, USER, { ...KEY, source: 'resume' }, NOW)

    expect(result.row.activationEpoch).toBe(2)
    expect(isResurrect(sets[0] as Record<string, unknown>)).toBe(true)
  })

  it('advances the epoch on every resume of a live row', async () => {
    const { tx, sets } = makeTx({ reads: [row(), row()], updates: [row({ activationEpoch: 2 })] })

    const result = await openSession(tx, USER, openInput({ source: 'resume' }), NOW)

    expect(result).toMatchObject({ created: false, reopened: false })
    expect(isResurrect(sets[0] as Record<string, unknown>)).toBe(true)
    // A live resume is an activation, not a resurrection: closed_at is untouched.
    expect(sets[0]).not.toHaveProperty('closedAt')
  })
})

describe('openSession — reopen', () => {
  it('reopens and advances the epoch on an explicitly closed row', async () => {
    const closed = row({ closedAt: NOW })
    const { tx, sets } = makeTx({
      reads: [closed, closed],
      updates: [row({ activationEpoch: 2 })],
    })

    const result = await openSession(tx, USER, openInput(), NOW)

    expect(result.reopened).toBe(true)
    expect(sets[0]).toMatchObject({ closedAt: null })
    expect(isResurrect(sets[0] as Record<string, unknown>)).toBe(true)
  })

  it('reopens a lease-expired row even though closed_at is still null', async () => {
    // Implicit close is evaluated on read and write, not only after a sweeper
    // has stamped closed_at.
    const { tx, sets } = makeTx({
      reads: [stale(), stale()],
      updates: [row({ activationEpoch: 2 })],
    })

    const result = await openSession(tx, USER, openInput(), NOW)

    expect(result.reopened).toBe(true)
    expect(sets[0]).toMatchObject({ closedAt: null })
  })

  it('never restamps the briefing on a reopen', async () => {
    const closed = row({ closedAt: NOW })
    const { tx, sets } = makeTx({
      reads: [closed, closed],
      updates: [row({ activationEpoch: 2 })],
    })

    await openSession(tx, USER, openInput({ briefedMemories: [] }), NOW)

    expect(sets[0]).not.toHaveProperty('briefedMemories')
    expect(sets[0]).not.toHaveProperty('briefingDeliveredAt')
  })
})

describe('openSession — lock discipline', () => {
  it('probes unlocked, locks the ROW project, then row-locks the re-read', async () => {
    // Advisory BEFORE row (the repo-wide order), keyed on the row's CURRENT
    // project so an attacher counting leased-open rows for that project is
    // serialized against this open.
    const { tx, rowLocks } = makeTx({
      reads: [row({ project: 'moved' }), row({ project: 'moved' })],
      updates: [row()],
    })

    await openSession(tx, USER, openInput({ source: 'resume' }), NOW)

    expect(rowLocks).toEqual([false, true])
    expect(lockedProjects()).toEqual(['moved'])
    expect(lockSessionAttach).toHaveBeenCalledTimes(1)
  })

  it('locks the REQUEST project when there is no row yet', async () => {
    const { tx, rowLocks } = makeTx({ insert: row() })

    await openSession(tx, USER, openInput(), NOW)

    expect(lockedProjects()).toEqual([PROJECT])
    expect(rowLocks).toEqual([false, true])
  })
})

describe('closeSession', () => {
  it('closes an open row and freezes last_seen_at', async () => {
    // An explicit close is identified forever by closed_at <= last_seen_at +
    // lease, so close must NOT refresh the lease — and must not clear the
    // excerpt the closer has not consumed yet.
    const { tx, sets } = makeTx({ updates: [row({ closedAt: NOW })] })

    const result = await closeSession(tx, USER, KEY, NOW)

    expect(result.alreadyClosed).toBe(false)
    expect(sets).toEqual([{ closedAt: NOW }])
    expect(sets[0]).not.toHaveProperty('lastSeenAt')
    expect(sets[0]).not.toHaveProperty('lastMessageExcerpt')
  })

  it('is idempotent: a repeat close writes nothing and echoes the first timestamp', async () => {
    // The guarded UPDATE matches open rows only, so it changes no row here.
    const first = new Date(NOW.getTime() - 60_000)
    const { tx, sets } = makeTx({ updates: [undefined], reads: [row({ closedAt: first })] })

    const result = await closeSession(tx, USER, KEY, NOW)

    expect(result.alreadyClosed).toBe(true)
    expect(result.row.closedAt).toBe(first)
    expect(sets).toHaveLength(1)
  })

  it('throws when the tenant owns no row for that natural key', async () => {
    const { tx } = makeTx({ updates: [undefined], reads: [undefined] })

    await expect(closeSession(tx, USER, KEY, NOW)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
  })

  it('takes NO advisory lock — it must fit the SessionEnd hook budget', async () => {
    // Safe precisely because it never waits on one: a path that never acquires
    // the advisory lock cannot invert advisory-before-row.
    const { tx } = makeTx({ updates: [row({ closedAt: NOW })] })

    await closeSession(tx, USER, KEY, NOW)

    expect(lockSessionAttach).not.toHaveBeenCalled()
  })
})

describe('heartbeatSession', () => {
  it('refreshes a live lease with no lock and no epoch bump', async () => {
    const { tx, sets, rowLocks } = makeTx({ reads: [row()], updates: [row()] })

    const result = await heartbeatSession(tx, USER, KEY, NOW)

    expect(result.resurrected).toBe(false)
    expect(lockSessionAttach).not.toHaveBeenCalled()
    expect(rowLocks).toEqual([false])
    expect(isResurrect(sets[0] as Record<string, unknown>)).toBe(false)
    expectMonotonicLastSeen(sets[0] as Record<string, unknown>)
  })

  it('snapshots the turn excerpt when the hook carries one', async () => {
    const { tx, sets } = makeTx({ reads: [row()], updates: [row()] })

    await heartbeatSession(tx, USER, { ...KEY, lastMessageExcerpt: 'shipped' }, NOW)

    expect(sets[0]).toMatchObject({ lastMessageExcerpt: 'shipped' })
  })

  it('leaves the stored excerpt alone when the hook carries none', async () => {
    const { tx, sets } = makeTx({ reads: [row()], updates: [row()] })

    await heartbeatSession(tx, USER, KEY, NOW)

    expect(sets[0]).not.toHaveProperty('lastMessageExcerpt')
  })

  it('resurrects a lease-expired row under the attach lock and a row-locked re-read', async () => {
    const { tx, sets, rowLocks } = makeTx({
      reads: [stale(), stale()],
      updates: [row({ activationEpoch: 2 })],
    })

    const result = await heartbeatSession(tx, USER, KEY, NOW)

    expect(result.resurrected).toBe(true)
    expect(sets[0]).toMatchObject({ closedAt: null })
    expect(isResurrect(sets[0] as Record<string, unknown>)).toBe(true)
    expect(lockedProjects()).toEqual([PROJECT])
    expect(rowLocks).toEqual([false, true])
  })

  it('resurrects an explicitly closed row — a stale close is transient', async () => {
    // The one place heartbeat and the WRITE attach path differ: a write onto an
    // explicitly closed row stays unattributed, but a heartbeat IS a statement
    // that the session is alive.
    const closed = row({ closedAt: NOW })
    const { tx, sets } = makeTx({ reads: [closed, closed], updates: [row({ activationEpoch: 2 })] })

    const result = await heartbeatSession(tx, USER, KEY, NOW)

    expect(result.resurrected).toBe(true)
    expect(sets[0]).toMatchObject({ closedAt: null })
  })

  it('heartbeats instead of resurrecting when a concurrent writer already revived it', async () => {
    // Two heartbeats that both saw the row stale must advance the epoch ONCE
    // for one resurrection, or a closer fenced at the first epoch is
    // invalidated for nothing.
    const { tx, sets } = makeTx({ reads: [stale(), row()], updates: [row()] })

    const result = await heartbeatSession(tx, USER, KEY, NOW)

    expect(result.resurrected).toBe(false)
    expect(isResurrect(sets[0] as Record<string, unknown>)).toBe(false)
    expect(lockSessionAttach).toHaveBeenCalledTimes(1)
  })

  it('throws when the tenant owns no row for that natural key', async () => {
    const { tx, sets } = makeTx({ reads: [undefined] })

    await expect(heartbeatSession(tx, USER, KEY, NOW)).rejects.toBeInstanceOf(
      AgentSessionNotFoundError,
    )
    expect(sets).toHaveLength(0)
    expect(lockSessionAttach).not.toHaveBeenCalled()
  })

  it('throws when the row vanished between the probe and the locked re-read', async () => {
    const { tx, sets } = makeTx({ reads: [stale(), undefined] })

    await expect(heartbeatSession(tx, USER, KEY, NOW)).rejects.toBeInstanceOf(
      AgentSessionNotFoundError,
    )
    expect(sets).toHaveLength(0)
  })
})
