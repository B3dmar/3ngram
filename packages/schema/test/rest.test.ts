// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  invalidInputRestErrorResponseSchema,
  MAX_REST_ERROR_DETAIL_LENGTH,
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
        },
      ],
      eventsTruncated: false,
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
            payload: { source: 'raw value' },
          },
        ],
        eventsTruncated: false,
      }).success,
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
