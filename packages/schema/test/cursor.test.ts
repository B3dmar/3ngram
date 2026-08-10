// SPDX-License-Identifier: Apache-2.0
// Unit — the opaque cursor payload contract (cursor.ts): v2's backward-
// compatible optional `fp`, v3's REQUIRED `fp` (issue #134 audit finding —
// v3 has no legacy fp-less tokens to carve out, unlike v2), and v3's
// full-microsecond-precision `recordedAt` cap (NOT the millisecond cap the
// recordedAfter/recordedBefore filter bounds use — that cap exists only
// because those bounds convert through a JS `Date`, which this field never
// does; see search-list.ts's ChronologicalCursor doc for why a millisecond
// cap here would force the exact truncation bug it exists to prevent).
import { describe, expect, it } from 'vitest'
import { cursorPayloadSchema, cursorPayloadV2Schema, cursorPayloadV3Schema } from '../src/index.js'

const ID = '11111111-1111-4111-8111-111111111111'
const FP = 'a'.repeat(16)

describe('cursorPayloadV2Schema — fp stays optional (backward compatibility)', () => {
  it('accepts a v2 payload with no fp (a legacy pre-binding token)', () => {
    const result = cursorPayloadV2Schema.safeParse({
      v: 2,
      ids: [ID],
      scores: [0.5],
      off: 0,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a v2 payload WITH fp', () => {
    const result = cursorPayloadV2Schema.safeParse({
      v: 2,
      ids: [ID],
      scores: [0.5],
      off: 0,
      fp: FP,
    })
    expect(result.success).toBe(true)
  })
})

describe('cursorPayloadV3Schema — fp is REQUIRED (issue #134 audit: no legacy v3 token exists)', () => {
  it('rejects a v3 payload with no fp', () => {
    const result = cursorPayloadV3Schema.safeParse({
      v: 3,
      recordedAt: '2026-01-01T00:00:00.000000Z',
      id: ID,
    })
    expect(result.success).toBe(false)
  })

  it('accepts a v3 payload WITH fp', () => {
    const result = cursorPayloadV3Schema.safeParse({
      v: 3,
      recordedAt: '2026-01-01T00:00:00.000000Z',
      id: ID,
      fp: FP,
    })
    expect(result.success).toBe(true)
  })

  it('the union (cursorPayloadSchema) rejects a fp-less v3 payload too — it does not fall back to matching v2', () => {
    const result = cursorPayloadSchema.safeParse({
      v: 3,
      recordedAt: '2026-01-01T00:00:00.000000Z',
      id: ID,
    })
    expect(result.success).toBe(false)
  })
})

describe('cursorPayloadV3Schema — recordedAt precision (up to microseconds, never a millisecond cap)', () => {
  const base = { v: 3 as const, id: ID, fp: FP }

  it('accepts full microsecond precision (6 fractional digits)', () => {
    expect(
      cursorPayloadV3Schema.safeParse({ ...base, recordedAt: '2026-01-01T00:00:00.123456Z' })
        .success,
    ).toBe(true)
  })

  it('accepts millisecond precision (3 fractional digits) and second precision (0)', () => {
    expect(
      cursorPayloadV3Schema.safeParse({ ...base, recordedAt: '2026-01-01T00:00:00.123Z' }).success,
    ).toBe(true)
    expect(
      cursorPayloadV3Schema.safeParse({ ...base, recordedAt: '2026-01-01T00:00:00Z' }).success,
    ).toBe(true)
  })

  it('rejects MORE than microsecond precision (7+ fractional digits) — Postgres itself never stores more', () => {
    expect(
      cursorPayloadV3Schema.safeParse({ ...base, recordedAt: '2026-01-01T00:00:00.1234567Z' })
        .success,
    ).toBe(false)
  })

  it('does NOT reject 4-6 fractional digits — the millisecond cap the filter bounds use would incorrectly reject these', () => {
    for (const recordedAt of [
      '2026-01-01T00:00:00.1234Z',
      '2026-01-01T00:00:00.12345Z',
      '2026-01-01T00:00:00.123456Z',
    ]) {
      expect(cursorPayloadV3Schema.safeParse({ ...base, recordedAt }).success).toBe(true)
    }
  })
})
