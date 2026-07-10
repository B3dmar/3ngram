// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '../src/env.js'
import { createLogger } from '../src/logger.js'
import { hashUserId, redactDeep } from '../src/redaction.js'

interface LogLine {
  [key: string]: unknown
}

function createSink(): { lines: LogLine[]; stream: { write: (chunk: string) => void } } {
  const lines: LogLine[] = []
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as LogLine)
      },
    },
  }
}

const memory = {
  id: 'mem-123',
  user_id: 'user-456',
  memory_type: 'note',
  status: 'open',
  topic: 'secret topic line',
  content: 'the user is allergic to penicillin',
  embedding: [0.1, 0.2, 0.3],
}

describe('redaction-by-construction (docs/concepts/observability.mdx §1 — the mandatory redaction test)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvCache()
  })

  it('a memory object logged via the production config exits redacted', () => {
    const { lines, stream } = createSink()
    createLogger(stream).info({ memory }, 'memory written')

    const line = lines[0] as LogLine
    const logged = line.memory as LogLine
    expect(logged.content).toBeUndefined()
    expect(logged.topic).toBeUndefined()
    expect(logged.embedding).toBeUndefined()
    expect(logged.content_len).toBe(memory.content.length)
    expect(logged.content_sha256_8).toMatch(/^[0-9a-f]{8}$/)
    expect(logged.topic_len).toBe(memory.topic.length)
    expect(logged.embedding_len).toBe(3)
    expect(logged.id).toBe('mem-123')
    expect(logged.memory_type).toBe('note')
    expect(JSON.stringify(line)).not.toContain('penicillin')
    expect(JSON.stringify(line)).not.toContain('secret topic')
  })

  it('redacts memory rows in arrays under arbitrary keys (the result-list case)', () => {
    const { lines, stream } = createSink()
    createLogger(stream).info({ results: [memory, memory], query: 'what allergies?' })

    const line = lines[0] as LogLine
    const results = line.results as LogLine[]
    expect(results).toHaveLength(2)
    for (const entry of results) {
      expect(entry.content).toBeUndefined()
      expect(entry.topic).toBeUndefined()
      expect(entry.content_len).toBe(memory.content.length)
      expect(entry.id).toBe('mem-123')
    }
    expect(line.query).toBeUndefined()
    expect(line.query_len).toBe('what allergies?'.length)
    expect(JSON.stringify(line)).not.toContain('penicillin')
    expect(JSON.stringify(line)).not.toContain('allergies')
  })

  it('redacts at arbitrary nesting depth', () => {
    const { lines, stream } = createSink()
    createLogger(stream).info({ batch: { items: [{ inner: { content: 'leaky' } }] } })

    const line = lines[0] as LogLine
    expect(JSON.stringify(line)).not.toContain('leaky')
    const inner = ((line.batch as LogLine).items as LogLine[])[0]?.inner as LogLine
    expect(inner.content).toBeUndefined()
    expect(inner.content_len).toBe(5)
  })

  it('passes content through only with the dev-only debug flag', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('LOG_DEBUG_CONTENT', 'true')
    resetEnvCache()
    const passedThrough = redactDeep(memory) as LogLine
    expect(passedThrough.content).toBe(memory.content)
  })

  it('hashUserId is deterministic, salted, and never echoes the id', () => {
    vi.stubEnv('LOG_HASH_SALT', 'salt-a')
    resetEnvCache()
    const first = hashUserId('user-456')
    expect(first).toMatch(/^u_[0-9a-f]{16}$/)
    expect(first).toBe(hashUserId('user-456'))
    expect(first).not.toContain('user-456')

    vi.stubEnv('LOG_HASH_SALT', 'salt-b')
    resetEnvCache()
    expect(hashUserId('user-456')).not.toBe(first)
  })
})
