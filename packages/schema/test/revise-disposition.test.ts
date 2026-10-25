// SPDX-License-Identifier: Apache-2.0
// The `revise` disposition contract (issue #217): a bounded, unique id batch,
// strict everywhere, a strict free-text-free event payload, and per-id outcomes.
import { describe, expect, it } from 'vitest'
import {
  archiveEventPayloadSchema,
  MAX_REVISE_DISPOSITION_IDS,
  nativeReviseDispositionBodySchema,
  nativeReviseDispositionInputSchema,
  nativeReviseRequestSchema,
  reaffirmEventPayloadSchema,
  reviseDispositionOutputSchema,
  reviseRequestSchema,
  reviseToolOutputV2Schema,
  reviseToolRequestSchema,
} from '../src/index.js'

const id = (n: number) => `01890b6e-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const ids = (count: number) => Array.from({ length: count }, (_, n) => id(n + 1))

describe('archive disposition input (#217)', () => {
  it('accepts 1 to MAX unique ids, with an optional sessionRunId', () => {
    expect(MAX_REVISE_DISPOSITION_IDS).toBe(50)
    for (const count of [1, MAX_REVISE_DISPOSITION_IDS]) {
      const parsed = nativeReviseDispositionInputSchema.parse({
        kind: 'archive',
        memoryIds: ids(count),
      })
      expect(parsed.memoryIds).toHaveLength(count)
    }
    expect(
      nativeReviseDispositionInputSchema.parse({
        kind: 'archive',
        memoryIds: ids(1),
        sessionRunId: id(99),
      }).sessionRunId,
    ).toBe(id(99))
  })

  it('rejects an empty batch, an oversized batch, and a non-uuid id', () => {
    const bad = [[], ids(MAX_REVISE_DISPOSITION_IDS + 1), ['not-a-uuid']]
    for (const memoryIds of bad) {
      expect(
        nativeReviseDispositionInputSchema.safeParse({ kind: 'archive', memoryIds }).success,
      ).toBe(false)
    }
  })

  it('rejects a repeated id, case-insensitively (ids are normalized to lower case)', () => {
    const upper = id(1).toUpperCase()
    const result = nativeReviseDispositionInputSchema.safeParse({
      kind: 'archive',
      memoryIds: [id(1), upper],
    })
    expect(result.success).toBe(false)
    expect(
      nativeReviseDispositionInputSchema.parse({ kind: 'archive', memoryIds: [upper] }).memoryIds,
    ).toEqual([id(1)])
  })

  it('is strict: no predecessorId, no content, no free-text reason, no unknown kind', () => {
    for (const extra of [{ predecessorId: id(1) }, { content: 'x' }, { reason: 'stale' }]) {
      expect(
        nativeReviseDispositionInputSchema.safeParse({
          kind: 'archive',
          memoryIds: ids(1),
          ...extra,
        }).success,
      ).toBe(false)
    }
    expect(
      nativeReviseDispositionInputSchema.safeParse({ kind: 'delete', memoryIds: ids(1) }).success,
    ).toBe(false)
    expect(nativeReviseDispositionInputSchema.safeParse({ kind: 'archive' }).success).toBe(false)
  })

  it('rides the tool request union, but never the successor | move contract of core revise()', () => {
    const archive = { kind: 'archive', memoryIds: ids(2) }
    expect(reviseToolRequestSchema.parse(archive)).toEqual(archive)
    expect(nativeReviseRequestSchema.safeParse(archive).success).toBe(false)
    expect(reviseRequestSchema.safeParse(archive).success).toBe(false)
  })

  it('REST body carries no memoryIds: the URL id is the batch', () => {
    expect(nativeReviseDispositionBodySchema.parse({ kind: 'archive' })).toEqual({
      kind: 'archive',
    })
    expect(
      nativeReviseDispositionBodySchema.safeParse({ kind: 'archive', memoryIds: ids(1) }).success,
    ).toBe(false)
  })
})

describe('archive event payload (#217)', () => {
  it('is exactly { disposition, sessionRunId? }', () => {
    expect(archiveEventPayloadSchema.parse({ disposition: 'archive' })).toEqual({
      disposition: 'archive',
    })
    expect(
      archiveEventPayloadSchema.parse({ disposition: 'archive', sessionRunId: id(1) }),
    ).toEqual({ disposition: 'archive', sessionRunId: id(1) })
    expect(archiveEventPayloadSchema.safeParse({}).success).toBe(false)
    expect(
      archiveEventPayloadSchema.safeParse({ disposition: 'archive', note: 'why' }).success,
    ).toBe(false)
    expect(archiveEventPayloadSchema.safeParse({ disposition: 'move' }).success).toBe(false)
  })
})

describe('disposition output (#217)', () => {
  it('reports one outcome per id; a reason only names a known code', () => {
    const output = {
      kind: 'archive',
      outcomes: [
        { memoryId: id(1), outcome: 'archived' },
        { memoryId: id(2), outcome: 'already_archived' },
        { memoryId: id(3), outcome: 'rejected', reason: 'open_commitment' },
      ],
    }
    expect(reviseDispositionOutputSchema.parse(output)).toEqual(output)
    expect(reviseToolOutputV2Schema.parse(output)).toEqual(output)
    expect(
      reviseDispositionOutputSchema.safeParse({
        kind: 'archive',
        outcomes: [{ memoryId: id(1), outcome: 'rejected', reason: 'because' }],
      }).success,
    ).toBe(false)
  })

  it('the V2 tool output still parses the written-memory shape', () => {
    const written = {
      memory: { id: id(1), memoryType: 'note', topic: 't', scope: 'personal', project: null },
      embedded: 'off',
    }
    expect(reviseToolOutputV2Schema.parse(written)).toEqual(written)
  })
})

describe('reaffirm disposition (#218)', () => {
  it('takes the same bounded, unique, strict batch as archive', () => {
    expect(
      nativeReviseDispositionInputSchema.parse({ kind: 'reaffirm', memoryIds: ids(3) }).kind,
    ).toBe('reaffirm')
    expect(reviseToolRequestSchema.parse({ kind: 'reaffirm', memoryIds: ids(1) })).toEqual({
      kind: 'reaffirm',
      memoryIds: ids(1),
    })
    for (const bad of [
      { kind: 'reaffirm', memoryIds: [] },
      { kind: 'reaffirm', memoryIds: ids(MAX_REVISE_DISPOSITION_IDS + 1) },
      { kind: 'reaffirm', memoryIds: [id(1), id(1)] },
      // No content, topic or date rides a review: it rewrites nothing.
      { kind: 'reaffirm', memoryIds: ids(1), content: 'still true' },
      { kind: 'reaffirm', memoryIds: ids(1), validFrom: '2026-01-01T00:00:00Z' },
    ]) {
      expect(nativeReviseDispositionInputSchema.safeParse(bad).success).toBe(false)
    }
    expect(
      nativeReviseRequestSchema.safeParse({ kind: 'reaffirm', memoryIds: ids(1) }).success,
    ).toBe(false)
  })

  it('event payload is exactly { disposition: reaffirm, sessionRunId? }', () => {
    expect(reaffirmEventPayloadSchema.parse({ disposition: 'reaffirm' })).toEqual({
      disposition: 'reaffirm',
    })
    expect(reaffirmEventPayloadSchema.safeParse({ disposition: 'archive' }).success).toBe(false)
    expect(
      reaffirmEventPayloadSchema.safeParse({ disposition: 'reaffirm', note: 'why' }).success,
    ).toBe(false)
  })

  it('outcomes add reaffirmed and the archived rejection', () => {
    const output = {
      kind: 'reaffirm',
      outcomes: [
        { memoryId: id(1), outcome: 'reaffirmed' },
        { memoryId: id(2), outcome: 'rejected', reason: 'archived' },
      ],
    }
    expect(reviseDispositionOutputSchema.parse(output)).toEqual(output)
  })
})
