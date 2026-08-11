// SPDX-License-Identifier: Apache-2.0
// Unit tests for the get_facts range read (time-series reads): factsRangeSchema's
// empty-object refine (mirrors asOfSchema), sub-millisecond precision guard
// (mirrors recorded-range.ts — issue #58 item 2), and factsQueryInputV2Schema's
// composed superRefine (range/asOf mutual exclusion, inverted-range
// rejection — issue #58 item 1 precedent: reject, not clamp).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { factsQueryInputV2Schema, factsRangeSchema } from '../src/facts-range.js'
import { factSchema, factsQueryInputSchema } from '../src/mcp.js'

describe('factsRangeSchema', () => {
  it('accepts from-only, to-only, or both', () => {
    expect(factsRangeSchema.safeParse({ from: '2026-01-01T00:00:00Z' }).success).toBe(true)
    expect(factsRangeSchema.safeParse({ to: '2026-06-01T00:00:00Z' }).success).toBe(true)
    expect(
      factsRangeSchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' })
        .success,
    ).toBe(true)
  })

  it('REJECTS an empty object — mirrors asOfSchema, never silently lifts the live default', () => {
    expect(factsRangeSchema.safeParse({}).success).toBe(false)
  })

  it('rejects non-datetime bounds and unknown keys (strict)', () => {
    expect(factsRangeSchema.safeParse({ from: 'last tuesday' }).success).toBe(false)
    expect(factsRangeSchema.safeParse({ from: '2026-01-01T00:00:00Z', bogus: 1 }).success).toBe(
      false,
    )
  })

  it('REJECTS sub-millisecond bounds; accepts up to 3 fractional digits (#58 item 2)', () => {
    // At the bound: exactly 3 fractional digits (JS Date millisecond precision) parses.
    expect(factsRangeSchema.safeParse({ from: '2026-01-01T00:00:00.123Z' }).success).toBe(true)
    // Past the bound: a 4th+ fractional digit would be silently truncated by the
    // ISO->Date conversion (valid_from/valid_to are microsecond-precise in
    // Postgres) — rejected per bound, on either field.
    expect(factsRangeSchema.safeParse({ from: '2026-01-01T00:00:00.1234Z' }).success).toBe(false)
    expect(factsRangeSchema.safeParse({ to: '2026-01-01T00:00:00.123456Z' }).success).toBe(false)
    // Fraction-less bounds are unaffected.
    expect(factsRangeSchema.safeParse({ to: '2026-01-01T00:00:00Z' }).success).toBe(true)
  })

  it('ADVERTISES the precision limit in the emitted JSON Schema (invisible superRefine)', () => {
    const json = z.toJSONSchema(factsRangeSchema, { target: 'draft-2020-12', io: 'input' })
    const props = json.properties as Record<string, { description?: string }>
    expect(props.from?.description).toMatch(/at most 3 fractional-second digits/i)
    expect(props.to?.description).toMatch(/at most 3 fractional-second digits/i)
  })
})

describe('factsQueryInputV2Schema', () => {
  it('composes the V1 facts query contract with range (ADR-0011)', () => {
    const parsed = factsQueryInputV2Schema.parse({
      subject: 'employee:42',
      range: { from: '2020-01-01T00:00:00Z', to: '2022-01-01T00:00:00Z' },
    })
    expect(parsed.subject).toBe('employee:42')
    expect(parsed.limit).toBe(50) // base default still applies
    expect(parsed.range).toEqual({ from: '2020-01-01T00:00:00Z', to: '2022-01-01T00:00:00Z' })
    // Base constraints still enforced through the composition.
    expect(factsQueryInputV2Schema.safeParse({ limit: 999 }).success).toBe(false)
    expect(factsQueryInputV2Schema.safeParse({ bogus: 1 }).success).toBe(false)
  })

  it('range alone, asOf alone, or neither all parse', () => {
    expect(
      factsQueryInputV2Schema.safeParse({ range: { from: '2026-01-01T00:00:00Z' } }).success,
    ).toBe(true)
    expect(
      factsQueryInputV2Schema.safeParse({ asOf: { validAt: '2026-01-01T00:00:00Z' } }).success,
    ).toBe(true)
    expect(factsQueryInputV2Schema.safeParse({}).success).toBe(true)
  })

  it('REJECTS range together with asOf (two different time-travel modes)', () => {
    const both = factsQueryInputV2Schema.safeParse({
      range: { from: '2026-01-01T00:00:00Z' },
      asOf: { validAt: '2026-01-01T00:00:00Z' },
    })
    expect(both.success).toBe(false)
  })

  it('an empty range object is REJECTED through the composed schema too', () => {
    expect(factsQueryInputV2Schema.safeParse({ range: {} }).success).toBe(false)
  })

  it('REJECTS an inverted range (from later than to) — issue #58 precedent: reject, not clamp', () => {
    const inverted = factsQueryInputV2Schema.safeParse({
      range: { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    })
    expect(inverted.success).toBe(false)
    // Equal bounds are a valid (if empty) half-open window.
    expect(
      factsQueryInputV2Schema.safeParse({
        range: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      }).success,
    ).toBe(true)
    // A well-ordered range still parses.
    expect(
      factsQueryInputV2Schema.safeParse({
        range: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
      }).success,
    ).toBe(true)
  })

  it('REJECTS a sub-millisecond range bound through the composed schema too', () => {
    expect(
      factsQueryInputV2Schema.safeParse({ range: { from: '2026-01-01T00:00:00.1234Z' } }).success,
    ).toBe(false)
  })

  it('leaves the shipped V1 schema untouched: factsQueryInputSchema rejects range', () => {
    expect(
      factsQueryInputSchema.safeParse({ range: { from: '2026-01-01T00:00:00Z' } }).success,
    ).toBe(false)
    expect(Object.keys(factsQueryInputSchema.shape)).not.toContain('range')
  })
})

describe('factSchema — output-only recordedAt widening', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    subject: 'employee:42',
    predicate: 'role',
    value: 'manager',
    confidence: null,
    validFrom: '2022-01-01T00:00:00.000Z',
    validTo: null,
  }

  it('requires recordedAt (additive strict widening — a caller must supply it)', () => {
    expect(factSchema.safeParse(base).success).toBe(false)
    expect(factSchema.safeParse({ ...base, recordedAt: '2022-01-01T00:00:00.000Z' }).success).toBe(
      true,
    )
  })
})
