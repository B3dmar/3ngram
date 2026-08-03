// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import {
  CursorQueryMismatchError,
  decodeCursor,
  decodeSearchCursor,
  encodeCursor,
  searchFingerprint,
} from '../src/cursor.js'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

describe('dashboard search cursor codec (v2 frozen ordering)', () => {
  it('round-trips a v2 frozen-ordering payload through an opaque token', () => {
    const payload = { v: 2 as const, ids: [ID_A, ID_B], scores: [1.2345, 0.8], off: 1 }
    const token = encodeCursor(payload)
    expect(token).not.toContain('+')
    expect(token).not.toContain('/')
    expect(token).not.toContain('=')
    expect(decodeCursor(token)).toEqual(payload)
  })

  it('preserves negative and zero scores (superseded rows rank below zero)', () => {
    const payload = { v: 2 as const, ids: [ID_A], scores: [-0.5], off: 0 }
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload)
  })

  it('returns undefined for a legacy v1 cursor so pagination restarts at page 1', () => {
    const legacy = Buffer.from(JSON.stringify({ s: 1.5, id: ID_B }), 'utf8').toString('base64url')
    expect(decodeCursor(legacy)).toBeUndefined()
  })

  it('throws a ZodError on a garbled token (mapped to 400 at the boundary)', () => {
    expect(() => decodeCursor('!!!not-base64-json!!!')).toThrow(ZodError)
  })

  it('throws a ZodError when the payload is neither v2 nor a legacy v1 cursor', () => {
    const wrong = Buffer.from(JSON.stringify({ nonsense: true }), 'utf8').toString('base64url')
    expect(() => decodeCursor(wrong)).toThrow(ZodError)
  })

  it('throws a ZodError when ids and scores lengths disagree', () => {
    const bad = Buffer.from(
      JSON.stringify({ v: 2, ids: [ID_A, ID_B], scores: [0.9], off: 0 }),
      'utf8',
    ).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(ZodError)
  })

  it('round-trips a payload carrying the query fingerprint', () => {
    const fp = searchFingerprint('find me', { scope: 'work' })
    const payload = { v: 2 as const, ids: [ID_A], scores: [0.9], off: 0, fp }
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload)
  })
})

describe('searchFingerprint — stable query+filter binding', () => {
  it('is 16 lowercase hex chars and deterministic', () => {
    const fp = searchFingerprint('find me', { scope: 'work' })
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(searchFingerprint('find me', { scope: 'work' })).toBe(fp)
  })

  it('trims the query and normalizes filter key order, undefined axes, and the memoryTypes OR-set', () => {
    const fp = searchFingerprint('find me', {
      scope: 'work',
      memoryTypes: ['decision', 'note'],
      recordedAfter: new Date('2026-01-01T00:00:00Z'),
    })
    expect(
      searchFingerprint('  find me ', {
        recordedAfter: new Date('2026-01-01T00:00:00Z'),
        memoryTypes: ['note', 'decision'],
        scope: 'work',
        project: undefined,
      }),
    ).toBe(fp)
  })

  it('changes when the query or a filter changes (case included — it alters retrieval)', () => {
    const fp = searchFingerprint('find me', { scope: 'work' })
    expect(searchFingerprint('find you', { scope: 'work' })).not.toBe(fp)
    expect(searchFingerprint('find me', { scope: 'personal' })).not.toBe(fp)
    expect(searchFingerprint('find me', {})).not.toBe(fp)
    expect(searchFingerprint('Find me', { scope: 'work' })).not.toBe(fp)
  })

  it('preserves INNER whitespace: core embeds the exact query, so "find\\nme" is a different search', () => {
    const fp = searchFingerprint('find me', { scope: 'work' })
    expect(searchFingerprint('find\nme', { scope: 'work' })).not.toBe(fp)
    expect(searchFingerprint('find  me', { scope: 'work' })).not.toBe(fp)
    // And the binding acts on it: a cursor issued for "find me" replayed with
    // "find\nme" is a typed mismatch, not a silent re-page.
    const bound = encodeCursor({ v: 2, ids: [ID_A], scores: [0.9], off: 0, fp })
    expect(() =>
      decodeSearchCursor(bound, searchFingerprint('find\nme', { scope: 'work' })),
    ).toThrow(CursorQueryMismatchError)
  })
})

describe('decodeSearchCursor — cursor↔query binding (verify-when-present)', () => {
  const FP = searchFingerprint('find me', { scope: 'work' })
  const BOUND = encodeCursor({ v: 2, ids: [ID_A], scores: [0.9], off: 0, fp: FP })

  it('accepts a continuation with the same query+filters', () => {
    expect(decodeSearchCursor(BOUND, FP)?.off).toBe(0)
  })

  it('rejects a cursor replayed against a different query with a typed error', () => {
    const other = searchFingerprint('something else', { scope: 'work' })
    expect(() => decodeSearchCursor(BOUND, other)).toThrow(CursorQueryMismatchError)
    expect(() => decodeSearchCursor(BOUND, other)).toThrow(
      'cursor was issued for a different query',
    )
  })

  it('accepts a fingerprint-less legacy v2 cursor (verify-when-present compatibility)', () => {
    const legacyV2 = encodeCursor({ v: 2, ids: [ID_A], scores: [0.9], off: 0 })
    expect(decodeSearchCursor(legacyV2, FP)?.ids).toEqual([ID_A])
  })

  it('still restarts at page 1 for a v1 keyset cursor', () => {
    const v1 = Buffer.from(JSON.stringify({ s: 1.5, id: ID_B }), 'utf8').toString('base64url')
    expect(decodeSearchCursor(v1, FP)).toBeUndefined()
  })
})
