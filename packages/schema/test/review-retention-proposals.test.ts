// SPDX-License-Identifier: Apache-2.0
// review_proposals V4: the retention kind's output rules.
import { describe, expect, it } from 'vitest'
import { reviewProposalsOutputV4Schema } from '../src/index.js'

const record = {
  id: '019fecaa-0000-7000-8000-0000000000e1',
  memoryId: '019fecaa-0000-7000-8000-0000000000e2',
  action: 'supersede',
  relatedMemoryId: '019fecaa-0000-7000-8000-0000000000e3',
  probability: 0.92,
  model: 'jev-test',
  status: 'proposed',
  decidedAt: null,
  createdAt: '2026-10-27T04:30:00.000Z',
}
const list = (over: Record<string, unknown> = {}) => ({
  action: 'list',
  proposals: [],
  count: 0,
  retentionProposals: [record],
  counts: { edge: 0, fact: 0, resolution: 0, retention: 1 },
  totals: { edge: 0, fact: 0, resolution: 0, retention: 4 },
  hasMore: false,
  ...over,
})

describe('reviewProposalsOutputV4Schema', () => {
  it('accepts a page carrying retention proposals and their counts', () => {
    expect(reviewProposalsOutputV4Schema.safeParse(list()).success).toBe(true)
  })

  it('requires counts.retention to match the page, and the key omitted rather than empty', () => {
    const counts = { edge: 0, fact: 0, resolution: 0, retention: 2 }
    expect(reviewProposalsOutputV4Schema.safeParse(list({ counts })).success).toBe(false)
    const empty = list({
      retentionProposals: [],
      counts: { edge: 0, fact: 0, resolution: 0, retention: 0 },
    })
    expect(reviewProposalsOutputV4Schema.safeParse(empty).success).toBe(false)
  })

  it('keeps every V3 list rule: edge count, omitted-not-empty kinds, nextCursor with hasMore', () => {
    const bad = [
      list({ count: 1 }),
      list({ counts: { edge: 1, fact: 0, resolution: 0, retention: 1 } }),
      list({ factProposals: [], counts: { edge: 0, fact: 0, resolution: 0, retention: 1 } }),
      list({ resolutionProposals: [] }),
      list({ hasMore: true }),
      list({ nextCursor: 'c' }),
    ]
    for (const page of bad) {
      expect(reviewProposalsOutputV4Schema.safeParse(page).success).toBe(false)
    }
    expect(
      reviewProposalsOutputV4Schema.safeParse(list({ hasMore: true, nextCursor: 'c' })).success,
    ).toBe(true)
  })

  it('rejects a V3-shaped count without the retention key', () => {
    const v3 = list({
      retentionProposals: undefined,
      counts: { edge: 0, fact: 0, resolution: 0 },
      totals: { edge: 0, fact: 0, resolution: 0 },
    })
    expect(reviewProposalsOutputV4Schema.safeParse(v3).success).toBe(false)
  })

  it('accepts the retention decision variants', () => {
    for (const action of ['applied_retention', 'rejected_retention']) {
      const decided = { ...record, status: action === 'applied_retention' ? 'applied' : 'rejected' }
      expect(reviewProposalsOutputV4Schema.safeParse({ action, proposal: decided }).success).toBe(
        true,
      )
    }
  })
})
