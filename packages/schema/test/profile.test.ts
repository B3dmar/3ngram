// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { userProfileAttributesSchema } from '../src/profile.js'

describe('userProfileAttributesSchema', () => {
  it('accepts an empty object — every field is optional (a skip persists nothing)', () => {
    expect(userProfileAttributesSchema.parse({})).toEqual({})
  })

  it('accepts a full set of valid enum answers', () => {
    const value = {
      role: 'engineer',
      useCase: 'dev',
      aiTools: ['claude', 'cursor'],
      referralSource: 'reddit',
    }
    expect(userProfileAttributesSchema.parse(value)).toEqual(value)
  })

  it('rejects an out-of-domain role', () => {
    expect(userProfileAttributesSchema.safeParse({ role: 'ceo' }).success).toBe(false)
  })

  it('rejects an out-of-domain ai tool', () => {
    expect(userProfileAttributesSchema.safeParse({ aiTools: ['gemini'] }).success).toBe(false)
  })
})
