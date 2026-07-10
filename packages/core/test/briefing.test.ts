// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. briefing()'s POLICY surface: the
// selector discipline (no-firehose), brief vs full mode shapes + bounds, and the
// overdue/stale derivations from the injected `now`. packages/db is mocked so the
// composition logic is isolated; the integration suite (apps/server
// mcp.int.test.ts) covers the real SQL + RLS through the transport.
//
// COUNT SHAPE: each db section query now returns
// BOTH its capped `items` slice AND the exact `totalCount` from a `count(*) OVER()`
// window in ONE statement, so the count is snapshot-consistent with the slice
// (READ COMMITTED would let a separate COUNT(*) see a different snapshot). These
// mocks model that single-return shape; the count is no longer a second call.
import { afterEach, describe, expect, it, vi } from 'vitest'

const openCommitments = vi.fn()
const overdueCommitments = vi.fn()
const activeBlockers = vi.fn()
const staleCandidates = vi.fn()
const recentDecisions = vi.fn()
const activePreferences = vi.fn()
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
  fn({} as unknown),
)

vi.mock('@3ngram/db', () => ({
  openCommitments: (...a: unknown[]) => openCommitments(...a),
  overdueCommitments: (...a: unknown[]) => overdueCommitments(...a),
  activeBlockers: (...a: unknown[]) => activeBlockers(...a),
  staleCandidates: (...a: unknown[]) => staleCandidates(...a),
  recentDecisions: (...a: unknown[]) => recentDecisions(...a),
  activePreferences: (...a: unknown[]) => activePreferences(...a),
  withTenant: (userId: string, fn: (tx: unknown) => Promise<unknown>) => withTenant(userId, fn),
}))

const { briefing, MissingSelectorError, requireSelector, STALE_WINDOW_DAYS, MAX_BRIEFING_SECTION } =
  await import('../src/read/briefing.js')

const NOW = new Date('2026-06-06T12:00:00.000Z')

/** A {items, totalCount} page — the single-statement window-count return shape. */
function page<T>(items: T[], totalCount: number = items.length) {
  return { items, totalCount }
}

function commitmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    memoryId: crypto.randomUUID(),
    topic: 'ship it',
    status: 'open',
    dueAt: null,
    nextSurfacingAt: null,
    ...overrides,
  }
}

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    memoryType: 'decision',
    topic: 'a topic',
    content: 'some content',
    scope: 'work',
    project: null,
    recordedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function resetAll() {
  for (const fn of [
    openCommitments,
    overdueCommitments,
    activeBlockers,
    staleCandidates,
    recentDecisions,
    activePreferences,
  ]) {
    fn.mockReset()
    fn.mockResolvedValue(page([]))
  }
  withTenant.mockClear()
}

afterEach(resetAll)

describe('briefing — selector discipline (no-firehose)', () => {
  it('throws MissingSelectorError when no selector is provided', async () => {
    resetAll()
    await expect(briefing('u1', { selector: undefined, now: NOW })).rejects.toBeInstanceOf(
      MissingSelectorError,
    )
    expect(withTenant).not.toHaveBeenCalled()
  })

  it('rejects a scope selector with an empty scope', async () => {
    resetAll()
    await expect(
      briefing('u1', { selector: { kind: 'scope', scope: '   ' }, now: NOW }),
    ).rejects.toBeInstanceOf(MissingSelectorError)
  })

  it('rejects a project selector with an empty project', async () => {
    resetAll()
    await expect(
      briefing('u1', { selector: { kind: 'project', project: '' }, now: NOW }),
    ).rejects.toBeInstanceOf(MissingSelectorError)
  })

  it('requireSelector returns a valid selector unchanged', () => {
    expect(requireSelector({ kind: 'all' })).toEqual({ kind: 'all' })
  })
})

describe('briefing — modes + bounds', () => {
  it('defaults to brief mode and caps each section slice at the top constant', async () => {
    resetAll()
    // More rows than the brief top slice; the count reflects the EXACT total
    // (the window totalCount), items are bounded to the brief top slice.
    recentDecisions.mockResolvedValue(
      page(
        Array.from({ length: 10 }, () => memoryRow()),
        10,
      ),
    )
    const result = await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    expect(result.mode).toBe('brief')
    expect(result.recentDecisions.count).toBe(10)
    expect(result.recentDecisions.items.length).toBeLessThanOrEqual(3)
  })

  it('reports the EXACT window count per section beyond the cap (P2 truncation repro)', async () => {
    resetAll()
    // The fetched list is capped at the ceiling, but the SAME statement carries the
    // window totalCount = the true total — a client compares count vs items.length
    // to detect truncation, and count is snapshot-consistent with the slice.
    activeBlockers.mockResolvedValue(
      page(
        Array.from({ length: MAX_BRIEFING_SECTION }, () => memoryRow({ memoryType: 'blocker' })),
        MAX_BRIEFING_SECTION + 12,
      ),
    )
    staleCandidates.mockResolvedValue(
      page(
        Array.from({ length: MAX_BRIEFING_SECTION }, () => memoryRow()),
        MAX_BRIEFING_SECTION + 4,
      ),
    )
    openCommitments.mockResolvedValue(
      page(
        Array.from({ length: MAX_BRIEFING_SECTION }, () => commitmentRow()),
        MAX_BRIEFING_SECTION + 9,
      ),
    )
    const result = await briefing('u1', { selector: { kind: 'all' }, mode: 'full', now: NOW })
    expect(result.blockers.items.length).toBe(MAX_BRIEFING_SECTION)
    expect(result.blockers.count).toBe(MAX_BRIEFING_SECTION + 12)
    expect(result.staleCandidates.items.length).toBe(MAX_BRIEFING_SECTION)
    expect(result.staleCandidates.count).toBe(MAX_BRIEFING_SECTION + 4)
    expect(result.commitments.items.length).toBe(MAX_BRIEFING_SECTION)
    expect(result.commitments.count).toBe(MAX_BRIEFING_SECTION + 9)
  })

  it('full mode returns the bounded lists (slice == fetched, count meaningful)', async () => {
    resetAll()
    recentDecisions.mockResolvedValue(page(Array.from({ length: 10 }, () => memoryRow())))
    const result = await briefing('u1', { selector: { kind: 'all' }, mode: 'full', now: NOW })
    expect(result.mode).toBe('full')
    expect(result.recentDecisions.items.length).toBe(10)
  })

  it('always fetches the ceiling so counts are meaningful regardless of mode', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    // The db limit arg (3rd positional) is the MAX ceiling, not the brief slice.
    expect(openCommitments.mock.calls[0]?.[2]).toBe(MAX_BRIEFING_SECTION)
    expect(recentDecisions.mock.calls[0]?.[2]).toBe(MAX_BRIEFING_SECTION)
  })
})

describe('briefing — overdue (dedicated query, not a filter over the slice)', () => {
  it('composes overdue from the dedicated query with its exact window count', async () => {
    resetAll()
    const past = new Date(NOW.getTime() - 86_400_000)
    const overdueId = crypto.randomUUID()
    // The general slice need not contain the overdue row at all — overdue is its
    // own read. Here the slice holds only non-overdue commitments.
    openCommitments.mockResolvedValue(
      page(
        [
          commitmentRow({ dueAt: new Date(NOW.getTime() + 86_400_000) }),
          commitmentRow({ dueAt: null }),
        ],
        2,
      ),
    )
    overdueCommitments.mockResolvedValue(
      page([commitmentRow({ memoryId: overdueId, dueAt: past })], 1),
    )
    const result = await briefing('u1', { selector: { kind: 'all' }, mode: 'full', now: NOW })
    expect(result.commitments.count).toBe(2)
    expect(result.overdue.count).toBe(1)
    expect(result.overdue.items[0]?.memoryId).toBe(overdueId)
    expect(result.overdue.items[0]?.overdue).toBe(true)
  })

  it('overdue.count is the exact window count, not the truncated list length (P1 repro)', async () => {
    resetAll()
    const past = new Date(NOW.getTime() - 86_400_000)
    // The dedicated overdue list is capped at the section ceiling, but the SAME
    // statement carries the full overdue total — the list under-reporting bug.
    overdueCommitments.mockResolvedValue(
      page(
        Array.from({ length: MAX_BRIEFING_SECTION }, () => commitmentRow({ dueAt: past })),
        MAX_BRIEFING_SECTION + 7,
      ),
    )
    const result = await briefing('u1', { selector: { kind: 'all' }, mode: 'full', now: NOW })
    expect(result.overdue.items.length).toBe(MAX_BRIEFING_SECTION)
    expect(result.overdue.count).toBe(MAX_BRIEFING_SECTION + 7)
  })

  it('forwards now + ceiling limit to the overdue query', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    // overdueCommitments(tx, selector, now, limit)
    expect(overdueCommitments.mock.calls[0]?.[2]).toBe(NOW)
    expect(overdueCommitments.mock.calls[0]?.[3]).toBe(MAX_BRIEFING_SECTION)
  })

  it('derives the stale-before instant as now minus the documented window', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    // staleCandidates(tx, selector, staleBefore, limit): the 3rd arg is the cutoff.
    const staleBefore = staleCandidates.mock.calls[0]?.[2] as Date
    const expected = NOW.getTime() - STALE_WINDOW_DAYS * 86_400_000
    expect(staleBefore.getTime()).toBe(expected)
  })

  it('forwards the selector to every section query', async () => {
    resetAll()
    const selector = { kind: 'scope', scope: 'work' } as const
    await briefing('u1', { selector, now: NOW })
    for (const fn of [
      openCommitments,
      overdueCommitments,
      activeBlockers,
      recentDecisions,
      activePreferences,
    ]) {
      expect(fn.mock.calls[0]?.[1]).toEqual(selector)
    }
    expect(staleCandidates.mock.calls[0]?.[1]).toEqual(selector)
  })
})
