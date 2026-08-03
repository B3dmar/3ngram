// SPDX-License-Identifier: Apache-2.0
// Unit — the canonical search query/filter contracts. The
// ONE validation boundary for the filters core search() honours (hard rule 2):
// The MCP tool keeps the narrow
// searchInputSchema. These tests pin (1) every filter value reuses its column's
// contract, (2) the wider schema carries the filters, and (3) the CRITICAL
// invariant — the MCP `search` tool surface (searchInputSchema) stays byte-
// identical, i.e. it does NOT admit the filter keys (docs/concepts/architecture.mdx).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  DEFAULT_DASHBOARD_SEARCH_LIMIT,
  dashboardSearchQuerySchema,
  dashboardSearchResponseSchema,
  handoffMemorySchema,
  MAX_EXCERPT_LENGTH,
  MAX_MEMORY_TYPES_FILTER,
  searchFiltersSchema,
  searchFiltersV2Schema,
  searchHitSchema,
  searchInputSchema,
  searchQuerySchema,
  searchQueryV2Schema,
} from '../src/index.js'

describe('searchFiltersSchema — canonical filter contract', () => {
  it('accepts each filter against its column contract', () => {
    const parsed = searchFiltersSchema.parse({
      memoryType: 'decision',
      scope: 'work',
      project: '3ngram',
      status: 'active',
      asOf: { validAt: '2026-01-01T00:00:00Z', asKnownAt: '2026-02-01T00:00:00Z' },
    })
    expect(parsed.memoryType).toBe('decision')
    expect(parsed.scope).toBe('work')
    expect(parsed.status).toBe('active')
  })

  it('is fully optional — an empty object is valid (no axis narrowed)', () => {
    expect(searchFiltersSchema.parse({})).toEqual({})
  })

  it('rejects a memoryType outside the memory-type enum (reuses memoryTypeSchema)', () => {
    expect(searchFiltersSchema.safeParse({ memoryType: 'context' }).success).toBe(false)
  })

  it('names the type filter `memoryType`, NOT `type` (canonical end-to-end; P2 3372942608)', () => {
    // The core/db filter object reads filters.memoryType; a `type` key here would
    // be a silent drop downstream. The schema field MUST be memoryType, and the
    // legacy `type` key MUST be rejected (strict) so a stale caller fails loudly.
    expect(Object.keys(searchFiltersSchema.shape)).toContain('memoryType')
    expect(Object.keys(searchFiltersSchema.shape)).not.toContain('type')
    expect(searchFiltersSchema.safeParse({ type: 'decision' }).success).toBe(false)
  })

  it('rejects a status outside the memory-status enum (reuses memoryStatusSchema)', () => {
    expect(searchFiltersSchema.safeParse({ status: 'superseded' }).success).toBe(false)
    expect(searchFiltersSchema.safeParse({ status: 'archived' }).success).toBe(true)
  })

  it('rejects a malformed scope (reuses scopeSchema)', () => {
    expect(searchFiltersSchema.safeParse({ scope: 'Has Space' }).success).toBe(false)
  })

  it('rejects a non-datetime asOf bound and unknown keys (strict)', () => {
    expect(searchFiltersSchema.safeParse({ asOf: { validAt: 'not-a-date' } }).success).toBe(false)
    expect(searchFiltersSchema.safeParse({ unknownFilter: 'x' }).success).toBe(false)
  })

  it('REJECTS an empty asOf:{} — requires a coordinate (P2 3372942604)', () => {
    // An empty asOf would request time-travel (lift the active default in db)
    // while adding no temporal predicate, silently returning archived/superseded
    // rows. The schema makes `{}` unreachable; one coordinate is accepted.
    expect(searchFiltersSchema.safeParse({ asOf: {} }).success).toBe(false)
    expect(searchQuerySchema.safeParse({ query: 'q', asOf: {} }).success).toBe(false)
    expect(
      searchFiltersSchema.safeParse({ asOf: { validAt: '2026-01-01T00:00:00Z' } }).success,
    ).toBe(true)
    expect(
      searchFiltersSchema.safeParse({ asOf: { asKnownAt: '2026-01-01T00:00:00Z' } }).success,
    ).toBe(true)
  })
})

describe('searchQuerySchema — wider core/db-facing contract', () => {
  it('carries query + limit AND the filters in one shape', () => {
    const parsed = searchQuerySchema.parse({
      query: 'find it',
      memoryType: 'fact',
      scope: 'personal',
    })
    expect(parsed.query).toBe('find it')
    expect(parsed.limit).toBe(5) // default carried from searchInputSchema
    expect(parsed.memoryType).toBe('fact')
    expect(parsed.scope).toBe('personal')
  })

  it('narrows the parse->filter path: parsed memoryType is the key core/db read (P2 3372942608)', () => {
    // The parsed object MUST expose `memoryType` (not `type`) so threading it
    // straight into core search()'s SearchFilters (which the db rowEligibility
    // reads as filters.memoryType) actually narrows — never a silent drop.
    const parsed = searchQuerySchema.parse({ query: 'q', memoryType: 'decision' })
    expect(parsed.memoryType).toBe('decision')
    const filters: { memoryType?: string } = { memoryType: parsed.memoryType }
    expect(filters.memoryType).toBe('decision')
  })

  it('still validates the base query constraints (non-empty, bounded limit)', () => {
    expect(searchQuerySchema.safeParse({ query: '' }).success).toBe(false)
    expect(searchQuerySchema.safeParse({ query: 'q', limit: 999 }).success).toBe(false)
  })

  it('rejects an invalid filter value through the wider shape (single boundary)', () => {
    expect(searchQuerySchema.safeParse({ query: 'q', status: 'bogus' }).success).toBe(false)
  })
})

describe('dashboardSearchQuerySchema — REST continuation contract', () => {
  it('defaults to a 25-hit window and accepts an opaque cursor (no numeric offset)', () => {
    const parsed = dashboardSearchQuerySchema.parse({ query: 'find it', cursor: 'opaque-token' })
    expect(parsed.limit).toBe(DEFAULT_DASHBOARD_SEARCH_LIMIT)
    expect(parsed.cursor).toBe('opaque-token')
  })

  it('rejects the retired numeric offset, over-limit windows, and unknown keys', () => {
    expect(dashboardSearchQuerySchema.safeParse({ query: 'q', offset: 25 }).success).toBe(false)
    expect(dashboardSearchQuerySchema.safeParse({ query: 'q', limit: 26 }).success).toBe(false)
    expect(dashboardSearchQuerySchema.safeParse({ query: 'q', unknown: true }).success).toBe(false)
  })

  it('returns identity-only hits with optional commitment status and nextCursor', () => {
    const parsed = dashboardSearchResponseSchema.parse({
      hits: [
        {
          id: crypto.randomUUID(),
          memoryType: 'commitment',
          topic: 'follow up',
          score: 1.02,
          commitmentStatus: 'waiting',
        },
      ],
      count: 1,
      hasMore: true,
      nextCursor: 'next-page-token',
    })
    expect(parsed.hits[0]?.commitmentStatus).toBe('waiting')
    expect(parsed.nextCursor).toBe('next-page-token')
    expect(
      dashboardSearchResponseSchema.safeParse({
        hits: [
          {
            id: crypto.randomUUID(),
            memoryType: 'note',
            topic: 'leaky',
            content: 'must not ship to the dashboard search table',
            score: 0.5,
          },
        ],
        count: 1,
        hasMore: false,
      }).success,
    ).toBe(false)
  })

  it('omits nextCursor on the last page', () => {
    const parsed = dashboardSearchResponseSchema.parse({ hits: [], count: 0, hasMore: false })
    expect(parsed.nextCursor).toBeUndefined()
  })
})

describe('searchInputSchema — MCP tool surface stays byte-stable (docs/concepts/architecture.mdx)', () => {
  it('exposes EXACTLY query + limit, no filter keys', () => {
    // The MCP transport registers this schema's .shape; A1 must not widen it.
    expect(Object.keys(searchInputSchema.shape).sort()).toEqual(['limit', 'query'])
  })

  it('REJECTS any filter key (strict) — filters are not on the tool surface', () => {
    for (const filter of [
      { memoryType: 'decision' },
      { scope: 'work' },
      { project: '3ngram' },
      { status: 'active' },
      { asOf: { validAt: '2026-01-01T00:00:00Z' } },
      { offset: 25 },
    ]) {
      expect(searchInputSchema.safeParse({ query: 'q', ...filter }).success).toBe(false)
    }
  })
})

describe('searchHitSchema / handoffMemorySchema — bounded EXCERPT contract (issue #238)', () => {
  const hit = (content: string) => ({
    id: crypto.randomUUID(),
    memoryType: 'note',
    topic: 't',
    content,
    contentLength: content.length,
    truncated: false,
    score: 0.9,
  })

  it('accepts a hit with content at the excerpt cap', () => {
    expect(searchHitSchema.safeParse(hit('a'.repeat(MAX_EXCERPT_LENGTH))).success).toBe(true)
  })

  it('REJECTS hit content over the excerpt cap — core must excerpt, never pass through', () => {
    expect(searchHitSchema.safeParse(hit('a'.repeat(MAX_EXCERPT_LENGTH + 1))).success).toBe(false)
  })

  it('the excerpt cap sits in the orientation band, BELOW the 2,000-char write cap', () => {
    // Stored content can reach 262,144 via the import path; the read-result
    // contract is an orientation excerpt (~500-700), not the write bound.
    expect(MAX_EXCERPT_LENGTH).toBeGreaterThanOrEqual(500)
    expect(MAX_EXCERPT_LENGTH).toBeLessThanOrEqual(700)
  })

  it('REQUIRES the truncation metadata (contentLength + truncated) on every hit', () => {
    const { contentLength: _cl, ...noLength } = hit('c')
    const { truncated: _t, ...noFlag } = hit('c')
    expect(searchHitSchema.safeParse(noLength).success).toBe(false)
    expect(searchHitSchema.safeParse(noFlag).success).toBe(false)
  })

  it('handoff lines share the SAME excerpt bound and metadata (the #238 sweep)', () => {
    const line = (content: string) => ({
      id: crypto.randomUUID(),
      memoryType: 'decision',
      topic: 't',
      content,
      contentLength: content.length,
      truncated: false,
      scope: 'work',
      project: null,
    })
    expect(handoffMemorySchema.safeParse(line('b'.repeat(MAX_EXCERPT_LENGTH))).success).toBe(true)
    expect(handoffMemorySchema.safeParse(line('b'.repeat(MAX_EXCERPT_LENGTH + 1))).success).toBe(
      false,
    )
    const { contentLength: _cl, ...noLength } = line('b')
    expect(handoffMemorySchema.safeParse(noLength).success).toBe(false)
  })
})

describe('searchFiltersV2Schema / searchQueryV2Schema — V2 axes (issue #48)', () => {
  it('accepts a memoryTypes OR-set of valid memory types', () => {
    const parsed = searchFiltersV2Schema.parse({ memoryTypes: ['decision', 'fact'] })
    expect(parsed.memoryTypes).toEqual(['decision', 'fact'])
  })

  it('bounds memoryTypes: non-empty, at most MAX_MEMORY_TYPES_FILTER, enum-valid elements', () => {
    expect(searchFiltersV2Schema.safeParse({ memoryTypes: [] }).success).toBe(false)
    expect(
      searchFiltersV2Schema.safeParse({
        memoryTypes: Array.from({ length: MAX_MEMORY_TYPES_FILTER + 1 }, () => 'note'),
      }).success,
    ).toBe(false)
    expect(searchFiltersV2Schema.safeParse({ memoryTypes: ['bogus-type'] }).success).toBe(false)
  })

  it('accepts ISO datetimes for the recorded_at range and rejects non-datetimes', () => {
    const parsed = searchFiltersV2Schema.parse({
      recordedAfter: '2026-01-01T00:00:00Z',
      recordedBefore: '2026-02-01T00:00:00Z',
    })
    expect(parsed.recordedAfter).toBe('2026-01-01T00:00:00Z')
    expect(searchFiltersV2Schema.safeParse({ recordedAfter: 'last tuesday' }).success).toBe(false)
    expect(searchFiltersV2Schema.safeParse({ recordedBefore: '2026-01-01' }).success).toBe(false)
  })

  it('is fully optional and strict — empty object valid, unknown keys rejected', () => {
    expect(searchFiltersV2Schema.parse({})).toEqual({})
    expect(searchFiltersV2Schema.safeParse({ tags: ['deferred'] }).success).toBe(false)
  })

  it('searchQueryV2Schema composes the V1 query contract with the V2 axes (ADR-0011)', () => {
    const parsed = searchQueryV2Schema.parse({
      query: 'find it',
      memoryTypes: ['decision', 'preference'],
      scope: 'work',
      recordedAfter: '2026-01-01T00:00:00Z',
    })
    expect(parsed.limit).toBe(5) // base default still applies
    expect(parsed.memoryTypes).toEqual(['decision', 'preference'])
    expect(parsed.scope).toBe('work') // V1 filters still ride
    // Base constraints still enforced through the composition.
    expect(searchQueryV2Schema.safeParse({ query: '' }).success).toBe(false)
    expect(searchQueryV2Schema.safeParse({ query: 'q', limit: 999 }).success).toBe(false)
    expect(searchQueryV2Schema.safeParse({ query: 'q', bogus: 1 }).success).toBe(false)
  })

  it('REJECTS memoryTypes together with memoryType (mutually exclusive)', () => {
    const both = searchQueryV2Schema.safeParse({
      query: 'q',
      memoryType: 'decision',
      memoryTypes: ['fact'],
    })
    expect(both.success).toBe(false)
    // Each alone stays valid.
    expect(searchQueryV2Schema.safeParse({ query: 'q', memoryType: 'decision' }).success).toBe(true)
    expect(searchQueryV2Schema.safeParse({ query: 'q', memoryTypes: ['decision'] }).success).toBe(
      true,
    )
  })

  it('REJECTS an inverted recorded_at range (recordedAfter later than recordedBefore)', () => {
    const inverted = searchQueryV2Schema.safeParse({
      query: 'q',
      recordedAfter: '2026-02-01T00:00:00Z',
      recordedBefore: '2026-01-01T00:00:00Z',
    })
    expect(inverted.success).toBe(false)
    // Equal bounds are a valid single-instant range (both bounds inclusive).
    expect(
      searchQueryV2Schema.safeParse({
        query: 'q',
        recordedAfter: '2026-01-01T00:00:00Z',
        recordedBefore: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(true)
    // A well-ordered range still parses.
    expect(
      searchQueryV2Schema.safeParse({
        query: 'q',
        recordedAfter: '2026-01-01T00:00:00Z',
        recordedBefore: '2026-02-01T00:00:00Z',
      }).success,
    ).toBe(true)
  })

  it('ADVERTISES the mutual exclusion in the emitted JSON Schema descriptions', () => {
    // The superRefine is runtime-only — invisible in tools/list. The constraint
    // must therefore ride the field descriptions the JSON Schema DOES carry.
    const json = z.toJSONSchema(searchQueryV2Schema, { target: 'draft-2020-12', io: 'input' })
    const props = json.properties as Record<string, { description?: string }>
    expect(props.memoryType?.description).toMatch(/mutually exclusive with memoryTypes/i)
    expect(props.memoryTypes?.description).toMatch(/mutually exclusive with memoryType\b/i)
  })

  it('leaves the shipped V1 schemas untouched: searchQuerySchema rejects the V2 keys', () => {
    expect(searchQuerySchema.safeParse({ query: 'q', memoryTypes: ['decision'] }).success).toBe(
      false,
    )
    expect(
      searchQuerySchema.safeParse({ query: 'q', recordedAfter: '2026-01-01T00:00:00Z' }).success,
    ).toBe(false)
    expect(Object.keys(searchFiltersSchema.shape)).not.toContain('memoryTypes')
  })
})
