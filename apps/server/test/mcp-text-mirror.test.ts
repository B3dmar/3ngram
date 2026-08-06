// SPDX-License-Identifier: Apache-2.0
// Wire-size ceiling for the get_memories text mirror (issue #75).
//
// Every tool result carries its payload TWICE — a JSON text mirror for
// pre-structuredContent clients plus structuredContent (see the `ok` doc comment
// in src/mcp/tools.ts for why that cannot be dropped). get_memories is the only
// tool whose budget makes the duplication material: its aggregate bound is
// MAX_GET_TOTAL_CHARS (262,144 chars), so the doubled result is a ~600 KB
// response.
//
// WHAT THIS TEST DEFENDS: not the mirror itself, which is deliberate, but the
// coupling between the schema budgets and the wire cost. Raising
// MAX_GET_TOTAL_CHARS or MAX_GET_CONTENT_CHARS silently raises the response size
// by a factor of ~2.1, and nothing else in the suite would notice.
//
// It drives the REAL registered handler through a mocked core read, so the
// production `ok()` shape and the production output schema are what get
// measured — a test that rebuilt the envelope locally would keep passing after
// someone changed the envelope.
import { MAX_GET_MEMORIES_IDS, MAX_GET_TOTAL_CHARS } from '@3ngram/schema'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The worst case a caller can legally request: the full id batch, each item at
 * the largest per-item cap the aggregate refine still admits
 * (ids × maxContentChars ≤ MAX_GET_TOTAL_CHARS).
 */
const PER_ITEM_CHARS = Math.floor(MAX_GET_TOTAL_CHARS / MAX_GET_MEMORIES_IDS)

/**
 * Ceiling on the serialized CallToolResult, in bytes. The measured worst case is
 * 599 KB (284 KB structured + 315 KB mirror, a 2.11x factor); 640 KB leaves ~7%
 * for uuid/timestamp formatting without leaving room for a budget increase — a
 * 10% rise in MAX_GET_TOTAL_CHARS clears it and fails here.
 *
 * If this fails, the question is NOT "raise the ceiling". It is whether the
 * budget change was intended to roughly double the bytes on the wire.
 */
const WIRE_CEILING_BYTES = 640 * 1024

/**
 * Prose with quotes and newlines: the mirror is stringified and then embedded in
 * a `text` field, so the envelope's own serialization escapes those a SECOND
 * time. Content with no quotes would understate the real cost.
 */
const CHUNK = 'He said "this is a decision", and then:\n- a bullet\n- another\n'
const BODY = CHUNK.repeat(Math.ceil(PER_ITEM_CHARS / CHUNK.length)).slice(0, PER_ITEM_CHARS)

const IDS = Array.from({ length: MAX_GET_MEMORIES_IDS }, () => crypto.randomUUID())

const getMemoriesByIds = vi.fn(() =>
  Promise.resolve({
    memories: IDS.map((id) => ({
      id,
      memoryType: 'decision' as const,
      topic: 'a representative topic line of the kind an agent writes',
      content: BODY,
      contentLength: BODY.length,
      truncated: false,
      scope: 'work',
      project: '3ngram',
      status: 'active' as const,
      commitmentStatus: null,
      tags: ['alpha', 'beta', 'gamma'],
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: null,
      recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    })),
    notFound: [],
  }),
)

vi.mock('@3ngram/core', () => ({ getMemoriesByIds }))

const { INSPECT_TOOLS } = await import('../src/mcp/tools-inspect.js')

function getMemoriesTool() {
  const tool = INSPECT_TOOLS.find((t) => t.name === 'get_memories')
  if (tool === undefined) throw new Error('get_memories is not registered')
  return tool
}

async function worstCaseResult(): Promise<CallToolResult> {
  return (await getMemoriesTool().handler(
    { ids: IDS, maxContentChars: PER_ITEM_CHARS },
    { userId: crypto.randomUUID(), scopes: ['memory:read'] },
  )) as CallToolResult
}

describe('get_memories text-mirror wire cost (issue #75)', () => {
  it('sends the payload twice — the mirror is present, not incidental', async () => {
    // Pins the CONTRACT the ceiling is about. If someone drops the mirror, this
    // fails first and names the reason, rather than leaving a size assertion to
    // pass for the wrong reason.
    const result = await worstCaseResult()
    const [block] = result.content ?? []
    expect(block).toMatchObject({ type: 'text' })
    expect(result.structuredContent).toBeDefined()
    const mirrored = JSON.parse((block as { text: string }).text)
    expect(mirrored).toEqual(result.structuredContent)
  })

  it('keeps the worst-case serialized result under the wire ceiling', async () => {
    const bytes = Buffer.byteLength(JSON.stringify(await worstCaseResult()), 'utf8')
    expect(bytes).toBeLessThan(WIRE_CEILING_BYTES)
  })

  it('costs MORE than 2x, because the mirror is escaped a second time', async () => {
    // Documents the arithmetic the issue got slightly wrong (it assumed a flat
    // 2x). The mirror leg is larger than the structured leg for identical data.
    const result = await worstCaseResult()
    const structuredLeg = JSON.stringify(result.structuredContent)
    const mirrorLeg = JSON.stringify(result.content?.[0])
    expect(mirrorLeg.length).toBeGreaterThan(structuredLeg.length)
    const total = JSON.stringify(result).length
    expect(total / structuredLeg.length).toBeGreaterThan(2)
  })
})
