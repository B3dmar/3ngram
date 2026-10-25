// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. The merge that turns per-kind keyset reads into ONE page
// of the `created_at DESC, id DESC` proposal stream (issue #320), and the
// page assembly around it: `limit + 1` from every source, a read-only snapshot
// transaction, per-kind partitioning, and `next` present exactly when
// `hasMore`. The real-database walk is in integration/proposals-page.int.test.ts.
import { describe, expect, it, vi } from 'vitest'

const listProposalsAfter = vi.fn()
const listFactProposalsAfter = vi.fn()
const countProposals = vi.fn()
const countFactProposals = vi.fn()
const listResolutionProposalsAfter = vi.fn()
const countResolutionProposals = vi.fn()
const withTenant = vi.fn((_userId: string, fn: (tx: unknown) => unknown, _config?: unknown) =>
  fn('tx'),
)

vi.mock('@3ngram/db', () => ({
  withTenant: (userId: string, fn: (tx: unknown) => unknown, config?: unknown) =>
    withTenant(userId, fn, config),
  listProposalsAfter: (...args: unknown[]) => listProposalsAfter(...args),
  listFactProposalsAfter: (...args: unknown[]) => listFactProposalsAfter(...args),
  countProposals: (...args: unknown[]) => countProposals(...args),
  countFactProposals: (...args: unknown[]) => countFactProposals(...args),
  listResolutionProposalsAfter: (...args: unknown[]) => listResolutionProposalsAfter(...args),
  countResolutionProposals: (...args: unknown[]) => countResolutionProposals(...args),
}))

const { listEdgeProposalsPage, listProposalsPage, mergeProposalStreams } = await import(
  '../src/admin/proposals-page.js'
)

const USER = '00000000-0000-7000-8000-000000000001'
const T1 = '2026-05-01T10:00:00.000002Z'
const T0 = '2026-05-01T10:00:00.000001Z'

/** A keyed row; ids are short lowercase hex so string order = uuid byte order. */
const row = (createdAt: string, id: string) => ({
  position: { createdAt, id },
  record: { id },
})
const ids = (rows: { position: { id: string } }[]) => rows.map((r) => r.position.id)

describe('mergeProposalStreams', () => {
  it('orders the union by createdAt DESC, then id DESC — across sources', () => {
    const edges = [row(T1, 'a2'), row(T0, 'a9'), row(T0, 'a1')]
    const facts = [row(T1, 'b1'), row(T0, 'b5')]
    const merged = mergeProposalStreams([edges, facts], 10)
    expect(ids(merged.page)).toEqual(['b1', 'a2', 'b5', 'a9', 'a1'])
    expect(merged.hasMore).toBe(false)
    expect(merged.next).toBeUndefined()
  })

  it('takes `limit` rows; more in the union means hasMore with next = last EMITTED row', () => {
    const edges = [row(T1, 'a3'), row(T1, 'a2'), row(T0, 'a1')]
    const facts = [row(T1, 'b1'), row(T0, 'b0')]
    const merged = mergeProposalStreams([edges, facts], 3)
    expect(ids(merged.page)).toEqual(['b1', 'a3', 'a2'])
    expect(merged.hasMore).toBe(true)
    expect(merged.next).toEqual({ createdAt: T1, id: 'a2' })
  })

  it('an exact-boundary page (union size === limit) is final: no empty extra page', () => {
    const merged = mergeProposalStreams([[row(T1, 'a1')], [row(T0, 'b1')]], 2)
    expect(merged.page).toHaveLength(2)
    expect(merged.hasMore).toBe(false)
    expect(merged.next).toBeUndefined()
  })

  it('an empty union is an empty final page', () => {
    expect(mergeProposalStreams([[], []], 25)).toEqual({
      page: [],
      hasMore: false,
      next: undefined,
    })
  })

  it('a burst of one kind does not starve the other: the walk reaches it in creation order', () => {
    const facts = Array.from({ length: 6 }, (_, i) => row(T1, `b${9 - i}`))
    const edges = [row(T0, 'a1')]
    const first = mergeProposalStreams([edges, facts.slice(0, 3)], 2)
    expect(ids(first.page)).toEqual(['b9', 'b8'])
    // A later page (sources re-read after `first.next`) emits the edge where it falls.
    const last = mergeProposalStreams([edges, []], 2)
    expect(ids(last.page)).toEqual(['a1'])
  })

  it('generalises to a third source (how a future proposal kind, #229, joins)', () => {
    const merged = mergeProposalStreams([[row(T0, 'a1')], [row(T1, 'b1')], [row(T1, 'c1')]], 2)
    expect(ids(merged.page)).toEqual(['c1', 'b1'])
    expect(merged.next).toEqual({ createdAt: T1, id: 'b1' })
  })
})

describe('listProposalsPage', () => {
  it('reads limit + 1 from every kind after the position, in one read-only snapshot', async () => {
    vi.clearAllMocks()
    listProposalsAfter.mockResolvedValue([row(T1, 'a2'), row(T0, 'a1')])
    listFactProposalsAfter.mockResolvedValue([row(T1, 'b1')])
    listResolutionProposalsAfter.mockResolvedValue([row(T0, 'c1')])
    countProposals.mockResolvedValue(7)
    countFactProposals.mockResolvedValue(4)
    countResolutionProposals.mockResolvedValue(2)
    const after = { createdAt: T1, id: 'ff' }

    const page = await listProposalsPage(USER, { status: 'proposed', limit: 2, after })

    const expected = { status: 'proposed', limit: 3, after }
    expect(listProposalsAfter).toHaveBeenCalledWith('tx', expected)
    expect(listFactProposalsAfter).toHaveBeenCalledWith('tx', USER, expected)
    expect(countProposals).toHaveBeenCalledWith('tx', 'proposed')
    expect(countFactProposals).toHaveBeenCalledWith('tx', USER, 'proposed')
    expect(listResolutionProposalsAfter).toHaveBeenCalledWith('tx', USER, expected)
    expect(countResolutionProposals).toHaveBeenCalledWith('tx', USER, 'proposed')
    expect(withTenant.mock.calls[0]?.[2]).toEqual({
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
    expect(page.proposals.map((p) => p.id)).toEqual(['a2'])
    expect(page.factProposals.map((p) => p.id)).toEqual(['b1'])
    expect(page.resolutionProposals).toEqual([])
    expect(page.totals).toEqual({ edge: 7, fact: 4, resolution: 2 })
    expect(page.hasMore).toBe(true)
    expect(page.next).toEqual({ createdAt: T1, id: 'a2' })
  })
})

describe('listEdgeProposalsPage', () => {
  it('reads edge proposals only, with edge-only totals', async () => {
    vi.clearAllMocks()
    listProposalsAfter.mockResolvedValue([row(T1, 'a2')])
    countProposals.mockResolvedValue(1)

    const page = await listEdgeProposalsPage(USER, { limit: 25 })

    expect(listProposalsAfter).toHaveBeenCalledWith('tx', {
      status: undefined,
      limit: 26,
      after: undefined,
    })
    expect(listFactProposalsAfter).not.toHaveBeenCalled()
    expect(page).toEqual({
      proposals: [{ id: 'a2' }],
      totals: { edge: 1 },
      hasMore: false,
      next: undefined,
    })
  })
})

describe('listProposalsPage — the resolution kind (issue #229)', () => {
  it('merges resolution proposals into the same order and partitions them', async () => {
    vi.clearAllMocks()
    listProposalsAfter.mockResolvedValue([row(T0, 'a1')])
    listFactProposalsAfter.mockResolvedValue([])
    listResolutionProposalsAfter.mockResolvedValue([row(T1, 'c2'), row(T0, 'c1')])
    countProposals.mockResolvedValue(1)
    countFactProposals.mockResolvedValue(0)
    countResolutionProposals.mockResolvedValue(2)

    const page = await listProposalsPage(USER, { limit: 2 })

    expect(page.resolutionProposals.map((p) => p.id)).toEqual(['c2', 'c1'])
    expect(page.proposals).toEqual([])
    expect(page.hasMore).toBe(true)
    expect(page.next).toEqual({ createdAt: T0, id: 'c1' })
  })
})
