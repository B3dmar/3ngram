// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. attachKnownRun's RE-READ UNDER THE LOCK (Codex P2).
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
vi.mock('../src/client.js', () => ({
  lockSessionAttach: (...a: unknown[]) => lockSessionAttach(...a),
}))

const { resolveSessionProvenance, UnknownSessionRunError } = await import(
  '../src/session-provenance.js'
)

const USER = '00000000-0000-7000-8000-000000000001'
const RUN = '01890b6e-0000-7000-8000-0000000000aa'
const NOW = new Date('2026-08-21T12:00:00.000Z')

const leased = (closedAt: Date | null = null) => ({
  id: RUN,
  project: '3ngram',
  closedAt,
  lastSeenAt: NOW,
})
const stale = (closedAt: Date | null = null) => ({
  id: RUN,
  project: '3ngram',
  closedAt,
  lastSeenAt: new Date(NOW.getTime() - SESSION_LEASE_MS - 60_000),
})

type SessionRead = Record<string, unknown> | undefined

/**
 * Fake tenant tx replaying one row per SELECT (FIFO — the pre-lock read, then
 * the re-read under the lock) and recording every UPDATE's `set` values, which
 * is what separates a heartbeat (lastSeenAt only) from a resurrect (closedAt +
 * activationEpoch).
 */
function makeTx(reads: SessionRead[]) {
  const updates: Record<string, unknown>[] = []
  const queue = [...reads]
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const row = queue.shift()
            return row === undefined ? [] : [row]
          },
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
  return { tx: tx as unknown as Parameters<typeof resolveSessionProvenance>[0], updates }
}

type FakeTx = ReturnType<typeof makeTx>['tx']

const isResurrect = (values: Record<string, unknown>) => 'activationEpoch' in values
const attach = (tx: FakeTx, now = NOW) =>
  resolveSessionProvenance(tx, USER, { sessionRunId: RUN, project: '3ngram', now })

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
    expect(updates[0]).toMatchObject({ closedAt: null, lastSeenAt: NOW })
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
    expect(updates[0]).toEqual({ lastSeenAt: NOW })
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
})

describe('attachKnownRun fast paths (no lock taken)', () => {
  it('heartbeats a leased-open row without touching the attach lock', async () => {
    const { tx, updates } = makeTx([leased()])

    await expect(attach(tx)).resolves.toBe(RUN)

    expect(lockSessionAttach).not.toHaveBeenCalled()
    expect(updates).toEqual([{ lastSeenAt: NOW }])
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
