// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. attachKnownRun's RE-READ UNDER THE LOCK (Codex P2), and
// the ROW lock that re-read takes (SELECT ... FOR UPDATE) so a concurrent close
// cannot commit between the resurrect decision and the resurrect itself.
//
// The pre-lock read decides "stale lease -> resurrect", but two concurrent
// writes carrying the SAME stale run id both take that read before either holds
// the attach lock. The lock only serializes them, so without a re-read BOTH
// resurrect and activation_epoch advances TWICE for ONE resurrection —
// invalidating claims a closer fenced at the first epoch. The loser must
// re-decide on committed state and heartbeat instead.
//
// A real two-transaction race is not deterministic; the fake tx here replays the
// exact observation sequence each transaction sees (first read stale, second
// read whatever committed while it waited), which is what the fix keys on. The
// end-to-end path with real RLS lives in
// packages/db/test/integration/session-provenance.int.test.ts.
import { SESSION_LEASE_MS } from '@3ngram/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lockSessionAttach = vi.fn(async () => undefined)
// assertSessionRunOwned opens its own tx; hand it whichever fake the test built.
let currentTx: unknown
vi.mock('../src/client.js', () => ({
  lockSessionAttach: (...a: unknown[]) => lockSessionAttach(...a),
  withTenant: (_userId: string, fn: (tx: unknown) => unknown) => fn(currentTx),
}))

const { assertSessionRunOwned, resolveSessionProvenance, UnknownSessionRunError } = await import(
  '../src/session-provenance.js'
)

const USER = '00000000-0000-7000-8000-000000000001'
const RUN = '01890b6e-0000-7000-8000-0000000000aa'
const NOW = new Date('2026-08-21T12:00:00.000Z')

const PROJECT = '3ngram'

const leased = (closedAt: Date | null = null, project: string | null = PROJECT) => ({
  id: RUN,
  project,
  closedAt,
  lastSeenAt: NOW,
})
const stale = (closedAt: Date | null = null, project: string | null = PROJECT) => ({
  id: RUN,
  project,
  closedAt,
  lastSeenAt: new Date(NOW.getTime() - SESSION_LEASE_MS - 60_000),
})

type SessionRead = Record<string, unknown> | undefined

/**
 * Fake tenant tx replaying one row per SELECT (FIFO — the pre-lock read, then
 * the re-read under the lock) and recording every UPDATE's `set` values, which
 * is what separates a heartbeat (lastSeenAt only) from a resurrect (closedAt +
 * activationEpoch).
 *
 * `rowLocks` records, per SELECT in order, whether it asked for `FOR UPDATE`.
 * A drizzle select is a thenable, so awaiting the builder directly runs the
 * plain read while `.for('update')` runs the row-locking one — the fake mirrors
 * that so a test can assert WHICH read takes the row lock, not merely that some
 * read did.
 */
function makeTx(reads: SessionRead[]) {
  const updates: Record<string, unknown>[] = []
  const rowLocks: boolean[] = []
  const queue = [...reads]
  const read = async (rowLocked: boolean) => {
    rowLocks.push(rowLocked)
    const row = queue.shift()
    return row === undefined ? [] : [row]
  }
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: (strength: string) => read(strength === 'update'),
            // A drizzle select IS a thenable: awaiting the builder runs the
            // plain read while `.for('update')` runs the row-locking one. The
            // fake must be one too, or it cannot tell those two calls apart.
            // biome-ignore lint/suspicious/noThenProperty: mirrors drizzle's thenable select builder
            then: (onOk: (rows: unknown) => unknown, onErr?: (err: unknown) => unknown) =>
              read(false).then(onOk, onErr),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values)
        },
      }),
    }),
  }
  currentTx = tx
  return { tx: tx as unknown as Parameters<typeof resolveSessionProvenance>[0], updates, rowLocks }
}

type FakeTx = ReturnType<typeof makeTx>['tx']

const isResurrect = (values: Record<string, unknown>) => 'activationEpoch' in values

/**
 * Flatten a drizzle SQL template into its literal text plus bound params, so a
 * test can assert the GREATEST guard and the timestamp it was given without
 * reaching into drizzle internals by shape.
 */
function sqlText(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] } | undefined)?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      // Interpolated primitives arrive as raw strings; StringChunk keeps its
      // literal text in `value` (an array); a Column contributes its name.
      if (typeof chunk === 'string') return chunk
      const inner = (chunk as { value?: unknown }).value
      if (Array.isArray(inner)) return inner.join('')
      if (typeof inner === 'string') return inner
      const name = (chunk as { name?: unknown }).name
      return typeof name === 'string' ? name : ''
    })
    .join('')
}

/** A monotonic lease write: GREATEST(last_seen_at, <now>) rather than a bare now. */
function expectMonotonicLastSeen(values: Record<string, unknown>, now: Date): void {
  const text = sqlText(values.lastSeenAt)
  // The stored column must be the left operand — GREATEST(<column>, <now>).
  expect(text).toContain('GREATEST(last_seen_at')
  expect(text).toContain(now.toISOString())
  // A bare Date here would be the non-monotonic assignment this guards against.
  expect(values.lastSeenAt).not.toBeInstanceOf(Date)
}

/** Project keys the code took the attach lock on, in order. */
const lockedProjects = () => lockSessionAttach.mock.calls.map((c) => (c as unknown[])[2])

const attach = (tx: FakeTx, now = NOW) =>
  resolveSessionProvenance(tx, USER, { sessionRunId: RUN, project: PROJECT, now })

beforeEach(() => {
  lockSessionAttach.mockClear()
})

describe('attachKnownRun re-reads under the attach lock', () => {
  it('resurrects exactly once when the row is still stale under the lock', async () => {
    const { tx, updates } = makeTx([stale(), stale()])

    await expect(attach(tx)).resolves.toBe(RUN)

    expect(lockSessionAttach).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(1)
    expect(isResurrect(updates[0] as Record<string, unknown>)).toBe(true)
    expect(updates[0]).toMatchObject({ closedAt: null })
    expectMonotonicLastSeen(updates[0] as Record<string, unknown>, NOW)
    expect(lockedProjects()).toEqual([PROJECT])
  })

  it('heartbeats instead of resurrecting when a concurrent writer already reopened it', async () => {
    // The pre-lock read saw the stale row; by the time the lock was granted the
    // winner had committed its resurrect. Resurrecting again would bump
    // activation_epoch a second time for the same resurrection.
    const { tx, updates } = makeTx([stale(), leased()])

    await expect(attach(tx)).resolves.toBe(RUN)

    expect(lockSessionAttach).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(1)
    expect(isResurrect(updates[0] as Record<string, unknown>)).toBe(false)
    expectMonotonicLastSeen(updates[0] as Record<string, unknown>, NOW)
  })

  it('re-checks the explicit-close guard on the re-read row', async () => {
    // A SessionEnd committed while we waited for the lock: the row is closed
    // within its live lease, which is durable — never resurrect it.
    const closedAt = new Date(NOW.getTime() + 1_000)
    const { tx, updates } = makeTx([stale(), { ...leased(closedAt) }])

    await expect(attach(tx)).resolves.toBeUndefined()

    expect(lockSessionAttach).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(0)
  })

  it('fails the write when the row vanished before the re-read', async () => {
    const { tx, updates } = makeTx([stale(), undefined])

    await expect(attach(tx)).rejects.toBeInstanceOf(UnknownSessionRunError)
    expect(updates).toHaveLength(0)
  })

  it('row-locks the re-read (SELECT ... FOR UPDATE), never the pre-lock read', async () => {
    // The advisory lock only serializes attachers. Close is a bare UPDATE of
    // closed_at that never takes it, so the re-read must hold the ROW lock or a
    // close can commit between the decision and the resurrect it justified —
    // reopening a session the tenant explicitly closed. The pre-lock read stays
    // unlocked so a live session's writes do not queue behind one row lock.
    const { tx, rowLocks } = makeTx([stale(), stale()])

    await expect(attach(tx)).resolves.toBe(RUN)

    expect(rowLocks).toEqual([false, true])
  })

  it('row-locks every re-read when the project moved under the lock', async () => {
    const { tx, rowLocks } = makeTx([stale(), stale(null, null), stale(null, null)])

    await expect(attach(tx)).resolves.toBe(RUN)

    // Pre-lock read unlocked; both re-reads under an advisory lock row-locked.
    expect(rowLocks).toEqual([false, true, true])
  })
})

describe('attachKnownRun re-locks when the row project moved', () => {
  it('locks the new key and resurrects once when erasure nulled the project', async () => {
    // Account erasure redacts agent_sessions.project to NULL. An attacher that
    // read the pre-erasure project would otherwise hold a key no concurrent
    // attacher shares, losing serialization and double-bumping the epoch.
    const { tx, updates } = makeTx([stale(), stale(null, null), stale(null, null)])

    await expect(attach(tx)).resolves.toBe(RUN)

    // Old key first, then the new one — the order every attacher converges on.
    expect(lockedProjects()).toEqual([PROJECT, null])
    expect(updates).toHaveLength(1)
    expect(isResurrect(updates[0] as Record<string, unknown>)).toBe(true)
  })

  it('stops re-locking once the project is stable under the lock', async () => {
    // The re-read already agrees with the key we hold: no second acquisition.
    const { tx, updates } = makeTx([stale(null, null), stale(null, null)])

    await expect(attach(tx)).resolves.toBe(RUN)

    expect(lockedProjects()).toEqual([null])
    expect(updates).toHaveLength(1)
  })

  it('returns unattributed rather than resurrecting on a key it does not hold', async () => {
    // Pathological: the project keeps moving past the attempt cap. Degrading to
    // an unstamped write beats resurrecting without serialization.
    const shifting = [
      stale(null, 'a'),
      stale(null, 'b'),
      stale(null, 'c'),
      stale(null, 'd'),
      stale(null, 'e'),
    ]
    const { tx, updates } = makeTx(shifting)

    await expect(attach(tx)).resolves.toBeUndefined()

    expect(lockSessionAttach).toHaveBeenCalledTimes(3)
    expect(updates).toHaveLength(0)
  })
})

describe('monotonic lease refresh', () => {
  it('never moves last_seen_at backwards when the caller clock is behind', async () => {
    // A slow attacher resuming after a newer heartbeat committed. GREATEST makes
    // its stale `now` a floor, so it cannot shorten the refreshed lease.
    const older = new Date(NOW.getTime() - 30_000)
    const { tx, updates } = makeTx([leased()])

    await expect(attach(tx, older)).resolves.toBe(RUN)

    expect(updates).toHaveLength(1)
    expectMonotonicLastSeen(updates[0] as Record<string, unknown>, older)
  })

  it('applies the same floor to a resurrect', async () => {
    const { tx, updates } = makeTx([stale(), stale()])

    await expect(attach(tx)).resolves.toBe(RUN)

    expect(isResurrect(updates[0] as Record<string, unknown>)).toBe(true)
    expectMonotonicLastSeen(updates[0] as Record<string, unknown>, NOW)
  })
})

describe('assertSessionRunOwned', () => {
  it('passes silently for a row this tenant owns, writing nothing', async () => {
    const { updates } = makeTx([leased()])

    await expect(assertSessionRunOwned(USER, RUN)).resolves.toBeUndefined()

    // Ownership check only: no attach, no heartbeat, no epoch change. A no-op
    // resolve must not be usable as a lease-refresh side channel.
    expect(updates).toHaveLength(0)
    expect(lockSessionAttach).not.toHaveBeenCalled()
  })

  it('throws UnknownSessionRunError for a foreign or nonexistent id', async () => {
    const { updates } = makeTx([undefined])

    await expect(assertSessionRunOwned(USER, RUN)).rejects.toBeInstanceOf(UnknownSessionRunError)
    expect(updates).toHaveLength(0)
  })

  it('accepts an explicitly closed row — ownership is the only question', async () => {
    const { updates } = makeTx([leased(NOW)])

    await expect(assertSessionRunOwned(USER, RUN)).resolves.toBeUndefined()
    expect(updates).toHaveLength(0)
  })
})

describe('attachKnownRun fast paths (no lock taken)', () => {
  it('heartbeats a leased-open row without touching the attach lock', async () => {
    const { tx, updates, rowLocks } = makeTx([leased()])

    await expect(attach(tx)).resolves.toBe(RUN)

    expect(lockSessionAttach).not.toHaveBeenCalled()
    // No advisory lock means no row lock either — advisory BEFORE row is the
    // repo-wide order, so a fast path that row-locked first could invert it.
    expect(rowLocks).toEqual([false])
    expect(updates).toHaveLength(1)
    expectMonotonicLastSeen(updates[0] as Record<string, unknown>, NOW)
  })

  it('succeeds unattributed on an explicitly closed row', async () => {
    const { tx, updates } = makeTx([leased(NOW)])

    await expect(attach(tx)).resolves.toBeUndefined()

    expect(lockSessionAttach).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('throws UnknownSessionRunError for a run id this tenant does not own', async () => {
    const { tx } = makeTx([undefined])

    await expect(attach(tx)).rejects.toBeInstanceOf(UnknownSessionRunError)
    expect(lockSessionAttach).not.toHaveBeenCalled()
  })
})
