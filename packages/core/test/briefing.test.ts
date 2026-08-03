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

const {
  briefing,
  DEFAULT_BRIEFING_TOP,
  MissingSelectorError,
  requireSelector,
  STALE_CANDIDATE_TYPES,
  STALE_WINDOW_DAYS,
  MAX_BRIEFING_SECTION,
} = await import('../src/read/briefing.js')
const { MAX_BRIEFING_SECTION_CEILING, MEMORY_TYPES } = await import('@3ngram/schema')

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

  it('fetches only the mode default per section (counts stay exact via the window)', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    // brief fetches only its top slice — the exact total rides count(*) OVER()
    // in the same statement, so over-fetching buys nothing (bounds V2).
    expect(openCommitments.mock.calls[0]?.[3]).toBe(DEFAULT_BRIEFING_TOP)
    expect(recentDecisions.mock.calls[0]?.[3]).toBe(DEFAULT_BRIEFING_TOP)
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, mode: 'full', now: NOW })
    expect(openCommitments.mock.calls[0]?.[3]).toBe(MAX_BRIEFING_SECTION)
  })
})

describe('briefing — sectionLimit (bounds V2, issue #45)', () => {
  it('forwards the caller sectionLimit to every section query', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, mode: 'full', sectionLimit: 60, now: NOW })
    expect(openCommitments.mock.calls[0]?.[3]).toBe(60)
    expect(overdueCommitments.mock.calls[0]?.[4]).toBe(60)
    expect(activeBlockers.mock.calls[0]?.[3]).toBe(60)
    expect(staleCandidates.mock.calls[0]?.[4]).toBe(60)
    expect(recentDecisions.mock.calls[0]?.[3]).toBe(60)
    expect(activePreferences.mock.calls[0]?.[3]).toBe(60)
  })

  it('overrides the brief top slice when given (sectionLimit beats the mode default)', async () => {
    resetAll()
    recentDecisions.mockResolvedValue(
      page(
        Array.from({ length: 7 }, () => memoryRow()),
        7,
      ),
    )
    const result = await briefing('u1', { selector: { kind: 'all' }, sectionLimit: 7, now: NOW })
    expect(recentDecisions.mock.calls[0]?.[3]).toBe(7)
    expect(result.recentDecisions?.items.length).toBe(7)
  })

  it('clamps the fetch limit to the server-side ceiling (boundary: 100 in, 101 clamped)', async () => {
    resetAll()
    await briefing('u1', {
      selector: { kind: 'all' },
      sectionLimit: MAX_BRIEFING_SECTION_CEILING,
      now: NOW,
    })
    expect(openCommitments.mock.calls[0]?.[3]).toBe(MAX_BRIEFING_SECTION_CEILING)
    resetAll()
    await briefing('u1', {
      selector: { kind: 'all' },
      sectionLimit: MAX_BRIEFING_SECTION_CEILING + 1,
      now: NOW,
    })
    expect(openCommitments.mock.calls[0]?.[3]).toBe(MAX_BRIEFING_SECTION_CEILING)
    resetAll()
    // A direct core caller passing a sub-1 limit is clamped up, never a 0-row read.
    await briefing('u1', { selector: { kind: 'all' }, sectionLimit: 0, now: NOW })
    expect(openCommitments.mock.calls[0]?.[3]).toBe(1)
  })
})

describe('briefing — sections subset (bounds V2, issue #45)', () => {
  it('runs ONLY the requested section queries and omits the rest from the result', async () => {
    resetAll()
    overdueCommitments.mockResolvedValue(page([commitmentRow()], 1))
    const result = await briefing('u1', {
      selector: { kind: 'all' },
      sections: ['overdue', 'preferences'],
      now: NOW,
    })
    expect(overdueCommitments).toHaveBeenCalledTimes(1)
    expect(activePreferences).toHaveBeenCalledTimes(1)
    for (const fn of [openCommitments, activeBlockers, staleCandidates, recentDecisions]) {
      expect(fn).not.toHaveBeenCalled()
    }
    expect(result.overdue?.count).toBe(1)
    expect(result.preferences?.count).toBe(0)
    expect(result.commitments).toBeUndefined()
    expect(result.blockers).toBeUndefined()
    expect(result.staleCandidates).toBeUndefined()
    expect(result.recentDecisions).toBeUndefined()
  })

  it('an absent sections list means all six (legacy behavior)', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    for (const fn of [
      openCommitments,
      overdueCommitments,
      activeBlockers,
      staleCandidates,
      recentDecisions,
      activePreferences,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })
})

describe('briefing — hasMore truth table (bounds V2, issue #45)', () => {
  it.each([
    { count: 0, rows: 0, hasMore: false },
    { count: 3, rows: 3, hasMore: false },
    { count: 4, rows: 3, hasMore: true },
    { count: 40, rows: 3, hasMore: true },
  ])('count=$count with $rows returned rows → hasMore=$hasMore', async ({
    count,
    rows,
    hasMore,
  }) => {
    resetAll()
    recentDecisions.mockResolvedValue(
      page(
        Array.from({ length: rows }, () => memoryRow()),
        count,
      ),
    )
    const result = await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    expect(result.recentDecisions?.count).toBe(count)
    expect(result.recentDecisions?.items.length).toBe(rows)
    expect(result.recentDecisions?.hasMore).toBe(hasMore)
  })
})

describe('briefing — legacy-input stability (bounds V2 must not move V1 callers)', () => {
  it('returns identical sections for an identical legacy input (all sections, same slices)', async () => {
    resetAll()
    const decisions = Array.from({ length: 10 }, () => memoryRow())
    const commitments = [commitmentRow()]
    recentDecisions.mockResolvedValue(page(decisions, 10))
    openCommitments.mockResolvedValue(page(commitments, 1))
    const legacy = { selector: { kind: 'all' }, now: NOW } as const
    const first = await briefing('u1', legacy)
    resetAll()
    recentDecisions.mockResolvedValue(page(decisions, 10))
    openCommitments.mockResolvedValue(page(commitments, 1))
    const second = await briefing('u1', { ...legacy, sections: undefined, sectionLimit: undefined })
    // Same rows in → byte-identical briefing out (explicit-undefined knobs are
    // exactly the legacy path). Commitment ids differ per run, so compare runs
    // built from the SAME mocked rows.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    // And the legacy brief shape: every section present, top slice of 3, exact count.
    expect(first.recentDecisions?.items.length).toBe(3)
    expect(first.recentDecisions?.count).toBe(10)
    expect(first.commitments?.items.length).toBe(1)
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

  it('forwards now + the effective limit to the overdue query', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    // overdueCommitments(tx, userId, selector, now, limit) — brief fetches its
    // top slice; the exact total rides the window count (bounds V2).
    expect(overdueCommitments.mock.calls[0]?.[3]).toBe(NOW)
    expect(overdueCommitments.mock.calls[0]?.[4]).toBe(DEFAULT_BRIEFING_TOP)
  })

  it('derives the stale-before instant as now minus the documented window', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, now: NOW })
    // staleCandidates(tx, userId, selector, staleBefore, limit, memoryTypes).
    const staleBefore = staleCandidates.mock.calls[0]?.[3] as Date
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
      expect(fn.mock.calls[0]?.[2]).toEqual(selector)
    }
    expect(staleCandidates.mock.calls[0]?.[2]).toEqual(selector)
  })
})

describe('briefing — stale-candidate type allowlist (issue #44)', () => {
  // The prod regression: a NOT-IN('commitment') predicate made ~74% of live
  // memories "stale candidates" (dominated by imported event/note rows). The
  // fix is an ALLOWLIST owned by core policy: reviewable types are IN, every
  // other type — including any FUTURE type — is OUT by default (fails closed).
  const EXPECTED_IN = ['decision', 'preference', 'blocker', 'fact'] as const

  it('forwards STALE_CANDIDATE_TYPES and the effective limit to the db read', async () => {
    resetAll()
    await briefing('u1', { selector: { kind: 'all' }, mode: 'full', now: NOW })
    // staleCandidates(tx, userId, selector, staleBefore, limit, memoryTypes) —
    // memoryTypes trails limit so the 0.6.2 positional call stays valid
    // (Codex P1, comment 3702700238); core always passes it explicitly.
    expect(staleCandidates.mock.calls[0]?.[4]).toBe(MAX_BRIEFING_SECTION)
    expect(staleCandidates.mock.calls[0]?.[5]).toBe(STALE_CANDIDATE_TYPES)
  })

  it.each(MEMORY_TYPES)('classifies %s in/out of the stale allowlist correctly', (memoryType) => {
    const shouldBeIn = (EXPECTED_IN as readonly string[]).includes(memoryType)
    expect(STALE_CANDIDATE_TYPES.includes(memoryType)).toBe(shouldBeIn)
  })

  it('covers every schema memory type exactly once (no type left unclassified)', () => {
    // 8 known types; the allowlist is a strict subset and contains no strays.
    expect(MEMORY_TYPES).toHaveLength(8)
    for (const t of STALE_CANDIDATE_TYPES) expect(MEMORY_TYPES).toContain(t)
    expect(STALE_CANDIDATE_TYPES).toEqual(EXPECTED_IN)
  })
})
