// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. The check-violation cause-walk and the FSM-trigger
// message detection that map a Postgres error to a typed transition error.
// Integration coverage (the trigger ACTUALLY firing as app_user) lives in
// test/integration/commitments.int.test.ts.
import { describe, expect, it } from 'vitest'
import {
  illegalTransitionPair,
  isCheckViolation,
  isIllegalCommitmentTransition,
  isUniqueViolation,
} from '../src/pg-errors.js'

const CHECK = '23514'
const UNIQUE = '23505'
const TRIGGER_MSG = 'illegal commitment transition: open -> expired'

describe('isCheckViolation (cause-walk)', () => {
  it('detects a 23514 on the error itself', () => {
    expect(isCheckViolation({ code: CHECK })).toBe(true)
  })
  it('detects a 23514 wrapped on .cause (drizzle wrapping)', () => {
    expect(isCheckViolation({ cause: { code: CHECK } })).toBe(true)
  })
  it('does not confuse a unique violation for a check violation', () => {
    expect(isCheckViolation({ code: UNIQUE })).toBe(false)
    expect(isUniqueViolation({ code: UNIQUE })).toBe(true)
  })
  it('returns false for non-pg errors', () => {
    expect(isCheckViolation(new Error('boom'))).toBe(false)
    expect(isCheckViolation(null)).toBe(false)
  })
})

describe('isIllegalCommitmentTransition', () => {
  it('matches a check violation carrying the FSM trigger message', () => {
    expect(isIllegalCommitmentTransition({ code: CHECK, message: TRIGGER_MSG })).toBe(true)
  })
  it('matches when the trigger error is wrapped on .cause', () => {
    expect(isIllegalCommitmentTransition({ cause: { code: CHECK, message: TRIGGER_MSG } })).toBe(
      true,
    )
  })
  it('does NOT match a check violation from an unrelated constraint', () => {
    expect(isIllegalCommitmentTransition({ code: CHECK, message: 'memories_status_check' })).toBe(
      false,
    )
  })
  it('does NOT match a unique violation even with the trigger message', () => {
    expect(isIllegalCommitmentTransition({ code: UNIQUE, message: TRIGGER_MSG })).toBe(false)
  })
})

describe('illegalTransitionPair', () => {
  it('extracts from/to from the trigger message', () => {
    expect(illegalTransitionPair({ message: TRIGGER_MSG })).toEqual({
      from: 'open',
      to: 'expired',
    })
  })
  it('extracts from a wrapped .cause message', () => {
    expect(
      illegalTransitionPair({
        cause: { message: 'illegal commitment transition: resolved -> expired' },
      }),
    ).toEqual({ from: 'resolved', to: 'expired' })
  })
  it('returns undefined when no pair is present', () => {
    expect(illegalTransitionPair({ message: 'something else' })).toBeUndefined()
  })
})
