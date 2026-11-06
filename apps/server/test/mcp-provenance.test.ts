// SPDX-License-Identifier: Apache-2.0
import {
  getMemoriesInputSchema,
  getMemoriesOutputSchema,
  MAX_GET_PROVENANCE_RESPONSE_BYTES,
  MAX_GET_TOTAL_CHARS,
  MAX_PROVENANCE_EDGES,
  MAX_PROVENANCE_EVENTS,
  MAX_PROVENANCE_FACTS,
  MAX_PROVENANCE_IDS,
  MAX_PROVENANCE_PRODUCTS,
  MAX_PROVENANCE_PROPOSALS,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  MAX_TOPIC_LENGTH,
  type MemoryProvenance,
} from '@3ngram/schema'
import { describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({ getMemoriesByIds: vi.fn() }))
vi.mock('@3ngram/core', () => core)
const { INSPECT_TOOLS } = await import('../src/mcp/tools-inspect.js')
const tool = INSPECT_TOOLS[0]
if (!tool) throw new Error('get_memories missing')
const date = '2026-11-06T00:00:00.000Z'
const uuid = () => crypto.randomUUID()
const fill = <T>(size: number, value: () => T) => Array.from({ length: size }, value)
const source = { proposalKind: 'retention' as const, proposalId: uuid() }

function fullTrace(): MemoryProvenance {
  return {
    origin: {
      actorKind: 'user_dashboard',
      createdAt: date,
      sessionRunId: uuid(),
      run: { agent: 'a'.repeat(64), openedAt: date },
    },
    supersession: {
      predecessors: fill(MAX_PROVENANCE_EDGES, () => ({
        id: uuid(),
        memoryType: 'commitment',
        topic: '\u0001'.repeat(MAX_TOPIC_LENGTH),
        scope: 'a'.repeat(64),
        project: '\u0001'.repeat(256),
        status: 'archived',
        validFrom: date,
        validTo: date,
        recordedAt: date,
        createdAt: date,
        edgeId: uuid(),
        fromId: uuid(),
        toId: uuid(),
        edgeType: 'supersedes',
        createdBy: 'user_dashboard',
        depth: 24,
        sourceProposal: source,
        createdBySessionRunId: uuid(),
      })),
      successors: [],
      truncated: true,
    },
    events: {
      items: fill(MAX_PROVENANCE_EVENTS, () => ({
        id: uuid(),
        eventKind: 'embed_failed',
        actorKind: 'user_dashboard',
        createdAt: date,
        sessionRunId: uuid(),
        sourceProposal: source,
      })),
      truncated: true,
    },
    proposals: {
      items: fill(MAX_PROVENANCE_PROPOSALS, () => ({
        id: uuid(),
        kind: 'retention',
        edgeType: 'supersedes',
        action: 'supersede',
        otherMemoryId: uuid(),
        createdAt: date,
        decidedAt: date,
        produced: {
          edgeIds: fill(MAX_PROVENANCE_PRODUCTS, uuid),
          factIds: fill(MAX_PROVENANCE_PRODUCTS, uuid),
          eventIds: fill(MAX_PROVENANCE_PRODUCTS, uuid),
          truncated: true,
        },
      })),
      truncated: true,
    },
    facts: {
      items: fill(MAX_PROVENANCE_FACTS, () => ({
        id: uuid(),
        validFrom: date,
        validTo: date,
        sourceProposalId: uuid(),
      })),
      truncated: true,
    },
  }
}

describe('get_memories provenance surface', () => {
  it('narrows only provenance requests to five ids', () => {
    const ids = fill(6, uuid)
    expect(getMemoriesInputSchema.safeParse({ ids, include: ['provenance'] }).success).toBe(false)
    expect(getMemoriesInputSchema.safeParse({ ids }).success).toBe(true)
    expect(
      getMemoriesInputSchema.safeParse({ ids: ids.slice(0, 5), include: ['provenance'] }).success,
    ).toBe(true)
    expect(
      getMemoriesInputSchema.safeParse({ ids: ids.slice(0, 1), include: ['unknown'] }).success,
    ).toBe(false)
  })

  it('forwards the include and bounds the complete escaped MCP wire response', async () => {
    const ids = fill(MAX_PROVENANCE_IDS, uuid)
    const maxContentChars = Math.floor(MAX_GET_TOTAL_CHARS / MAX_PROVENANCE_IDS)
    const memories = ids.map((id) => ({
      id,
      memoryType: 'commitment',
      topic: '\u0001'.repeat(MAX_TOPIC_LENGTH),
      content: '\u0001'.repeat(maxContentChars),
      contentLength: maxContentChars,
      truncated: false,
      scope: 'a'.repeat(64),
      project: '\u0001'.repeat(256),
      status: 'archived',
      supersededBy: { id: uuid(), edgeType: 'supersedes' },
      commitmentStatus: 'resolved',
      tags: fill(MAX_TAGS, () => '\u0001'.repeat(MAX_TAG_LENGTH)),
      validFrom: new Date(date),
      validTo: new Date(date),
      recordedAt: new Date(date),
      provenance: fullTrace(),
    }))
    core.getMemoriesByIds.mockResolvedValue({ memories, notFound: [] })
    const userId = uuid()
    const result = await tool.handler(
      { ids, maxContentChars, include: ['provenance'] },
      { userId, scopes: ['memory:read'] },
    )
    expect(core.getMemoriesByIds).toHaveBeenCalledWith(userId, ids, {
      maxContentChars,
      include: ['provenance'],
    })
    const parsed = getMemoriesOutputSchema.parse(result.structuredContent)
    expect(parsed.memories.map((m) => m.provenance)).toEqual(memories.map((m) => m.provenance))
    const block = result.content?.[0] as { type: string; text: string }
    expect(JSON.parse(block.text)).toEqual(result.structuredContent)
    const bytes = Buffer.byteLength(JSON.stringify(result))
    expect(bytes).toBeLessThan(MAX_GET_PROVENANCE_RESPONSE_BYTES)
  })
})
