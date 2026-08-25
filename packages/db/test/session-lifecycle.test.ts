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
const lockAccountLifecycleShared = vi.fn(async () => undefined)
const lockAccountLifecycle = vi.fn(async () => undefined)
vi.mock('../src/client.js', () => ({
  lockSessionAttach: (...a: unknown[]) => lockSessionAttach(...a),
  lockAccountLifecycleShared: (...a: unknown[]) => lockAccountLifecycleShared(...a),
  // Unused here, but credential-guard.ts (openSession's tombstone guard) imports
  // it, and an ESM module mock must provide every named export its importers bind.
  lockAccountLifecycle: (...a: unknown[]) => lockAccountLifecycle(...a),
}))

const {
  AgentSessionNotFoundError,
  AgentSessionParamsConflictError,
  closeSession,
  heartbeatSession,
  openSession,
} = await import('../src/session-lifecycle.js')
const { AccountDeletedError } = await import('../src/credential-guard.js')

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

/** A live (non-tombstoned) account, the default both tombstone guards read. */
const LIVE_USER = { email: 'live@example.test', passwordHash: 'argon2id$live' }
/** The deletion tombstone `deletedEmail(USER)` + `ERASED_PASSWORD_HASH` produce. */
const TOMBSTONED_USER = { email: `deleted-${USER}@deleted.invalid`, passwordHash: '!erased' }

/**
 * Fake tenant tx. `reads` feeds agent_sessions SELECTs FIFO, `updates` feeds
 * each `.returning()` of an UPDATE (undefined = the guarded WHERE matched
 * nothing), `insert` feeds the INSERT, and `user` answers the `users` lookup
 * both tombstone guards make — the excerpt guard's `{email}` and the open
 * guard's `{email, passwordHash}` (routed by the projected column set, since
 * that is the only thing distinguishing them from an agent_sessions read).
 */
function makeTx(
  script: {
    reads?: Row[]
    updates?: Row[]
    insert?: Row
    insertError?: unknown
    /** The `users` row the tombstone guards read. Defaults to a live account. */
    user?: Record<string, unknown>
    /** No `users` row at all — the guard must treat that as "do not write". */
    userAbsent?: boolean
  } = {},
) {
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
  const readUser = async () => (script.userAbsent === true ? [] : [script.user ?? LIVE_USER])
  const tx = {
    select: (columns?: Record<string, unknown>) => {
      // The users lookup projects `email` and nothing else; every
      // agent_sessions read projects RECORD_COLUMNS, which has `id`.
      const isUserLookup = columns !== undefined && 'email' in columns && !('id' in columns)
      const run = (rowLocked: boolean) => (isUserLookup ? readUser() : read(rowLocked))
      const terminal = {
        for: (strength: string) => run(strength === 'update'),
        // biome-ignore lint/suspicious/noThenProperty: mirrors drizzle's thenable select builder
        then: (onOk: (rows: unknown) => unknown, onErr?: (err: unknown) => unknown) =>
          run(false).then(onOk, onErr),
        limit: () => terminal,
      }
      return { from: () => ({ where: () => terminal }) }
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(values)
          if (script.insertError !== undefined) throw script.insertError
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
  lockAccountLifecycleShared.mockClear()
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

  it('maps a natural-key unique violation to the same 409 as changed params', async () => {
    // Two opens of the SAME natural key carrying DIFFERENT projects hold
    // DIFFERENT attach keys, so both can reach the INSERT and the loser hits
    // agent_sessions_natural_key. That is the same collision — one conversation
    // id opened as two sessions — so it must not escape as an unmapped driver
    // error.
    const { tx } = makeTx({ insertError: Object.assign(new Error('dup'), { code: '23505' }) })

    await expect(openSession(tx, USER, openInput(), NOW)).rejects.toBeInstanceOf(
      AgentSessionParamsConflictError,
    )
  })

  it('rethrows a non-unique insert failure untranslated', async () => {
    const boom = Object.assign(new Error('connection lost'), { code: '08006' })
    const { tx } = makeTx({ insertError: boom })

    await expect(openSession(tx, USER, openInput(), NOW)).rejects.toBe(boom)
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

  it('RESTAMPS the briefing when a startup reopens the row', async () => {
    // Every startup renders a briefing and truncates it locally, so a startup
    // that revives a closed row must record what survived THAT cut — otherwise
    // briefed_memories describes a delivery from a previous activation and the
    // debrief mapping points at commitments this agent never saw.
    const closed = row({ closedAt: NOW })
    const briefedMemories = [{ id: RUN, topic: 'fresh briefing', status: 'open' }]
    const { tx, sets } = makeTx({
      reads: [closed, closed],
      updates: [row({ activationEpoch: 2 })],
    })

    await openSession(tx, USER, openInput({ briefedMemories }), NOW)

    expect(sets[0]).toMatchObject({ briefedMemories, briefingDeliveredAt: NOW })
  })

  it('does not restamp when a reopening startup delivered no briefing', async () => {
    const closed = row({ closedAt: NOW })
    const { tx, sets } = makeTx({
      reads: [closed, closed],
      updates: [row({ activationEpoch: 2 })],
    })

    await openSession(tx, USER, openInput(), NOW)

    expect(sets[0]).not.toHaveProperty('briefedMemories')
    expect(sets[0]).not.toHaveProperty('briefingDeliveredAt')
  })

  it('never restamps on a RESUME reopen, however briefed the request looks', async () => {
    // The page is explicit: resume does not restamp. A resume carrying briefed
    // rows is the hook misbehaving, not a delivery.
    const closed = row({ closedAt: NOW })
    const { tx, sets } = makeTx({
      reads: [closed, closed],
      updates: [row({ activationEpoch: 2 })],
    })

    await openSession(
      tx,
      USER,
      openInput({ source: 'resume', briefedMemories: [{ id: RUN, topic: 't', status: 'open' }] }),
      NOW,
    )

    expect(sets[0]).not.toHaveProperty('briefedMemories')
    expect(sets[0]).not.toHaveProperty('briefingDeliveredAt')
  })

  it('never restamps a duplicate startup delivery onto a still-live row', async () => {
    const { tx, sets } = makeTx({ reads: [row(), row()], updates: [row()] })

    await openSession(tx, USER, openInput({ briefedMemories: [] }), NOW)

    expect(sets[0]).not.toHaveProperty('briefedMemories')
    expect(sets[0]).not.toHaveProperty('briefingDeliveredAt')
  })
})

describe('openSession — selector comparison', () => {
  it('does not 409 when jsonb hands the selector back with reordered keys', async () => {
    // Postgres jsonb stores keys sorted by length then bytewise, so a selector
    // written as {scope, kind} comes back as {kind, scope}. A raw
    // JSON.stringify comparison would read that round-trip as a param CHANGE.
    const stored = row({ selector: { kind: 'scope', scope: 'work' } })
    const { tx, sets } = makeTx({ reads: [stored, stored], updates: [row()] })

    await openSession(
      tx,
      USER,
      openInput({ selector: { scope: 'work', kind: 'scope' } as never }),
      NOW,
    )

    expect(sets).toHaveLength(1)
  })

  it('still 409s a genuinely different selector', async () => {
    const stored = row({ selector: { kind: 'scope', scope: 'work' } })
    const { tx } = makeTx({ reads: [stored, stored] })

    await expect(
      openSession(tx, USER, openInput({ selector: { kind: 'scope', scope: 'personal' } }), NOW),
    ).rejects.toBeInstanceOf(AgentSessionParamsConflictError)
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

  it('takes the shared account-lifecycle lock FIRST, before the attach lock', async () => {
    // Repo lock order: account-lifecycle -> session-attach -> row. Erasure takes
    // account-lifecycle and never takes session-attach, so acquiring it ahead of
    // the attach lock is what keeps the two orders acyclic.
    const { tx } = makeTx({ insert: row() })

    await openSession(tx, USER, openInput(), NOW)

    expect(lockAccountLifecycleShared).toHaveBeenCalledTimes(1)
    expect(lockAccountLifecycleShared.mock.calls[0]?.[1]).toBe(USER)
    expect(lockAccountLifecycleShared.mock.invocationCallOrder[0]).toBeLessThan(
      lockSessionAttach.mock.invocationCallOrder[0] as number,
    )
  })
})

describe('openSession — erased account', () => {
  // Erasure must be the FINAL content write (account-delete.ts). An /open still
  // in flight when erasure commits would otherwise INSERT a fresh row — selector
  // and briefing rows and all — or restamp the briefing on reopen, both AFTER
  // the bulk redaction. Unlike the heartbeat's excerpt, there is nothing left to
  // write once the content is refused, so this REFUSES the request.
  it('refuses a startup INSERT onto a tombstoned account', async () => {
    const { tx, inserted, rowLocks } = makeTx({ user: TOMBSTONED_USER, insert: row() })

    await expect(openSession(tx, USER, openInput(), NOW)).rejects.toBeInstanceOf(
      AccountDeletedError,
    )
    expect(inserted).toHaveLength(0)
    // Refused before the probe, so nothing downstream of the guard ran at all.
    expect(rowLocks).toEqual([])
    expect(lockSessionAttach).not.toHaveBeenCalled()
  })

  it('refuses a resume that would reopen and restamp an existing row', async () => {
    const closed = row({ closedAt: NOW })
    const { tx, sets } = makeTx({
      user: TOMBSTONED_USER,
      reads: [closed, closed],
      updates: [row({ activationEpoch: 2 })],
    })

    await expect(
      openSession(tx, USER, openInput({ source: 'resume' }), NOW),
    ).rejects.toBeInstanceOf(AccountDeletedError)
    expect(sets).toHaveLength(0)
  })

  it('refuses when the users row is gone entirely', async () => {
    const { tx, inserted } = makeTx({ userAbsent: true, insert: row() })

    await expect(openSession(tx, USER, openInput(), NOW)).rejects.toBeInstanceOf(
      AccountDeletedError,
    )
    expect(inserted).toHaveLength(0)
  })
})

describe('closeSession', () => {
  it('closes an open row and freezes last_seen_at', async () => {
    // An explicit close is identified forever by closed_at <= last_seen_at +
    // lease, so close must NOT refresh the lease — and must not clear the
    // excerpt the closer has not consumed yet.
    const { tx, sets } = makeTx({ reads: [row()], updates: [row({ closedAt: NOW })] })

    const result = await closeSession(tx, USER, KEY, NOW)

    expect(result.alreadyClosed).toBe(false)
    expect(result.closedAt).toEqual(NOW)
    expect(sets).toEqual([{ closedAt: NOW }])
    expect(sets[0]).not.toHaveProperty('lastSeenAt')
    expect(sets[0]).not.toHaveProperty('lastMessageExcerpt')
  })

  it('row-locks the read so the decision and the write see one row version', async () => {
    // The decision "already closed or not" and the UPDATE that acts on it must
    // observe the same version, or a concurrent open/close in the gap makes the
    // answer fiction.
    const { tx, rowLocks } = makeTx({ reads: [row()], updates: [row({ closedAt: NOW })] })

    await closeSession(tx, USER, KEY, NOW)

    expect(rowLocks).toEqual([true])
  })

  it('is idempotent: a repeat close writes nothing and echoes the first timestamp', async () => {
    const first = new Date(NOW.getTime() - 60_000)
    const { tx, sets } = makeTx({ reads: [row({ closedAt: first })] })

    const result = await closeSession(tx, USER, KEY, NOW)

    expect(result.alreadyClosed).toBe(true)
    expect(result.closedAt).toBe(first)
    // Nothing written at all — re-stamping would move the row past the
    // explicit-close window.
    expect(sets).toHaveLength(0)
  })

  it('never reports alreadyClosed for a live row (the old fallback could)', async () => {
    // A row INSERTed between a guarded UPDATE and a second, unlocked re-read is
    // live with closed_at null; the previous shape reported it as already
    // closed. Reading under the row lock removes the second observation.
    const { tx } = makeTx({ reads: [row({ closedAt: null })], updates: [row({ closedAt: NOW })] })

    const result = await closeSession(tx, USER, KEY, NOW)

    expect(result.alreadyClosed).toBe(false)
    expect(result.closedAt).toEqual(NOW)
  })

  it('throws when the tenant owns no row for that natural key', async () => {
    const { tx, sets } = makeTx({ reads: [undefined] })

    await expect(closeSession(tx, USER, KEY, NOW)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
    expect(sets).toHaveLength(0)
  })

  it('takes NO advisory lock — it must fit the SessionEnd hook budget', async () => {
    // Safe precisely because it never waits on one: a path that never acquires
    // the advisory lock cannot invert advisory-before-row.
    const { tx } = makeTx({ reads: [row()], updates: [row({ closedAt: NOW })] })

    await closeSession(tx, USER, KEY, NOW)

    expect(lockSessionAttach).not.toHaveBeenCalled()
    expect(lockAccountLifecycleShared).not.toHaveBeenCalled()
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

  it('falls through to the locking path when a close commits after the probe', async () => {
    // THE fast-path race: the unlocked probe saw a live row, /close committed in
    // the gap. The guarded UPDATE (closed_at IS NULL) matches nothing, so the
    // call must NOT report a successful non-resurrecting heartbeat and leave an
    // active conversation closed and closer-eligible.
    const closed = row({ closedAt: NOW })
    const { tx, sets, rowLocks } = makeTx({
      // probe (live) -> guarded UPDATE misses -> locked re-read sees the close
      reads: [row(), closed],
      updates: [undefined, row({ activationEpoch: 2 })],
    })

    const result = await heartbeatSession(tx, USER, KEY, NOW)

    expect(result.resurrected).toBe(true)
    expect(result.row.activationEpoch).toBe(2)
    // Two UPDATEs: the guarded miss, then the resurrect under the lock.
    expect(sets).toHaveLength(2)
    expect(isResurrect(sets[0] as Record<string, unknown>)).toBe(false)
    expect(sets[1]).toMatchObject({ closedAt: null })
    expect(isResurrect(sets[1] as Record<string, unknown>)).toBe(true)
    // Unlocked probe, then the row-locked re-read under the advisory lock.
    expect(rowLocks).toEqual([false, true])
    expect(lockSessionAttach).toHaveBeenCalledTimes(1)
  })

  it('guards the fast-path UPDATE rather than trusting the probe', async () => {
    // Regression guard: an unguarded fast UPDATE would have "succeeded" above,
    // so pin that the miss is even possible to observe.
    const { tx } = makeTx({
      reads: [row(), row({ closedAt: NOW })],
      updates: [undefined, row({ activationEpoch: 2 })],
    })

    const result = await heartbeatSession(tx, USER, KEY, NOW)

    expect(result.resurrected).toBe(true)
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
    // No content write means nothing to order against erasure.
    expect(lockAccountLifecycleShared).not.toHaveBeenCalled()
  })

  it('takes the shared account-lifecycle lock before writing an excerpt', async () => {
    // Account erasure must be the FINAL content write. The shared lock is what
    // makes the tombstone check below trustworthy: erasure's exclusive
    // acquisition waits for us, then locks every heartbeat out.
    const { tx } = makeTx({ reads: [row()], updates: [row()] })

    await heartbeatSession(tx, USER, { ...KEY, lastMessageExcerpt: 'shipped' }, NOW)

    expect(lockAccountLifecycleShared).toHaveBeenCalledTimes(1)
    expect(lockAccountLifecycleShared.mock.calls[0]?.[1]).toBe(USER)
  })

  it('takes it BEFORE the attach lock on the resurrect path, not below it', async () => {
    // openSession holds account-lifecycle SHARED while it waits for the attach
    // lock. A heartbeat that requested them the other way round would close a
    // cycle once an erasure queues exclusively in between, so the excerpt guard's
    // acquisition is hoisted above lockSessionAttach here.
    const { tx } = makeTx({ reads: [stale(), stale()], updates: [row({ activationEpoch: 2 })] })

    await heartbeatSession(tx, USER, { ...KEY, lastMessageExcerpt: 'shipped' }, NOW)

    expect(lockAccountLifecycleShared.mock.invocationCallOrder[0]).toBeLessThan(
      lockSessionAttach.mock.invocationCallOrder[0] as number,
    )
  })

  it('takes NO account-lifecycle lock on an excerpt-free resurrect', async () => {
    // The hoist is conditional: a heartbeat writing only structural skeleton has
    // nothing to order against erasure and must not pay for the lock.
    const { tx } = makeTx({ reads: [stale(), stale()], updates: [row({ activationEpoch: 2 })] })

    await heartbeatSession(tx, USER, KEY, NOW)

    expect(lockAccountLifecycleShared).not.toHaveBeenCalled()
  })

  it('DROPS the excerpt when the account is a deletion tombstone', async () => {
    // The in-flight heartbeat that blocked on the row erasure was updating: it
    // resumes after erasure commits and must not write the agent's message back
    // onto an erased account.
    const { tx, sets } = makeTx({
      reads: [row()],
      updates: [row()],
      user: TOMBSTONED_USER,
    })

    const result = await heartbeatSession(
      tx,
      USER,
      { ...KEY, lastMessageExcerpt: 'user content' },
      NOW,
    )

    expect(sets[0]).not.toHaveProperty('lastMessageExcerpt')
    // The lease is structural skeleton erasure deliberately preserves, so the
    // rest of the heartbeat still lands.
    expectMonotonicLastSeen(sets[0] as Record<string, unknown>)
    expect(result.resurrected).toBe(false)
  })

  it('DROPS the excerpt when the users row is gone entirely', async () => {
    const { tx, sets } = makeTx({ reads: [row()], updates: [row()], userAbsent: true })

    await heartbeatSession(tx, USER, { ...KEY, lastMessageExcerpt: 'x' }, NOW)

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
