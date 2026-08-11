// SPDX-License-Identifier: Apache-2.0
// Unit — the V4 search query contract: chronological list mode (order axis +
// a relevance-only query, issue #134). Pins (1) relevance stays
// query-required and byte-compatible with V3's fields (cursor/projection
// carry through), (2) chronological REJECTS a query (that mode ranks nothing,
// so a query could only be silently ignored) and requires >=1 filter in its
// place, (3) V2's refinements (memoryType/memoryTypes exclusion,
// recorded-range sanity) still apply on the chronological variant even
// though it is built independently of V3 (not via extend/omit — see
// search-list.ts's module comment for why).
import { describe, expect, it } from 'vitest'
import { searchQueryV4Schema } from '../src/index.js'

describe('searchQueryV4Schema — relevance order (default, byte-compatible with V3)', () => {
  it('defaults order to relevance and keeps query required', () => {
    const parsed = searchQueryV4Schema.parse({ query: 'find it' })
    expect(parsed.order).toBe('relevance')
    expect(parsed.query).toBe('find it')
  })

  it('rejects a missing query under relevance order (explicit or defaulted)', () => {
    expect(searchQueryV4Schema.safeParse({}).success).toBe(false)
    expect(searchQueryV4Schema.safeParse({ order: 'relevance' }).success).toBe(false)
  })

  it('carries V3s cursor and projection fields through unchanged', () => {
    const parsed = searchQueryV4Schema.parse({
      query: 'x',
      cursor: 'b3BhcXVl',
      projection: 'compact',
    })
    expect(parsed).toMatchObject({
      cursor: 'b3BhcXVl',
      projection: 'compact',
      order: 'relevance',
    })
  })

  it('rejects order: chronological on a payload with no query and no filter (relevance branch fails, chronological branch fails)', () => {
    expect(searchQueryV4Schema.safeParse({ order: 'chronological' }).success).toBe(false)
  })
})

describe('searchQueryV4Schema — chronological order (query rejected, >=1 filter required)', () => {
  it('accepts a missing query when at least one filter is present', () => {
    const parsed = searchQueryV4Schema.parse({ order: 'chronological', scope: 'work' })
    expect(parsed.query).toBeUndefined()
    expect(parsed.order).toBe('chronological')
  })

  // The core chronological path takes no query at all, so accepting one meant
  // silently returning the whole live corpus as if it had been searched.
  it('rejects a present query even when a filter narrows the scan', () => {
    const result = searchQueryV4Schema.safeParse({
      order: 'chronological',
      scope: 'work',
      query: 'find it',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.path[0] === 'query')).toBe(true)
  })

  it('names the relevance escape hatch when it rejects a chronological query', () => {
    const result = searchQueryV4Schema.safeParse({
      order: 'chronological',
      scope: 'work',
      query: 'find it',
    })
    const message = result.error?.issues.find((issue) => issue.path[0] === 'query')?.message ?? ''
    expect(message).toContain('not used in chronological order')
    expect(message).toContain("order:'relevance'")
  })

  it('rejects a query with no filter present too — both rules fire independently', () => {
    const result = searchQueryV4Schema.safeParse({ order: 'chronological', query: 'find it' })
    expect(result.success).toBe(false)
    const paths = result.error?.issues.map((issue) => issue.path[0]) ?? []
    expect(paths).toContain('query')
    expect(paths).toContain('order')
  })

  it('rejects a filter-less chronological call — nothing bounds the scan', () => {
    const result = searchQueryV4Schema.safeParse({ order: 'chronological' })
    expect(result.success).toBe(false)
  })

  it('recognizes every V1+V2 filter axis as satisfying the >=1 filter requirement', () => {
    const axes: Record<string, unknown> = {
      memoryType: 'note',
      scope: 'work',
      project: '3ngram',
      status: 'active',
      asOf: { validAt: '2026-01-01T00:00:00Z' },
      memoryTypes: ['note', 'decision'],
      recordedAfter: '2026-01-01T00:00:00Z',
      recordedBefore: '2026-01-02T00:00:00Z',
    }
    for (const [key, value] of Object.entries(axes)) {
      const input = { order: 'chronological', [key]: value }
      expect(
        searchQueryV4Schema.safeParse(input).success,
        `${key} should satisfy the >=1 filter requirement`,
      ).toBe(true)
    }
  })

  it('still rejects memoryType + memoryTypes together (V2 mutual exclusion carries over)', () => {
    const result = searchQueryV4Schema.safeParse({
      order: 'chronological',
      scope: 'work',
      memoryType: 'note',
      memoryTypes: ['decision'],
    })
    expect(result.success).toBe(false)
  })

  it('still rejects an inverted recorded_at range (V2 range-sanity carries over)', () => {
    const result = searchQueryV4Schema.safeParse({
      order: 'chronological',
      recordedAfter: '2026-08-02T00:00:00Z',
      recordedBefore: '2026-08-01T00:00:00Z',
    })
    expect(result.success).toBe(false)
  })

  it('still rejects a sub-millisecond recorded bound (issue #58 item 2 carries over)', () => {
    const result = searchQueryV4Schema.safeParse({
      order: 'chronological',
      recordedAfter: '2026-08-01T00:00:00.1234Z',
    })
    expect(result.success).toBe(false)
  })

  it('carries cursor and projection through the chronological branch too', () => {
    const parsed = searchQueryV4Schema.parse({
      order: 'chronological',
      scope: 'work',
      cursor: 'b3BhcXVl',
      projection: 'compact',
    })
    expect(parsed.cursor).toBe('b3BhcXVl')
    expect(parsed.projection).toBe('compact')
  })
})

describe('searchQueryV4Schema — strictness', () => {
  it('rejects an unknown key on either order branch', () => {
    expect(searchQueryV4Schema.safeParse({ query: 'x', bogus: 1 }).success).toBe(false)
    expect(
      searchQueryV4Schema.safeParse({ order: 'chronological', scope: 'work', bogus: 1 }).success,
    ).toBe(false)
  })

  it('rejects an unrecognized order value', () => {
    expect(searchQueryV4Schema.safeParse({ query: 'x', order: 'newest' }).success).toBe(false)
  })
})
