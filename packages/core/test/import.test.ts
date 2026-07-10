// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. The import facade's validation boundary, the 'importer'
// actor stamping, timestamp coercion, and the embed knobs (operation key
// override + skipEmbed), with packages/db mocked. Integration coverage
// (atomicity, FSM insert-with-initial-status, valid_to close, facts round-trip)
// lives in test/integration/import.int.test.ts against real Postgres.
import { createHash } from 'node:crypto'
import { createFakeGateway } from '@3ngram/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const expectZodRejection = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: 'ZodError' })

const writeImportedMemory = vi.fn()
const appendImportedEvent = vi.fn()
const writeImportedEdge = vi.fn()
const insertImportedFact = vi.fn()
const updateMemoryEmbedding = vi.fn()
const recordEmbedFailure = vi.fn()
const insertLlmUsage = vi.fn()

vi.mock('@3ngram/db', () => ({
  writeImportedMemory: (...a: unknown[]) => writeImportedMemory(...a),
  appendImportedEvent: (...a: unknown[]) => appendImportedEvent(...a),
  writeImportedEdge: (...a: unknown[]) => writeImportedEdge(...a),
  insertImportedFact: (...a: unknown[]) => insertImportedFact(...a),
  updateMemoryEmbedding: (...a: unknown[]) => updateMemoryEmbedding(...a),
  recordEmbedFailure: (...a: unknown[]) => recordEmbedFailure(...a),
  insertLlmUsage: (...a: unknown[]) => insertLlmUsage(...a),
  DuplicateMemoryError: class extends Error {},
  EdgeConflictError: class extends Error {},
  ImportTargetNotFoundError: class extends Error {},
  PredecessorAlreadySupersededError: class extends Error {},
  PredecessorNotFoundError: class extends Error {},
}))

const { IMPORT_EMBED_OPERATION, importEdge, importEvent, importFact, importMemory } = await import(
  '../src/import/index.js'
)

const USER = '00000000-0000-7000-8000-000000000001'
const MEM_A = '00000000-0000-7000-8000-00000000000a'
const MEM_B = '00000000-0000-7000-8000-00000000000b'
const silentLogger = { warn: () => {} }

const validInput = () => ({
  memoryType: 'note',
  topic: 'historical decision',
  content: 'we migrated the deploy pipeline to merge queues',
  tags: ['ops'],
})

afterEach(() => {
  writeImportedMemory.mockReset()
  appendImportedEvent.mockReset()
  writeImportedEdge.mockReset()
  insertImportedFact.mockReset()
  updateMemoryEmbedding.mockReset()
  recordEmbedFailure.mockReset()
  insertLlmUsage.mockReset()
})

describe('importMemory (validation boundary)', () => {
  it('rejects an unknown field (strict schema) before any DB call', async () => {
    await expectZodRejection(importMemory(USER, { ...validInput(), sourceId: 'x' }))
    expect(writeImportedMemory).not.toHaveBeenCalled()
  })

  it('rejects commitment state on a non-commitment memory type', async () => {
    await expectZodRejection(
      importMemory(USER, { ...validInput(), commitment: { status: 'resolved' } }),
    )
    expect(writeImportedMemory).not.toHaveBeenCalled()
  })

  it('rejects validFrom after validTo', async () => {
    await expectZodRejection(
      importMemory(USER, {
        ...validInput(),
        validFrom: '2025-06-01T00:00:00Z',
        validTo: '2025-05-01T00:00:00Z',
      }),
    )
    expect(writeImportedMemory).not.toHaveBeenCalled()
  })

  it('rejects an invalid timestamp string before any DB call', async () => {
    await expectZodRejection(importMemory(USER, { ...validInput(), validTo: 'not-a-date' }))
    expect(writeImportedMemory).not.toHaveBeenCalled()
  })

  it('treats explicit JSON null timestamps as absent, never the 1970 epoch', async () => {
    writeImportedMemory.mockResolvedValue({ id: MEM_A })

    await importMemory(
      USER,
      { ...validInput(), recordedAt: null, validFrom: null, validTo: null },
      { skipEmbed: true },
    )

    const call = writeImportedMemory.mock.calls[0]?.[0]
    expect(call.recordedAt).toBeUndefined()
    expect(call.validFrom).toBeUndefined()
    expect(call.validTo).toBeUndefined()
  })

  it('rejects an event payload over the serialized ceiling', async () => {
    const oversized = { blob: 'x'.repeat(5000) }
    await expectZodRejection(importMemory(USER, { ...validInput(), event: { payload: oversized } }))
    expect(writeImportedMemory).not.toHaveBeenCalled()
  })

  it('stamps the importer actor and forwards coerced overrides + content hash', async () => {
    writeImportedMemory.mockResolvedValue({ id: MEM_A })
    const input = {
      ...validInput(),
      status: 'archived',
      recordedAt: '2024-03-01T12:00:00Z',
      validFrom: '2024-03-01T12:00:00Z',
      event: {
        payload: { sourceId: '42', sourceType: 'decision' },
        createdAt: '2024-03-01T12:00:00Z',
      },
    }

    const result = await importMemory(USER, input, { skipEmbed: true })

    expect(result.id).toBe(MEM_A)
    const call = writeImportedMemory.mock.calls[0]?.[0]
    expect(call.userId).toBe(USER)
    expect(call.actorKind).toBe('importer')
    expect(call.status).toBe('archived')
    expect(call.recordedAt).toEqual(new Date('2024-03-01T12:00:00Z'))
    expect(call.event.payload).toEqual({ sourceId: '42', sourceType: 'decision' })
    expect(call.event.createdAt).toEqual(new Date('2024-03-01T12:00:00Z'))
    expect(call.contentHash).toBe(createHash('sha256').update(input.content).digest('hex'))
  })

  it('counts only active, unsuperseded imports against the live-memory cap', async () => {
    writeImportedMemory.mockResolvedValue({ id: MEM_A })
    const limits = vi.fn().mockResolvedValue({ maxLiveMemories: 3 })

    await importMemory(USER, validInput(), { skipEmbed: true, limits })
    expect(writeImportedMemory).toHaveBeenLastCalledWith(expect.any(Object), 3)

    await importMemory(USER, { ...validInput(), status: 'archived' }, { skipEmbed: true, limits })
    expect(writeImportedMemory).toHaveBeenLastCalledWith(expect.any(Object), undefined)

    await importMemory(
      USER,
      { ...validInput(), validTo: '2025-01-01T00:00:00Z' },
      { skipEmbed: true, limits },
    )
    expect(writeImportedMemory).toHaveBeenLastCalledWith(expect.any(Object), undefined)
    expect(limits).toHaveBeenCalledTimes(1)
  })

  it('forwards the initial commitment FSM state for a commitment-type memory', async () => {
    writeImportedMemory.mockResolvedValue({ id: MEM_A, commitmentId: 'c1' })

    const result = await importMemory(
      USER,
      {
        ...validInput(),
        memoryType: 'commitment',
        commitment: {
          status: 'resolved',
          owner: 'seb',
          dueAt: '2025-01-01T00:00:00Z',
          resolvedAt: '2025-01-02T00:00:00Z',
        },
      },
      { skipEmbed: true },
    )

    expect(result.commitmentId).toBe('c1')
    const call = writeImportedMemory.mock.calls[0]?.[0]
    expect(call.commitment.status).toBe('resolved')
    expect(call.commitment.resolvedAt).toEqual(new Date('2025-01-02T00:00:00Z'))
  })
})

describe('importMemory (embed knobs)', () => {
  it('embeds under the import operation key by default', async () => {
    writeImportedMemory.mockResolvedValue({ id: MEM_A })
    updateMemoryEmbedding.mockResolvedValue(true)
    const gateway = createFakeGateway()

    const result = await importMemory(USER, validInput(), { gateway, logger: silentLogger })

    expect(await result.embed.settled).toBe(true)
    expect(gateway.calls.embed[0]?.operation).toBe(IMPORT_EMBED_OPERATION)
    // Cost tracking: one usage row under the import operation key.
    expect(insertLlmUsage).toHaveBeenCalledTimes(1)
    expect(insertLlmUsage.mock.calls[0]?.[1]?.operation).toBe(IMPORT_EMBED_OPERATION)
  })

  it('honours a caller-supplied operation key', async () => {
    writeImportedMemory.mockResolvedValue({ id: MEM_A })
    updateMemoryEmbedding.mockResolvedValue(true)
    const gateway = createFakeGateway()

    const result = await importMemory(USER, validInput(), {
      gateway,
      logger: silentLogger,
      operation: 'backfill.embed',
    })

    expect(await result.embed.settled).toBe(true)
    expect(gateway.calls.embed[0]?.operation).toBe('backfill.embed')
  })

  it('skips the embed entirely with skipEmbed even when a gateway is injected', async () => {
    writeImportedMemory.mockResolvedValue({ id: MEM_A })
    const gateway = createFakeGateway()

    const result = await importMemory(USER, validInput(), {
      gateway,
      logger: silentLogger,
      skipEmbed: true,
    })

    expect(await result.embed.settled).toBe(false)
    expect(gateway.calls.embed).toHaveLength(0)
    expect(updateMemoryEmbedding).not.toHaveBeenCalled()
  })
})

describe('importEvent', () => {
  it('rejects non-historical event kinds (import/embed_failed are reserved)', async () => {
    await expectZodRejection(importEvent(USER, { memoryId: MEM_A, eventKind: 'import' }))
    await expectZodRejection(importEvent(USER, { memoryId: MEM_A, eventKind: 'embed_failed' }))
    expect(appendImportedEvent).not.toHaveBeenCalled()
  })

  it('stamps the importer actor and forwards the original timestamp', async () => {
    appendImportedEvent.mockResolvedValue({ id: 'e1' })

    const result = await importEvent(USER, {
      memoryId: MEM_A,
      eventKind: 'resolve',
      payload: { sourceEventId: '7' },
      createdAt: '2024-05-05T05:05:05Z',
    })

    expect(result.id).toBe('e1')
    const call = appendImportedEvent.mock.calls[0]?.[0]
    expect(call.actorKind).toBe('importer')
    expect(call.eventKind).toBe('resolve')
    expect(call.createdAt).toEqual(new Date('2024-05-05T05:05:05Z'))
  })
})

describe('importEdge', () => {
  it('rejects closePredecessorAt on a non-supersedes edge', async () => {
    await expectZodRejection(
      importEdge(USER, {
        fromId: MEM_A,
        toId: MEM_B,
        edgeType: 'extends',
        closePredecessorAt: '2024-01-01T00:00:00Z',
      }),
    )
    expect(writeImportedEdge).not.toHaveBeenCalled()
  })

  it('rejects a self-edge', async () => {
    await expectZodRejection(importEdge(USER, { fromId: MEM_A, toId: MEM_A, edgeType: 'updates' }))
    expect(writeImportedEdge).not.toHaveBeenCalled()
  })

  it('stamps created_by importer and forwards the close instant', async () => {
    writeImportedEdge.mockResolvedValue(undefined)

    await importEdge(USER, {
      fromId: MEM_A,
      toId: MEM_B,
      edgeType: 'supersedes',
      closePredecessorAt: '2024-02-02T00:00:00Z',
    })

    const call = writeImportedEdge.mock.calls[0]?.[0]
    expect(call.createdBy).toBe('importer')
    expect(call.edgeType).toBe('supersedes')
    expect(call.closePredecessorAt).toEqual(new Date('2024-02-02T00:00:00Z'))
  })
})

describe('importFact', () => {
  it('rejects a confidence outside [0, 1]', async () => {
    await expectZodRejection(
      importFact(USER, {
        memoryId: MEM_A,
        subject: 's',
        predicate: 'p',
        value: 'v',
        confidence: 2,
      }),
    )
    expect(insertImportedFact).not.toHaveBeenCalled()
  })

  it('forwards the bi-temporal range and confidence', async () => {
    insertImportedFact.mockResolvedValue({ id: 'f1' })

    const result = await importFact(USER, {
      memoryId: MEM_A,
      subject: 'pipeline',
      predicate: 'deploys_via',
      value: 'merge queue',
      confidence: 0.9,
      validFrom: '2024-01-01T00:00:00Z',
      validTo: '2025-01-01T00:00:00Z',
    })

    expect(result.id).toBe('f1')
    const call = insertImportedFact.mock.calls[0]?.[0]
    expect(call.confidence).toBe(0.9)
    expect(call.validFrom).toEqual(new Date('2024-01-01T00:00:00Z'))
    expect(call.validTo).toEqual(new Date('2025-01-01T00:00:00Z'))
  })
})
