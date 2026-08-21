// SPDX-License-Identifier: Apache-2.0
// Timestamp semantics at the import boundary: JSON `null` on an optional
// timestamp is DB-NULL (absent) — never coerced to the 1970 epoch — while a
// required-position timestamp rejects null, and invalid strings always fail.
import { describe, expect, it } from 'vitest'
import {
  eventKindSchema,
  importEdgeInputSchema,
  importEventInputSchema,
  importEventKindSchema,
  importFactInputSchema,
  importMemoryInputSchema,
  importTimestampSchema,
  MAX_CONTENT_LENGTH,
  MAX_IMPORT_CONTENT_LENGTH,
  rememberInputSchema,
} from '../src/index.js'

const UUID_A = '01890b6e-0000-7000-8000-000000000001'
const UUID_B = '01890b6e-0000-7000-8000-000000000002'

const validMemory = {
  memoryType: 'note',
  topic: 'historical decision',
  content: 'we migrated the deploy pipeline to merge queues',
}

describe('importTimestampSchema (required position)', () => {
  it('parses a valid ISO-8601 string to a Date', () => {
    expect(importTimestampSchema.parse('2024-03-01T12:00:00Z')).toEqual(
      new Date('2024-03-01T12:00:00Z'),
    )
  })

  it('passes a Date through', () => {
    const instant = new Date('2024-03-01T12:00:00Z')
    expect(importTimestampSchema.parse(instant)).toEqual(instant)
  })

  it('rejects null instead of coercing it to the 1970 epoch', () => {
    expect(importTimestampSchema.safeParse(null).success).toBe(false)
  })

  it('rejects a string that is not a parseable date', () => {
    expect(importTimestampSchema.safeParse('not-a-date').success).toBe(false)
  })
})

describe('import timestamps with explicit JSON null (DB-NULL semantics)', () => {
  it('treats null validTo as absent — the memory stays live, never epoch-superseded', () => {
    const parsed = importMemoryInputSchema.parse({ ...validMemory, validTo: null })
    expect(parsed.validTo).toBeUndefined()
    expect(parsed.status).toBe('active')
  })

  it('treats null as absent across every optional timestamp field', () => {
    const parsed = importMemoryInputSchema.parse({
      ...validMemory,
      memoryType: 'commitment',
      recordedAt: null,
      validFrom: null,
      validTo: null,
      event: { createdAt: null },
      commitment: { dueAt: null, resolvedAt: null },
    })
    expect(parsed.recordedAt).toBeUndefined()
    expect(parsed.validFrom).toBeUndefined()
    expect(parsed.validTo).toBeUndefined()
    expect(parsed.event?.createdAt).toBeUndefined()
    expect(parsed.commitment?.dueAt).toBeUndefined()
    expect(parsed.commitment?.resolvedAt).toBeUndefined()
  })

  it('treats null as absent on event, edge, and fact payloads', () => {
    const event = importEventInputSchema.parse({
      memoryId: UUID_A,
      eventKind: 'resolve',
      createdAt: null,
    })
    expect(event.createdAt).toBeUndefined()

    const edge = importEdgeInputSchema.parse({
      fromId: UUID_A,
      toId: UUID_B,
      edgeType: 'extends',
      closePredecessorAt: null,
    })
    expect(edge.closePredecessorAt).toBeUndefined()

    const fact = importFactInputSchema.parse({
      memoryId: UUID_A,
      subject: 's',
      predicate: 'p',
      value: 'v',
      validFrom: null,
      validTo: null,
      recordedAt: null,
    })
    expect(fact.validFrom).toBeUndefined()
    expect(fact.validTo).toBeUndefined()
    expect(fact.recordedAt).toBeUndefined()
  })

  it('still rejects an invalid timestamp string on an optional field', () => {
    expect(
      importMemoryInputSchema.safeParse({ ...validMemory, validTo: 'not-a-date' }).success,
    ).toBe(false)
  })

  it('still parses a valid ISO-8601 string on an optional field', () => {
    const parsed = importMemoryInputSchema.parse({
      ...validMemory,
      validTo: '2025-05-01T00:00:00Z',
    })
    expect(parsed.validTo).toEqual(new Date('2025-05-01T00:00:00Z'))
  })
})

describe('importEventKindSchema (FR-004: replay full lifecycle history, #220)', () => {
  it('accepts supersede and unresolve (real supersession + commitment-reopen history)', () => {
    expect(importEventKindSchema.safeParse('supersede').success).toBe(true)
    expect(importEventKindSchema.safeParse('unresolve').success).toBe(true)
  })

  it('still accepts the original create/revise/resolve/archive kinds', () => {
    for (const kind of ['create', 'revise', 'resolve', 'archive']) {
      expect(importEventKindSchema.safeParse(kind).success).toBe(true)
    }
  })

  it('rejects the reserved kinds import and embed_failed', () => {
    expect(importEventKindSchema.safeParse('import').success).toBe(false)
    expect(importEventKindSchema.safeParse('embed_failed').success).toBe(false)
  })

  it('is derived from eventKindSchema minus the reserved kinds (drift guard)', () => {
    const expected = eventKindSchema.options.filter(
      (kind) => kind !== 'import' && kind !== 'embed_failed',
    )
    expect([...importEventKindSchema.options].sort()).toEqual([...expected].sort())
  })

  it('accepts a supersede import event end-to-end via importEventInputSchema', () => {
    const event = importEventInputSchema.parse({
      memoryId: UUID_A,
      eventKind: 'supersede',
      createdAt: '2025-05-01T00:00:00Z',
    })
    expect(event.eventKind).toBe('supersede')
  })
})

describe('import payload reserved sessionRunId (issue #166)', () => {
  it('rejects sessionRunId on importEvent payload', () => {
    expect(
      importEventInputSchema.safeParse({
        memoryId: UUID_A,
        eventKind: 'create',
        payload: { sessionRunId: UUID_B },
      }).success,
    ).toBe(false)
  })

  it('rejects a null sessionRunId the same way — the key is reserved', () => {
    expect(
      importEventInputSchema.safeParse({
        memoryId: UUID_A,
        eventKind: 'create',
        payload: { sessionRunId: null },
      }).success,
    ).toBe(false)
  })

  it('rejects sessionRunId on the import memory event override', () => {
    expect(
      importMemoryInputSchema.safeParse({
        ...validMemory,
        event: { payload: { sessionRunId: UUID_B } },
      }).success,
    ).toBe(false)
  })

  it('still accepts other bounded payload keys', () => {
    const event = importEventInputSchema.parse({
      memoryId: UUID_A,
      eventKind: 'create',
      payload: { source: 'legacy-engram', id: 'abc' },
    })
    expect(event.payload).toEqual({ source: 'legacy-engram', id: 'abc' })
  })
})

describe('import content bound (frozen mapping: historical blobs land as-is)', () => {
  it('accepts content over the native cap on import, while remember rejects it', () => {
    const overNativeCap = { ...validMemory, content: 'a'.repeat(MAX_CONTENT_LENGTH + 1) }
    expect(rememberInputSchema.safeParse(overNativeCap).success).toBe(false)
    expect(importMemoryInputSchema.safeParse(overNativeCap).success).toBe(true)
  })

  it('accepts content at the import ceiling and rejects one char over', () => {
    const atCeiling = { ...validMemory, content: 'a'.repeat(MAX_IMPORT_CONTENT_LENGTH) }
    expect(importMemoryInputSchema.safeParse(atCeiling).success).toBe(true)

    const overCeiling = { ...validMemory, content: 'a'.repeat(MAX_IMPORT_CONTENT_LENGTH + 1) }
    expect(importMemoryInputSchema.safeParse(overCeiling).success).toBe(false)
  })

  it('keeps the native topic bound — only content diverges', () => {
    const longTopic = { ...validMemory, topic: 't'.repeat(257) }
    expect(importMemoryInputSchema.safeParse(longTopic).success).toBe(false)
  })
})
