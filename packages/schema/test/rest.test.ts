// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  invalidInputRestErrorResponseSchema,
  MAX_RESOLUTION_REASON_LENGTH,
  MAX_REST_ERROR_DETAIL_LENGTH,
  memoriesListQuerySchema,
  memoriesListResponseSchema,
  memoryDetailSchema,
  memoryHistoryResponseSchema,
} from '../src/index.js'

const iso = '2026-06-01T00:00:00.000Z'

describe('REST error response contract', () => {
  it('accepts detail at the boundary and rejects one character more', () => {
    expect(
      invalidInputRestErrorResponseSchema.safeParse({
        error: 'invalid_input',
        detail: 'x'.repeat(MAX_REST_ERROR_DETAIL_LENGTH),
      }).success,
    ).toBe(true)
    expect(
      invalidInputRestErrorResponseSchema.safeParse({
        error: 'invalid_input',
        detail: 'x'.repeat(MAX_REST_ERROR_DETAIL_LENGTH + 1),
      }).success,
    ).toBe(false)
  })
})

function identity(id = crypto.randomUUID()) {
  return {
    id,
    memoryType: 'note',
    topic: 'history row',
    project: '3ngram',
    scope: 'work',
    status: 'active',
    validFrom: iso,
    validTo: null,
    recordedAt: iso,
    createdAt: iso,
    isCurrent: true,
    lifecycleState: 'current',
  }
}

describe('REST memory history contract', () => {
  it('accepts identity-only lineage and payload metadata', () => {
    const current = identity()
    const predecessor = { ...identity(), id: crypto.randomUUID(), lifecycleState: 'superseded' }
    const edge = {
      id: crypto.randomUUID(),
      fromId: current.id,
      toId: predecessor.id,
      edgeType: 'supersedes',
      createdBy: 'user_api',
      createdAt: iso,
    }

    const parsed = memoryHistoryResponseSchema.parse({
      memory: current,
      lineage: { nodes: [current, predecessor], edges: [edge], truncated: false },
      directRelationships: {
        predecessors: [{ memory: predecessor, edge }],
        successors: [],
        truncated: false,
      },
      auditEvents: [
        {
          id: crypto.randomUUID(),
          eventKind: 'create',
          actorKind: 'user_api',
          createdAt: iso,
          payloadMetadata: { present: true, jsonType: 'object', byteLength: 20 },
          sessionRunId: null,
        },
      ],
      eventsTruncated: false,
      createdBySessionRunId: null,
      lastResolutionReason: null,
    })

    expect(parsed.lineage.nodes).toHaveLength(2)
  })

  it('rejects memory content and raw event payload values', () => {
    const current = identity()
    expect(
      memoryHistoryResponseSchema.safeParse({
        memory: { ...current, content: 'must not leak' },
        lineage: { nodes: [current], edges: [], truncated: false },
        directRelationships: { predecessors: [], successors: [], truncated: false },
        auditEvents: [],
        eventsTruncated: false,
        createdBySessionRunId: null,
        lastResolutionReason: null,
      }).success,
    ).toBe(false)

    expect(
      memoryHistoryResponseSchema.safeParse({
        memory: current,
        lineage: { nodes: [current], edges: [], truncated: false },
        directRelationships: { predecessors: [], successors: [], truncated: false },
        auditEvents: [
          {
            id: crypto.randomUUID(),
            eventKind: 'create',
            actorKind: 'user_api',
            createdAt: iso,
            payloadMetadata: { present: true, jsonType: 'object', byteLength: 10 },
            sessionRunId: null,
            payload: { source: 'raw value' },
          },
        ],
        eventsTruncated: false,
        createdBySessionRunId: null,
        lastResolutionReason: null,
      }).success,
    ).toBe(false)
  })
})

// Issue #262: the creating run is exposed as an allowlisted sibling field, an id
// in its canonical spelling — never an arbitrary payload key or a non-uuid.
describe('REST memory history session provenance (#262)', () => {
  const RUN = '01890b6e-0000-7000-8000-000000000262'
  function envelope(event: Record<string, unknown>, createdBySessionRunId: unknown) {
    const current = identity()
    return {
      memory: current,
      lineage: { nodes: [current], edges: [], truncated: false },
      directRelationships: { predecessors: [], successors: [], truncated: false },
      auditEvents: [
        {
          id: crypto.randomUUID(),
          eventKind: 'create',
          actorKind: 'user_mcp',
          createdAt: iso,
          payloadMetadata: { present: true, jsonType: 'object', byteLength: 55 },
          ...event,
        },
      ],
      eventsTruncated: false,
      createdBySessionRunId,
      lastResolutionReason: null,
    }
  }

  it('accepts a uuid or null on the event and the envelope, canonicalized to lowercase', () => {
    const parsed = memoryHistoryResponseSchema.parse(
      envelope({ sessionRunId: RUN.toUpperCase() }, RUN.toUpperCase()),
    )
    expect(parsed.auditEvents[0]?.sessionRunId).toBe(RUN)
    expect(parsed.createdBySessionRunId).toBe(RUN)
    expect(
      memoryHistoryResponseSchema.safeParse(envelope({ sessionRunId: null }, null)).success,
    ).toBe(true)
  })

  it('requires both fields (null means "not recorded", absence is not a value)', () => {
    expect(memoryHistoryResponseSchema.safeParse(envelope({}, null)).success).toBe(false)
    expect(
      memoryHistoryResponseSchema.safeParse(envelope({ sessionRunId: null }, undefined)).success,
    ).toBe(false)
  })

  it('rejects a non-uuid value and any other payload key beside it', () => {
    expect(
      memoryHistoryResponseSchema.safeParse(envelope({ sessionRunId: 'not-a-run' }, null)).success,
    ).toBe(false)
    expect(
      memoryHistoryResponseSchema.safeParse(envelope({ sessionRunId: null }, 'x')).success,
    ).toBe(false)
    expect(
      memoryHistoryResponseSchema.safeParse(
        envelope({ sessionRunId: RUN, reason: 'free text is not allowlisted' }, RUN),
      ).success,
    ).toBe(false)
  })
})

// Issue #234: the commitment's latest-transition reason rides the envelope as a
// required, bounded, nullable field — content, but only on this owner read.
describe('REST memory history lastResolutionReason (#234)', () => {
  function withReason(lastResolutionReason: unknown) {
    const current = identity()
    return {
      memory: current,
      lineage: { nodes: [current], edges: [], truncated: false },
      directRelationships: { predecessors: [], successors: [], truncated: false },
      auditEvents: [],
      eventsTruncated: false,
      createdBySessionRunId: null,
      lastResolutionReason,
    }
  }

  it('accepts a bounded reason or null', () => {
    expect(memoryHistoryResponseSchema.parse(withReason('PR #234')).lastResolutionReason).toBe(
      'PR #234',
    )
    expect(memoryHistoryResponseSchema.parse(withReason(null)).lastResolutionReason).toBeNull()
    expect(
      memoryHistoryResponseSchema.safeParse(withReason('x'.repeat(MAX_RESOLUTION_REASON_LENGTH)))
        .success,
    ).toBe(true)
  })

  it('requires the field and rejects empty or oversize values', () => {
    expect(memoryHistoryResponseSchema.safeParse(withReason(undefined)).success).toBe(false)
    expect(memoryHistoryResponseSchema.safeParse(withReason('')).success).toBe(false)
    expect(
      memoryHistoryResponseSchema.safeParse(
        withReason('x'.repeat(MAX_RESOLUTION_REASON_LENGTH + 1)),
      ).success,
    ).toBe(false)
  })
})

const listItem = {
  id: '11111111-1111-4111-8111-111111111111',
  memoryType: 'commitment',
  topic: 'follow up',
  project: '3ngram',
  scope: 'work',
  status: 'active',
  commitmentStatus: 'resolved',
  recordedAt: iso,
  createdAt: iso,
}

const detail = {
  ...listItem,
  content: 'send the update',
  tags: ['work'],
  validFrom: iso,
  validTo: null,
}

describe('memoriesListQuerySchema — recorded-range hardening (issue #58, MCP parity)', () => {
  it('REJECTS an inverted recorded_at range (recordedAfter later than recordedBefore)', () => {
    const inverted = memoriesListQuerySchema.safeParse({
      recordedAfter: '2026-02-01T00:00:00Z',
      recordedBefore: '2026-01-01T00:00:00Z',
    })
    expect(inverted.success).toBe(false)
    // Equal bounds are a valid single-instant range (both bounds inclusive).
    expect(
      memoriesListQuerySchema.safeParse({
        recordedAfter: '2026-01-01T00:00:00Z',
        recordedBefore: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(true)
    // A well-ordered range still parses.
    expect(
      memoriesListQuerySchema.safeParse({
        recordedAfter: '2026-01-01T00:00:00Z',
        recordedBefore: '2026-02-01T00:00:00Z',
      }).success,
    ).toBe(true)
  })

  it('REJECTS sub-millisecond recorded bounds; accepts up to 3 fractional digits', () => {
    // At the bound: millisecond precision (what the transport's ISO→Date
    // conversion can represent losslessly) parses.
    expect(
      memoriesListQuerySchema.safeParse({ recordedAfter: '2026-01-01T00:00:00.123Z' }).success,
    ).toBe(true)
    // Past the bound: microsecond-ish precision is rejected per bound rather
    // than silently truncated (recorded_at stores microseconds in Postgres).
    expect(
      memoriesListQuerySchema.safeParse({ recordedAfter: '2026-01-01T00:00:00.1234Z' }).success,
    ).toBe(false)
    expect(
      memoriesListQuerySchema.safeParse({ recordedBefore: '2026-01-01T00:00:00.123456Z' }).success,
    ).toBe(false)
  })

  it('ADVERTISES the precision limit in emitted REST JSON Schema', () => {
    const json = z.toJSONSchema(memoriesListQuerySchema, {
      target: 'draft-2020-12',
      io: 'input',
    })
    const props = json.properties as Record<string, { description?: string }>
    expect(props.recordedAfter?.description).toMatch(/at most 3 fractional-second digits/i)
    expect(props.recordedBefore?.description).toMatch(/at most 3 fractional-second digits/i)
  })
})

describe('REST memory contracts', () => {
  it('allows commitmentStatus on list rows while keeping list rows content-free', () => {
    const parsed = memoriesListResponseSchema.parse({ memories: [listItem], count: 1, total: 1 })
    expect(parsed.memories[0]?.commitmentStatus).toBe('resolved')

    const leaked = memoriesListResponseSchema.safeParse({
      memories: [{ ...listItem, content: 'must not ship in list payloads' }],
      count: 1,
      total: 1,
    })
    expect(leaked.success).toBe(false)
  })

  it('allows commitmentStatus on detail rows', () => {
    const parsed = memoryDetailSchema.parse(detail)
    expect(parsed.commitmentStatus).toBe('resolved')
  })
})
