// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { DEFAULT_SCOPES, memoryTypeSchema, scopeSchema } from '../src/index.js'

describe('memory types', () => {
  it('is exactly the 8 documented types (docs/concepts/data-model.mdx)', () => {
    expect(memoryTypeSchema.options).toHaveLength(8)
    expect(memoryTypeSchema.options).toContain('event')
  })

  it('rejects legacy-system memory types', () => {
    expect(memoryTypeSchema.safeParse('context').success).toBe(false)
  })
})

describe('scopes', () => {
  it('accepts defaults and kebab-case customs', () => {
    for (const s of DEFAULT_SCOPES) {
      expect(scopeSchema.safeParse(s).success).toBe(true)
    }
    expect(scopeSchema.safeParse('client-acme').success).toBe(true)
  })

  it('rejects malformed scopes', () => {
    for (const bad of ['', 'Work', 'has space', '-leading', 'a'.repeat(65)]) {
      expect(scopeSchema.safeParse(bad).success).toBe(false)
    }
  })
})
