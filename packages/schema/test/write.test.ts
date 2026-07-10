// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  EDGE_TYPES,
  edgeInputSchema,
  MAX_CONTENT_LENGTH,
  MAX_TAGS,
  rememberInputSchema,
  reviseInputSchema,
} from '../src/index.js'

const UUID_A = '01890b6e-0000-7000-8000-000000000001'
const UUID_B = '01890b6e-0000-7000-8000-000000000002'

const validRemember = {
  memoryType: 'decision',
  topic: 'pin capture contract in schema',
  content: 'The Go hook conforms to packages/schema, never redefines validation.',
}

describe('rememberInput', () => {
  it('accepts a minimal payload and applies scope/tags defaults', () => {
    const parsed = rememberInputSchema.parse(validRemember)
    expect(parsed.scope).toBe('personal')
    expect(parsed.tags).toEqual([])
    expect(parsed.project).toBeUndefined()
  })

  it('trims topic and content', () => {
    const parsed = rememberInputSchema.parse({
      ...validRemember,
      topic: '  spaced topic  ',
      content: '  spaced content  ',
    })
    expect(parsed.topic).toBe('spaced topic')
    expect(parsed.content).toBe('spaced content')
  })

  it('rejects empty topic and empty content', () => {
    expect(rememberInputSchema.safeParse({ ...validRemember, topic: '   ' }).success).toBe(false)
    expect(rememberInputSchema.safeParse({ ...validRemember, content: '' }).success).toBe(false)
  })

  it('rejects content over the S5 capture ceiling', () => {
    const tooLong = { ...validRemember, content: 'a'.repeat(MAX_CONTENT_LENGTH + 1) }
    expect(rememberInputSchema.safeParse(tooLong).success).toBe(false)
    const atLimit = { ...validRemember, content: 'a'.repeat(MAX_CONTENT_LENGTH) }
    expect(rememberInputSchema.safeParse(atLimit).success).toBe(true)
  })

  it('rejects a legacy-system memory type', () => {
    expect(rememberInputSchema.safeParse({ ...validRemember, memoryType: 'context' }).success).toBe(
      false,
    )
  })

  it('rejects malformed scope', () => {
    expect(rememberInputSchema.safeParse({ ...validRemember, scope: 'Work' }).success).toBe(false)
  })

  it('rejects too many tags', () => {
    const tags = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag-${i}`)
    expect(rememberInputSchema.safeParse({ ...validRemember, tags }).success).toBe(false)
  })

  it('rejects unknown keys (strict)', () => {
    expect(rememberInputSchema.safeParse({ ...validRemember, embedding: [0.1, 0.2] }).success).toBe(
      false,
    )
  })
})

describe('reviseInput', () => {
  it('requires a predecessor and defaults the edge intent to supersedes', () => {
    const parsed = reviseInputSchema.parse({ ...validRemember, predecessorId: UUID_A })
    expect(parsed.predecessorId).toBe(UUID_A)
    expect(parsed.edgeIntent).toBe('supersedes')
  })

  it('accepts the updates edge intent', () => {
    const parsed = reviseInputSchema.parse({
      ...validRemember,
      predecessorId: UUID_A,
      edgeIntent: 'updates',
    })
    expect(parsed.edgeIntent).toBe('updates')
  })

  it('rejects additive edge intents (extends/derives are not revisions)', () => {
    for (const intent of ['extends', 'derives']) {
      expect(
        reviseInputSchema.safeParse({
          ...validRemember,
          predecessorId: UUID_A,
          edgeIntent: intent,
        }).success,
      ).toBe(false)
    }
  })

  it('rejects a missing or malformed predecessor id', () => {
    expect(reviseInputSchema.safeParse({ ...validRemember }).success).toBe(false)
    expect(
      reviseInputSchema.safeParse({ ...validRemember, predecessorId: 'not-a-uuid' }).success,
    ).toBe(false)
  })
})

describe('edgeInput', () => {
  it('accepts every documented edge type', () => {
    for (const edgeType of EDGE_TYPES) {
      const parsed = edgeInputSchema.parse({
        fromId: UUID_A,
        toId: UUID_B,
        edgeType,
        createdBy: 'worker',
      })
      expect(parsed.edgeType).toBe(edgeType)
    }
  })

  it('rejects a self-edge (mirrors the DB no-self CHECK)', () => {
    expect(
      edgeInputSchema.safeParse({
        fromId: UUID_A,
        toId: UUID_A,
        edgeType: 'supersedes',
        createdBy: 'user_mcp',
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown edge type and an unknown actor kind', () => {
    expect(
      edgeInputSchema.safeParse({
        fromId: UUID_A,
        toId: UUID_B,
        edgeType: 'replaces',
        createdBy: 'worker',
      }).success,
    ).toBe(false)
    expect(
      edgeInputSchema.safeParse({
        fromId: UUID_A,
        toId: UUID_B,
        edgeType: 'supersedes',
        createdBy: 'robot',
      }).success,
    ).toBe(false)
  })
})
