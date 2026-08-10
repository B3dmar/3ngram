// SPDX-License-Identifier: Apache-2.0
// Unit — the V3 search continuation contract (issue #49): cursor + projection
// composed onto the shipped V2 query schema, and the V2 output envelope with
// nextCursor/hasMore. Pins (1) the composition carries V2's runtime
// refinements (Zod 4 stores refinements in the schema — a silent drop here
// would un-enforce the memoryType/memoryTypes exclusion for V3 callers),
// (2) the shipped V2 schema stays byte-identical (it must NOT admit the new
// keys), and (3) the output consistency refinements are enforced, not
// advisory.
import { describe, expect, it } from 'vitest'
import {
  searchHitCompactSchema,
  searchProjectionSchema,
  searchQueryV2Schema,
  searchQueryV3Schema,
  searchToolOutputV2Schema,
} from '../src/index.js'

const ID = '11111111-1111-4111-8111-111111111111'
const FULL_HIT = {
  id: ID,
  memoryType: 'note',
  topic: 'topic',
  content: 'excerpt',
  contentLength: 7,
  truncated: false,
  score: 0.5,
  superseded: false,
}
const COMPACT_HIT = { id: ID, memoryType: 'note', topic: 'topic', score: 0.5, superseded: false }

describe('searchQueryV3Schema — cursor + projection composition', () => {
  it('defaults projection to full and limit to the shipped default', () => {
    const parsed = searchQueryV3Schema.parse({ query: 'find' })
    expect(parsed.projection).toBe('full')
    expect(parsed.limit).toBe(5)
    expect(parsed.cursor).toBeUndefined()
  })

  it('accepts an opaque cursor with filters and compact projection', () => {
    const parsed = searchQueryV3Schema.parse({
      query: 'find',
      cursor: 'b3BhcXVl',
      projection: 'compact',
      memoryTypes: ['decision', 'note'],
      scope: 'work',
    })
    expect(parsed.cursor).toBe('b3BhcXVl')
    expect(parsed.projection).toBe('compact')
    expect(parsed.memoryTypes).toEqual(['decision', 'note'])
  })

  it('rejects an empty cursor and an unknown projection', () => {
    expect(searchQueryV3Schema.safeParse({ query: 'q', cursor: '' }).success).toBe(false)
    expect(searchQueryV3Schema.safeParse({ query: 'q', projection: 'tiny' }).success).toBe(false)
  })

  it('carries the V2 refinements through the composition (mutual exclusion, range sanity)', () => {
    expect(
      searchQueryV3Schema.safeParse({
        query: 'q',
        memoryType: 'note',
        memoryTypes: ['decision'],
      }).success,
    ).toBe(false)
    expect(
      searchQueryV3Schema.safeParse({
        query: 'q',
        recordedAfter: '2026-08-02T00:00:00Z',
        recordedBefore: '2026-08-01T00:00:00Z',
      }).success,
    ).toBe(false)
    // Sub-millisecond bound precision (issue #58) rejects through V3 too.
    expect(
      searchQueryV3Schema.safeParse({
        query: 'q',
        recordedAfter: '2026-08-01T00:00:00.1234Z',
      }).success,
    ).toBe(false)
  })

  it('stays strict: an unknown key is rejected, never silently dropped', () => {
    expect(searchQueryV3Schema.safeParse({ query: 'q', offset: 3 }).success).toBe(false)
  })

  it('shipped V2 stays byte-identical: V2 does NOT admit cursor or projection', () => {
    expect(searchQueryV2Schema.safeParse({ query: 'q', cursor: 'x' }).success).toBe(false)
    expect(searchQueryV2Schema.safeParse({ query: 'q', projection: 'full' }).success).toBe(false)
  })
})

describe('searchProjectionSchema / searchHitCompactSchema', () => {
  it('projection admits exactly full and compact', () => {
    expect(searchProjectionSchema.parse('compact')).toBe('compact')
    expect(searchProjectionSchema.safeParse('excerpt').success).toBe(false)
  })

  it('compact hit omits the excerpt triple and stays strict', () => {
    expect(searchHitCompactSchema.parse(COMPACT_HIT)).toEqual(COMPACT_HIT)
    expect(searchHitCompactSchema.safeParse(FULL_HIT).success).toBe(false)
  })
})

describe('searchToolOutputV2Schema — continuation envelope consistency', () => {
  it('accepts a full-projection page with a further page', () => {
    const parsed = searchToolOutputV2Schema.parse({
      hits: [FULL_HIT],
      count: 1,
      hasMore: true,
      nextCursor: 'dG9rZW4',
    })
    expect(parsed.hasMore).toBe(true)
  })

  it('accepts a compact-projection final page (no cursor)', () => {
    const parsed = searchToolOutputV2Schema.parse({
      hits: [COMPACT_HIT],
      count: 1,
      hasMore: false,
    })
    expect(parsed.nextCursor).toBeUndefined()
  })

  it('rejects a drifting count', () => {
    expect(
      searchToolOutputV2Schema.safeParse({ hits: [FULL_HIT], count: 2, hasMore: false }).success,
    ).toBe(false)
  })

  it('accepts homogeneous multi-hit pages in both projections', () => {
    const secondId = '22222222-2222-4222-8222-222222222222'
    expect(
      searchToolOutputV2Schema.safeParse({
        hits: [FULL_HIT, { ...FULL_HIT, id: secondId }],
        count: 2,
        hasMore: false,
      }).success,
    ).toBe(true)
    expect(
      searchToolOutputV2Schema.safeParse({
        hits: [COMPACT_HIT, { ...COMPACT_HIT, id: secondId }],
        count: 2,
        hasMore: false,
      }).success,
    ).toBe(true)
  })

  it('rejects a mixed-projection page (each hit alone satisfies the union)', () => {
    const mixed = searchToolOutputV2Schema.safeParse({
      hits: [FULL_HIT, COMPACT_HIT],
      count: 2,
      hasMore: false,
    })
    expect(mixed.success).toBe(false)
    // Either order: the refinement is about the PAGE, not hit positions.
    expect(
      searchToolOutputV2Schema.safeParse({
        hits: [COMPACT_HIT, FULL_HIT],
        count: 2,
        hasMore: false,
      }).success,
    ).toBe(false)
  })

  it('rejects hasMore:true without a cursor, and a dangling cursor on a final page', () => {
    expect(
      searchToolOutputV2Schema.safeParse({ hits: [FULL_HIT], count: 1, hasMore: true }).success,
    ).toBe(false)
    expect(
      searchToolOutputV2Schema.safeParse({
        hits: [FULL_HIT],
        count: 1,
        hasMore: false,
        nextCursor: 'dG9rZW4',
      }).success,
    ).toBe(false)
  })
})
