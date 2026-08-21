// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. Ack-before-embed ordering and the non-throwing failure
// path, with @3ngram/db mocked and @3ngram/llm's FakeGateway (plus a hand-rolled
// throwing Gateway stub — FakeGateway has no failure injection). Integration
// coverage (the vector actually lands 1536-dim and is searchable) lives in
// test/integration/embed.int.test.ts.

import type { Gateway } from '@3ngram/llm'
import { createFakeGateway } from '@3ngram/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const writeMemory = vi.fn()
const reviseMemory = vi.fn()
const updateMemoryEmbedding = vi.fn()
const recordEmbedFailure = vi.fn()
const insertLlmUsage = vi.fn()

vi.mock('@3ngram/db', () => ({
  writeMemory: (...a: unknown[]) => writeMemory(...a),
  reviseMemory: (...a: unknown[]) => reviseMemory(...a),
  updateMemoryEmbedding: (...a: unknown[]) => updateMemoryEmbedding(...a),
  recordEmbedFailure: (...a: unknown[]) => recordEmbedFailure(...a),
  insertLlmUsage: (...a: unknown[]) => insertLlmUsage(...a),
  DuplicateMemoryError: class extends Error {},
  UnknownSessionRunError: class extends Error {},
  EdgeConflictError: class extends Error {},
  PredecessorAlreadySupersededError: class extends Error {},
  PredecessorNotFoundError: class extends Error {},
}))

const { remember } = await import('../src/write/remember.js')
const { revise } = await import('../src/write/revise.js')
const { classifyEmbedFailure, EMPTY_EMBED_INPUT_REASON, kickEmbed, MAX_EMBED_INPUT_LENGTH } =
  await import('../src/write/embed.js')

const USER = '00000000-0000-7000-8000-000000000001'
const PRED = '00000000-0000-7000-8000-0000000000cc'
const ACTOR = 'user_api' as const
const silentLogger = { warn: () => {} }

const input = () => ({ memoryType: 'note', topic: 't', content: 'embed me please', tags: [] })

afterEach(() => {
  writeMemory.mockReset()
  reviseMemory.mockReset()
  updateMemoryEmbedding.mockReset()
  recordEmbedFailure.mockReset()
  insertLlmUsage.mockReset()
})

describe('remember (ack-before-embed)', () => {
  it('does NOT touch the gateway when none is injected (embedding stays NULL)', async () => {
    writeMemory.mockResolvedValue({ id: 'm1' })
    const result = await remember(USER, input(), ACTOR)

    expect(result.id).toBe('m1')
    expect(await result.embed.settled).toBe(false)
    expect(updateMemoryEmbedding).not.toHaveBeenCalled()
  })

  it('ACKs the caller BEFORE the embed round-trip completes', async () => {
    writeMemory.mockResolvedValue({ id: 'm2' })
    updateMemoryEmbedding.mockResolvedValue(true)

    // A gateway whose embed resolves only when we release it — proves the caller
    // gets its result before the embed settles (no sleep).
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const gateway: Gateway = {
      embed: async (texts) => {
        await gate
        return {
          embeddings: texts.map(() => Array.from({ length: 1536 }, () => 0.1)),
          usage: { inputTokens: 7 },
          model: 'text-embedding-3-large',
        }
      },
      complete: async () => 'x',
    }

    const result = await remember(USER, input(), ACTOR, { gateway, logger: silentLogger })

    // Caller already has its ack while the embed is still pending.
    expect(result.id).toBe('m2')
    expect(updateMemoryEmbedding).not.toHaveBeenCalled()

    release()
    expect(await result.embed.settled).toBe(true)
    expect(updateMemoryEmbedding).toHaveBeenCalledTimes(1)
    expect(updateMemoryEmbedding.mock.calls[0]?.[0]).toBe(USER)
    expect(updateMemoryEmbedding.mock.calls[0]?.[1]).toBe('m2')
  })

  it('passes the 1536-dim FakeGateway vector to the db helper', async () => {
    writeMemory.mockResolvedValue({ id: 'm3' })
    updateMemoryEmbedding.mockResolvedValue(true)
    const gateway = createFakeGateway()

    const result = await remember(USER, input(), ACTOR, { gateway, logger: silentLogger })
    expect(await result.embed.settled).toBe(true)

    expect(gateway.calls.embed[0]?.operation).toBe('memory.embed')
    const vector = updateMemoryEmbedding.mock.calls[0]?.[2] as number[]
    expect(vector).toHaveLength(1536)
  })

  it('records exactly one llm_usage row with non-zero tokens + cost (issue #231)', async () => {
    writeMemory.mockResolvedValue({ id: 'm-cost' })
    updateMemoryEmbedding.mockResolvedValue(true)
    insertLlmUsage.mockResolvedValue(undefined)
    const gateway = createFakeGateway()

    const result = await remember(USER, input(), ACTOR, { gateway, logger: silentLogger })
    expect(await result.embed.settled).toBe(true)

    // One row per embed() call — not per text, not per memory.
    expect(insertLlmUsage).toHaveBeenCalledTimes(1)
    const [userArg, usage] = insertLlmUsage.mock.calls[0] ?? []
    expect(userArg).toBe(USER)
    expect(usage.operation).toBe('memory.embed')
    expect(usage.model).toBe('text-embedding-3-large')
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.outputTokens).toBe(0)
    // text-embedding-3-large is priced ($0.13/1M tok), so cost is positive.
    expect(usage.costUsd).toBeGreaterThan(0)
  })

  it('does NOT break the embed when recording the usage row fails (best-effort)', async () => {
    writeMemory.mockResolvedValue({ id: 'm-cost-fail' })
    updateMemoryEmbedding.mockResolvedValue(true)
    insertLlmUsage.mockRejectedValue(new Error('db unavailable'))
    const gateway = createFakeGateway()

    const result = await remember(USER, input(), ACTOR, { gateway, logger: silentLogger })
    // The vector still lands; the cost-row failure is swallowed + logged.
    expect(await result.embed.settled).toBe(true)
    expect(updateMemoryEmbedding).toHaveBeenCalledTimes(1)
  })

  it('records an embed_failed event and NEVER throws when the gateway fails', async () => {
    writeMemory.mockResolvedValue({ id: 'm4' })
    recordEmbedFailure.mockResolvedValue(undefined)
    // The provider error message QUOTES the offending input text — a realistic
    // leak vector. The persisted reason and any log line must NOT contain it.
    const SENTINEL = 'my secret diary entry about the affair'
    const gatewayError = Object.assign(new Error(`invalid input for embedding: "${SENTINEL}"`), {
      name: 'GatewayError',
      status: 429,
    })
    const gateway: Gateway = {
      embed: async () => {
        throw gatewayError
      },
      complete: async () => 'x',
    }

    const logLines: Array<{ obj: Record<string, unknown>; msg: string }> = []
    const capturingLogger = {
      warn: (obj: Record<string, unknown>, msg: string) => logLines.push({ obj, msg }),
    }

    // The caller resolves cleanly (the failure never throws into it)...
    const result = await remember(USER, input(), ACTOR, { gateway, logger: capturingLogger })
    expect(result.id).toBe('m4')

    // ...and the failure path settles false + records the audit event.
    expect(await result.embed.settled).toBe(false)
    expect(updateMemoryEmbedding).not.toHaveBeenCalled()
    expect(recordEmbedFailure).toHaveBeenCalledTimes(1)
    const [u, m, actor, reason] = recordEmbedFailure.mock.calls[0] ?? []
    expect(u).toBe(USER)
    expect(m).toBe('m4')
    expect(actor).toBe(ACTOR)

    // The persisted reason is a classified, bounded label — never the raw
    // message, never the sentinel content (hard rule 6).
    const persistedReason = reason as string
    expect(persistedReason).not.toContain(SENTINEL)
    expect(persistedReason).not.toContain('invalid input')
    expect(persistedReason).toContain('GatewayError')
    expect(persistedReason).toContain('429')
    expect(persistedReason).toContain(`msg len ${gatewayError.message.length}`)

    // No log line carries the sentinel either; the failure log carries the same
    // classified reason.
    const serializedLogs = JSON.stringify(logLines)
    expect(serializedLogs).not.toContain(SENTINEL)
    expect(serializedLogs).not.toContain('invalid input')
    const failureLog = logLines.find((l) => l.msg.includes('memory embedding failed'))
    expect(failureLog?.obj.reason).toBe(persistedReason)
  })

  it('settles false (no throw) when the gateway returns no vector', async () => {
    writeMemory.mockResolvedValue({ id: 'm5' })
    recordEmbedFailure.mockResolvedValue(undefined)
    const gateway: Gateway = {
      embed: async () => ({ embeddings: [], usage: { inputTokens: 0 }, model: 'm' }),
      complete: async () => 'x',
    }

    const result = await remember(USER, input(), ACTOR, { gateway, logger: silentLogger })
    expect(await result.embed.settled).toBe(false)
    expect(recordEmbedFailure).toHaveBeenCalledTimes(1)
  })
})

describe('revise (ack-before-embed)', () => {
  it('embeds the SUCCESSOR content after ack', async () => {
    reviseMemory.mockResolvedValue({ id: 'succ' })
    updateMemoryEmbedding.mockResolvedValue(true)
    const gateway = createFakeGateway()

    const result = await revise(
      USER,
      { ...input(), content: 'successor content', predecessorId: PRED },
      ACTOR,
      { gateway, logger: silentLogger },
    )

    expect(result.id).toBe('succ')
    expect(await result.embed.settled).toBe(true)
    expect(gateway.calls.embed[0]?.texts).toEqual(['successor content'])
    expect(updateMemoryEmbedding.mock.calls[0]?.[1]).toBe('succ')
  })

  it('does NOT embed when no gateway is injected', async () => {
    reviseMemory.mockResolvedValue({ id: 'succ2' })
    const result = await revise(USER, { ...input(), predecessorId: PRED }, ACTOR)
    expect(await result.embed.settled).toBe(false)
    expect(updateMemoryEmbedding).not.toHaveBeenCalled()
  })
})

describe('kickEmbed (embed-input bound)', () => {
  it('truncates the EMBED INPUT for oversized content — import-path blobs exceed model token caps', async () => {
    updateMemoryEmbedding.mockResolvedValue(true)
    const gateway = createFakeGateway()
    const oversized = 'a'.repeat(MAX_EMBED_INPUT_LENGTH + 50_000)

    const { settled } = kickEmbed(USER, 'm-big', oversized, ACTOR, {
      gateway,
      logger: silentLogger,
    })
    expect(await settled).toBe(true)

    const sent = gateway.calls.embed[0]?.texts[0]
    expect(sent).toHaveLength(MAX_EMBED_INPUT_LENGTH)
    expect(sent).toBe(oversized.slice(0, MAX_EMBED_INPUT_LENGTH))
  })

  it('passes content at or under the bound through untouched', async () => {
    updateMemoryEmbedding.mockResolvedValue(true)
    const gateway = createFakeGateway()
    const exact = 'b'.repeat(MAX_EMBED_INPUT_LENGTH)

    const { settled } = kickEmbed(USER, 'm-exact', exact, ACTOR, {
      gateway,
      logger: silentLogger,
    })
    expect(await settled).toBe(true)
    expect(gateway.calls.embed[0]?.texts[0]).toBe(exact)
  })
})

describe('kickEmbed (empty-input guard, #232)', () => {
  it.each([
    ['zero-length', ''],
    ['whitespace-only', ' \t\n  '],
  ])('records a deterministic empty_input embed_failed WITHOUT a gateway call (%s)', async (_label, text) => {
    recordEmbedFailure.mockResolvedValue(undefined)
    const gateway = createFakeGateway()

    const { settled } = kickEmbed(USER, 'm-empty', text, ACTOR, {
      gateway,
      logger: silentLogger,
    })
    expect(await settled).toBe(false)

    // The provider 400s empty input deterministically — never call it.
    expect(gateway.calls.embed).toHaveLength(0)
    expect(updateMemoryEmbedding).not.toHaveBeenCalled()
    expect(recordEmbedFailure).toHaveBeenCalledTimes(1)
    expect(recordEmbedFailure).toHaveBeenCalledWith(
      USER,
      'm-empty',
      ACTOR,
      EMPTY_EMBED_INPUT_REASON,
    )
  })

  it('still settles false (never throws) when recording the empty_input event fails', async () => {
    recordEmbedFailure.mockRejectedValue(new Error('db unavailable'))
    const gateway = createFakeGateway()

    const { settled } = kickEmbed(USER, 'm-empty-2', '   ', ACTOR, {
      gateway,
      logger: silentLogger,
    })
    expect(await settled).toBe(false)
    expect(gateway.calls.embed).toHaveLength(0)
  })

  it('contains a SYNCHRONOUSLY throwing recorder on the empty-input path (settled resolves false, no unhandled rejection)', async () => {
    // The empty-input branch must carry the same outer catch
    // guard as the runEmbed path — a recorder that throws (not rejects) must
    // never reject `settled`, because production callers may ignore the handle.
    recordEmbedFailure.mockImplementation(() => {
      throw new Error('recorder threw synchronously')
    })
    const gateway = createFakeGateway()

    const { settled } = kickEmbed(USER, 'm-empty-3', '   ', ACTOR, {
      gateway,
      logger: silentLogger,
    })
    await expect(settled).resolves.toBe(false)
    expect(gateway.calls.embed).toHaveLength(0)
    expect(updateMemoryEmbedding).not.toHaveBeenCalled()
  })

  it('does NOT trip the guard for content with surrounding whitespace', async () => {
    updateMemoryEmbedding.mockResolvedValue(true)
    const gateway = createFakeGateway()

    const { settled } = kickEmbed(USER, 'm-padded', '  real content  ', ACTOR, {
      gateway,
      logger: silentLogger,
    })
    expect(await settled).toBe(true)
    expect(gateway.calls.embed).toHaveLength(1)
    expect(recordEmbedFailure).not.toHaveBeenCalled()
  })
})

describe('classifyEmbedFailure (gateway HTTP status, #232)', () => {
  it('persists the HTTP status from GatewayRequestError as the bounded code', async () => {
    const { GatewayRequestError } = await import('@3ngram/llm')
    const err = new GatewayRequestError('embed', 429)
    // "GatewayRequestError:429 (msg len 36)" — status visible, body-free. The
    // P2a embed_failed events lacked this, making 400-vs-429 undiagnosable.
    expect(classifyEmbedFailure(err)).toBe(
      `GatewayRequestError:429 (msg len ${err.message.length})`,
    )
  })
})
