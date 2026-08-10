// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  EDGE_TYPES,
  edgeInputSchema,
  factWriteSchema,
  MAX_CONTENT_LENGTH,
  MAX_FACTS_PER_WRITE,
  MAX_TAGS,
  rememberInputSchema,
  rememberWithFactsInputSchema,
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

describe('factWrite', () => {
  const validFact = { subject: 'lift.back_squat', predicate: 'top_set.weight_kg', value: '98' }

  it('accepts a minimal triple and leaves the validity window open', () => {
    const parsed = factWriteSchema.parse(validFact)
    expect(parsed.validFrom).toBeUndefined()
    expect(parsed.validTo).toBeUndefined()
  })

  it('keeps instants as ISO strings and treats explicit null as absent', () => {
    const parsed = factWriteSchema.parse({
      ...validFact,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
    })
    // ISO string, NOT a Date: this contract is published as JSON Schema on the
    // remember tool, where a z.date() leg is unrepresentable. Core converts to
    // a Date once, on the way to the db (the asOfSchema precedent).
    expect(parsed.validFrom).toBe('2026-01-01T00:00:00.000Z')
    // null means DB-NULL (absent), never the 1970 epoch — an epoch validTo
    // would mark a live fact as already closed.
    expect(parsed.validTo).toBeUndefined()
  })

  it('rejects a Date and a non-ISO string (JSON has no date type)', () => {
    expect(factWriteSchema.safeParse({ ...validFact, validFrom: new Date() }).success).toBe(false)
    expect(factWriteSchema.safeParse({ ...validFact, validFrom: 'yesterday' }).success).toBe(false)
  })

  it('rejects a validTo with no validFrom (a window that ends but never begins)', () => {
    // Mirrors fact_proposals_validity_check: unrepresentable downstream, so it
    // fails at the validation boundary rather than as a constraint violation.
    expect(
      factWriteSchema.safeParse({ ...validFact, validTo: '2026-01-01T00:00:00.000Z' }).success,
    ).toBe(false)
  })

  it('rejects an inverted validity window', () => {
    expect(
      factWriteSchema.safeParse({
        ...validFact,
        validFrom: '2026-01-02T00:00:00.000Z',
        validTo: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false)
  })

  it('orders MIXED-PRECISION instants by time, not lexicographically', () => {
    // Regression: the refine compares parsed ISO strings, and string `<=` is
    // lexicographic — '.' (0x2E) sorts before 'Z' (0x5A). Same-length pairs
    // (every other case here) mask it; these differ in precision, which is
    // exactly what a model-written call produces.
    // A REAL 1ms window must be accepted:
    expect(
      factWriteSchema.safeParse({
        ...validFact,
        validFrom: '2026-01-01T00:00:00Z',
        validTo: '2026-01-01T00:00:00.001Z',
      }).success,
    ).toBe(true)
    // and the inverted pair rejected, though it sorts as "ascending" as text:
    expect(
      factWriteSchema.safeParse({
        ...validFact,
        validFrom: '2026-01-01T00:00:00.001Z',
        validTo: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(false)
    // Equal instants written at different precisions are a zero-length window,
    // which the DB CHECK admits (valid_from <= valid_to), so the schema must too.
    expect(
      factWriteSchema.safeParse({
        ...validFact,
        validFrom: '2026-01-01T00:00:00Z',
        validTo: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true)
  })

  it('bounds the triple and the confidence', () => {
    expect(factWriteSchema.safeParse({ ...validFact, subject: '' }).success).toBe(false)
    expect(factWriteSchema.safeParse({ ...validFact, subject: 'x'.repeat(257) }).success).toBe(
      false,
    )
    expect(
      factWriteSchema.safeParse({ ...validFact, value: 'v'.repeat(MAX_CONTENT_LENGTH + 1) })
        .success,
    ).toBe(false)
    expect(factWriteSchema.safeParse({ ...validFact, confidence: 1.1 }).success).toBe(false)
    expect(factWriteSchema.safeParse({ ...validFact, confidence: 1 }).success).toBe(true)
  })

  it('rejects unknown keys (strict)', () => {
    expect(factWriteSchema.safeParse({ ...validFact, memoryId: UUID_A }).success).toBe(false)
    expect(factWriteSchema.safeParse({ ...validFact, recordedAt: new Date() }).success).toBe(false)
  })
})

describe('rememberWithFactsInput', () => {
  const validFact = { subject: 'lift.back_squat', predicate: 'top_set.weight_kg', value: '98' }

  it('accepts a remember payload carrying facts, and one carrying none', () => {
    const withFacts = rememberWithFactsInputSchema.parse({ ...validRemember, facts: [validFact] })
    expect(withFacts.facts).toHaveLength(1)
    expect(rememberWithFactsInputSchema.parse(validRemember).facts).toBeUndefined()
  })

  it('treats an empty list as absent for the write path', () => {
    // Pinned because the db layer omits factIds for both — an empty array must
    // not become a distinguishable "wrote zero facts" result.
    const parsed = rememberWithFactsInputSchema.parse({ ...validRemember, facts: [] })
    expect(parsed.facts).toEqual([])
  })

  it('caps the number of facts per write', () => {
    const many = Array.from({ length: MAX_FACTS_PER_WRITE + 1 }, (_, i) => ({
      ...validFact,
      predicate: `p${i}`,
    }))
    expect(rememberWithFactsInputSchema.safeParse({ ...validRemember, facts: many }).success).toBe(
      false,
    )
    expect(
      rememberWithFactsInputSchema.safeParse({ ...validRemember, facts: many.slice(1) }).success,
    ).toBe(true)
  })

  it('propagates a bad fact through the composed schema', () => {
    expect(
      rememberWithFactsInputSchema.safeParse({
        ...validRemember,
        facts: [{ ...validFact, value: '' }],
      }).success,
    ).toBe(false)
  })

  it('keeps the base remember and revise contracts free of facts', () => {
    // LOAD-BEARING: the facts contract is composed BESIDE the shipped base, so
    // revise (which extends the base) still rejects a facts key under strict
    // mode. Facts belong to the assertion that introduced them; a revision
    // appends a NEW memory and must not silently carry them across.
    expect(rememberInputSchema.safeParse({ ...validRemember, facts: [validFact] }).success).toBe(
      false,
    )
    expect(
      reviseInputSchema.safeParse({
        ...validRemember,
        predecessorId: UUID_A,
        facts: [validFact],
      }).success,
    ).toBe(false)
  })
})
