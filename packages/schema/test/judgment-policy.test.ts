// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  judgmentModeSchema,
  judgmentPolicyBodySchema,
  judgmentPolicyResponseSchema,
} from '../src/judgment-policy.js'

describe('judgment opt-in schema (issue #225)', () => {
  it('has exactly two modes, off and on', () => {
    expect(judgmentModeSchema.options).toEqual(['off', 'on'])
  })

  it('requires the whole policy and rejects extra keys', () => {
    expect(judgmentPolicyBodySchema.parse({ mode: 'on' })).toEqual({ mode: 'on' })
    expect(() => judgmentPolicyBodySchema.parse({})).toThrow()
    expect(() => judgmentPolicyBodySchema.parse({ mode: 'always' })).toThrow()
    expect(() => judgmentPolicyBodySchema.parse({ mode: 'on', userId: 'x' })).toThrow()
  })

  it('reports a null updatedAt for the unstored default', () => {
    expect(
      judgmentPolicyResponseSchema.parse({ mode: 'off', updatedAt: null }).updatedAt,
    ).toBeNull()
  })
})
