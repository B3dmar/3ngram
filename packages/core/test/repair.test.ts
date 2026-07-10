// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. retryFailedEmbeds (repair path) with @3ngram/db
// mocked and FakeGateway / a throwing Gateway stub. Integration coverage (a
// real embed_failed row repaired against the runtime role) lives in
// test/integration/embed.int.test.ts.

import type { Gateway } from '@3ngram/llm'
import { createFakeGateway } from '@3ngram/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const listEmbedFailedMemories = vi.fn()
const updateMemoryEmbedding = vi.fn()
const recordEmbedFailure = vi.fn()
const insertLlmUsage = vi.fn()

vi.mock('@3ngram/db', () => ({
  listEmbedFailedMemories: (...a: unknown[]) => listEmbedFailedMemories(...a),
  updateMemoryEmbedding: (...a: unknown[]) => updateMemoryEmbedding(...a),
  recordEmbedFailure: (...a: unknown[]) => recordEmbedFailure(...a),
  insertLlmUsage: (...a: unknown[]) => insertLlmUsage(...a),
}))

const { retryFailedEmbeds } = await import('../src/write/repair.js')
const { EMPTY_EMBED_INPUT_REASON } = await import('../src/write/embed.js')

const USER = '00000000-0000-7000-8000-000000000001'
const silentLogger = { warn: () => {} }

afterEach(() => {
  listEmbedFailedMemories.mockReset()
  updateMemoryEmbedding.mockReset()
  recordEmbedFailure.mockReset()
  insertLlmUsage.mockReset()
})

describe('retryFailedEmbeds (#232 repair path)', () => {
  it('throws up front without an injected gateway (repair can only refail)', async () => {
    await expect(retryFailedEmbeds(USER, {})).rejects.toThrow(/gateway/)
    expect(listEmbedFailedMemories).not.toHaveBeenCalled()
  })

  it('re-embeds every candidate and lands the vectors', async () => {
    listEmbedFailedMemories.mockResolvedValue([
      { id: 'm1', content: 'board: "Todo"' },
      { id: 'm2', content: 'alias: "milestone #51"' },
    ])
    updateMemoryEmbedding.mockResolvedValue(true)
    const gateway = createFakeGateway()

    const result = await retryFailedEmbeds(USER, { gateway, logger: silentLogger })

    expect(result).toEqual({ scanned: 2, landed: 2, failed: 0 })
    expect(updateMemoryEmbedding).toHaveBeenCalledTimes(2)
    expect(updateMemoryEmbedding.mock.calls.map((c) => c[1])).toEqual(['m1', 'm2'])
    expect(recordEmbedFailure).not.toHaveBeenCalled()
  })

  it('appends a fresh classified embed_failed on refailure and keeps going', async () => {
    listEmbedFailedMemories.mockResolvedValue([
      { id: 'm-bad', content: 'still failing' },
      { id: 'm-good', content: 'embeds fine now' },
    ])
    recordEmbedFailure.mockResolvedValue(undefined)
    updateMemoryEmbedding.mockResolvedValue(true)
    let first = true
    const gateway: Gateway = {
      embed: async (texts) => {
        if (first) {
          first = false
          throw Object.assign(new Error('boom'), { name: 'GatewayRequestError', status: 429 })
        }
        return {
          embeddings: texts.map(() => Array.from({ length: 1536 }, () => 0.1)),
          usage: { inputTokens: 5 },
          model: 'text-embedding-3-large',
        }
      },
      complete: async () => 'x',
    }

    const result = await retryFailedEmbeds(USER, { gateway, logger: silentLogger })

    expect(result).toEqual({ scanned: 2, landed: 1, failed: 1 })
    expect(recordEmbedFailure).toHaveBeenCalledTimes(1)
    const [, memoryId, actor, reason] = recordEmbedFailure.mock.calls[0] ?? []
    expect(memoryId).toBe('m-bad')
    expect(actor).toBe('system') // default repair actor
    expect(reason).toContain('GatewayRequestError:429')
  })

  it('guards empty content deterministically — refailure WITHOUT a gateway call', async () => {
    listEmbedFailedMemories.mockResolvedValue([{ id: 'm-empty', content: '   ' }])
    recordEmbedFailure.mockResolvedValue(undefined)
    const gateway = createFakeGateway()

    const result = await retryFailedEmbeds(USER, {
      gateway,
      logger: silentLogger,
      actorKind: 'importer',
    })

    expect(result).toEqual({ scanned: 1, landed: 0, failed: 1 })
    expect(gateway.calls.embed).toHaveLength(0)
    expect(recordEmbedFailure).toHaveBeenCalledWith(
      USER,
      'm-empty',
      'importer',
      EMPTY_EMBED_INPUT_REASON,
    )
  })

  it('passes the page bound through to the db helper', async () => {
    listEmbedFailedMemories.mockResolvedValue([])
    const gateway = createFakeGateway()

    const result = await retryFailedEmbeds(USER, { gateway, logger: silentLogger, limit: 7 })

    expect(result).toEqual({ scanned: 0, landed: 0, failed: 0 })
    expect(listEmbedFailedMemories).toHaveBeenCalledWith(USER, 7)
  })
})
