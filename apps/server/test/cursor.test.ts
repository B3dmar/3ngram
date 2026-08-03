// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { decodeCursor, encodeCursor } from '../src/cursor.js'

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
})
