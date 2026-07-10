// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { COMMITMENT_TRANSITIONS, canTransition, commitmentStatusSchema } from '../src/commitment.js'

describe('commitment FSM', () => {
  it('covers every status with a transition entry', () => {
    expect(Object.keys(COMMITMENT_TRANSITIONS).sort()).toEqual(
      [...commitmentStatusSchema.options].sort(),
    )
  })

  it('allows the documented lifecycle', () => {
    expect(canTransition('open', 'waiting')).toBe(true)
    expect(canTransition('open', 'resolved')).toBe(true)
    expect(canTransition('open', 'expired')).toBe(true)
    expect(canTransition('waiting', 'open')).toBe(true)
    expect(canTransition('waiting', 'resolved')).toBe(true)
    expect(canTransition('resolved', 'open')).toBe(true) // unresolve
    expect(canTransition('expired', 'open')).toBe(true) // revival
  })

  it('rejects illegal transitions', () => {
    expect(canTransition('resolved', 'waiting')).toBe(false)
    expect(canTransition('resolved', 'expired')).toBe(false)
    expect(canTransition('expired', 'resolved')).toBe(false)
    expect(canTransition('expired', 'waiting')).toBe(false)
  })

  it('never allows a self-transition', () => {
    for (const [from, targets] of Object.entries(COMMITMENT_TRANSITIONS)) {
      expect(targets).not.toContain(from)
    }
  })
})
