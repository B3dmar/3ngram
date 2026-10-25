// SPDX-License-Identifier: Apache-2.0
// Issue #234: the optional `reason` on `resolve` (MCP + REST share this schema).
// Bounded, trimmed, never empty; an omitted reason stays omitted.
import { describe, expect, it } from 'vitest'
import {
  MAX_RESOLUTION_REASON_LENGTH,
  resolutionReasonSchema,
  resolveToolInputSchema,
} from '../src/index.js'

const MEMORY_ID = '01890b6e-0000-7000-8000-000000000234'

describe('resolveToolInputSchema reason (#234)', () => {
  it('is optional: an omitted reason parses and stays absent', () => {
    const parsed = resolveToolInputSchema.parse({ memoryId: MEMORY_ID, status: 'resolved' })
    expect(parsed).not.toHaveProperty('reason')
  })

  it('trims surrounding whitespace', () => {
    const parsed = resolveToolInputSchema.parse({
      memoryId: MEMORY_ID,
      status: 'resolved',
      reason: '  shipped in PR #234 \n',
    })
    expect(parsed.reason).toBe('shipped in PR #234')
  })

  it('rejects an empty or whitespace-only reason', () => {
    for (const reason of ['', '   ', '\n\t']) {
      expect(
        resolveToolInputSchema.safeParse({ memoryId: MEMORY_ID, status: 'resolved', reason })
          .success,
        JSON.stringify(reason),
      ).toBe(false)
    }
  })

  it('accepts exactly the bound and rejects one character more', () => {
    expect(MAX_RESOLUTION_REASON_LENGTH).toBe(500)
    const atBound = 'x'.repeat(MAX_RESOLUTION_REASON_LENGTH)
    expect(
      resolveToolInputSchema.safeParse({ memoryId: MEMORY_ID, status: 'open', reason: atBound })
        .success,
    ).toBe(true)
    expect(
      resolveToolInputSchema.safeParse({
        memoryId: MEMORY_ID,
        status: 'open',
        reason: `${atBound}x`,
      }).success,
    ).toBe(false)
  })

  it('bounds the TRIMMED length, so padding cannot push a valid reason over', () => {
    const atBound = 'x'.repeat(MAX_RESOLUTION_REASON_LENGTH)
    expect(resolutionReasonSchema.parse(`  ${atBound}  `)).toBe(atBound)
  })

  it('rejects a non-string reason', () => {
    for (const reason of [null, 42, ['PR #1'], { pr: 1 }]) {
      expect(
        resolveToolInputSchema.safeParse({ memoryId: MEMORY_ID, status: 'resolved', reason })
          .success,
      ).toBe(false)
    }
  })

  it('documents the field for agents (the description is part of the surface)', () => {
    expect(resolveToolInputSchema.shape.reason.description).toMatch(/commitments only/i)
  })
})
