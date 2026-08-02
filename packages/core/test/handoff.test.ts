// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. handoff()'s POLICY surface: the
// SHARED selector discipline (no-firehose), content INCLUDED in the export shape
// (the difference from a briefing / logs), and reuse of the briefing-read queries
// (no duplicated SQL) inside one withTenant tx. packages/db is mocked.
import { EXCERPT_MARKER, handoffMemorySchema, MAX_EXCERPT_LENGTH } from '@3ngram/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openCommitments = vi.fn()
const recentDecisions = vi.fn()
const activePreferences = vi.fn()
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
  fn({} as unknown),
)

vi.mock('@3ngram/db', () => ({
  openCommitments: (...a: unknown[]) => openCommitments(...a),
  recentDecisions: (...a: unknown[]) => recentDecisions(...a),
  activePreferences: (...a: unknown[]) => activePreferences(...a),
  withTenant: (userId: string, fn: (tx: unknown) => Promise<unknown>) => withTenant(userId, fn),
}))

const { handoff, MAX_HANDOFF_SECTION } = await import('../src/read/handoff.js')
const { MissingSelectorError } = await import('../src/read/briefing.js')

const NOW = new Date('2026-06-06T12:00:00.000Z')

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    memoryType: 'decision',
    topic: 'a topic',
    content: 'pin the sdk at 1.29.0',
    scope: 'work',
    project: null,
    recordedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** A {items, totalCount} page — the single-statement window-count return shape. */
function page<T>(items: T[], totalCount: number = items.length) {
  return { items, totalCount }
}

function resetAll() {
  for (const fn of [openCommitments, recentDecisions, activePreferences]) {
    fn.mockReset()
    fn.mockResolvedValue(page([]))
  }
  withTenant.mockClear()
}

afterEach(resetAll)

describe('handoff — selector discipline (shared with briefing)', () => {
  it('throws MissingSelectorError when no selector is provided', async () => {
    resetAll()
    await expect(handoff('u1', { selector: undefined, now: NOW })).rejects.toBeInstanceOf(
      MissingSelectorError,
    )
    expect(withTenant).not.toHaveBeenCalled()
  })

  it('rejects a project selector with an empty project', async () => {
    resetAll()
    await expect(
      handoff('u1', { selector: { kind: 'project', project: '  ' }, now: NOW }),
    ).rejects.toBeInstanceOf(MissingSelectorError)
  })
})

describe('handoff — export shape', () => {
  it('INCLUDES content for decisions/preferences (the difference from a briefing)', async () => {
    resetAll()
    recentDecisions.mockResolvedValue(page([memoryRow({ content: 'release after a 24h soak' })]))
    activePreferences.mockResolvedValue(
      page([memoryRow({ memoryType: 'preference', content: 'prefer kebab-case scopes' })]),
    )
    const result = await handoff('u1', { selector: { kind: 'all' }, now: NOW })
    expect(result.decisions[0]?.content).toBe('release after a 24h soak')
    expect(result.preferences[0]?.content).toBe('prefer kebab-case scopes')
  })

  it('EXCERPTS a long line to the read-path cap (issue #238, same policy as search)', async () => {
    // An imported decision can exceed any write-time cap (262,144 admitted);
    // the handoff line must come back bounded, marked, with the full length —
    // or the MCP handoffMemorySchema rejects the WHOLE export.
    resetAll()
    recentDecisions.mockResolvedValue(page([memoryRow({ content: 'x'.repeat(10_000) })]))
    const result = await handoff('u1', { selector: { kind: 'all' }, now: NOW })
    const line = result.decisions[0]
    expect(line?.content.length).toBe(MAX_EXCERPT_LENGTH)
    expect(line?.content.endsWith(EXCERPT_MARKER)).toBe(true)
    expect(line?.contentLength).toBe(10_000)
    expect(line?.truncated).toBe(true)
    expect(handoffMemorySchema.safeParse(line).success).toBe(true)
  })

  it('marks a short line untruncated with its real length (schema-valid)', async () => {
    resetAll()
    recentDecisions.mockResolvedValue(page([memoryRow({ content: 'short decision' })]))
    const result = await handoff('u1', { selector: { kind: 'all' }, now: NOW })
    expect(result.decisions[0]?.contentLength).toBe('short decision'.length)
    expect(result.decisions[0]?.truncated).toBe(false)
  })

  it('echoes generatedFor (or null) and includes a stable notes array', async () => {
    resetAll()
    const labelled = await handoff('u1', {
      selector: { kind: 'all' },
      generatedFor: 'agent-b',
      now: NOW,
    })
    expect(labelled.generatedFor).toBe('agent-b')
    expect(labelled.notes).toEqual([])

    const unlabelled = await handoff('u1', { selector: { kind: 'all' }, now: NOW })
    expect(unlabelled.generatedFor).toBeNull()
  })

  it('bounds every section by the handoff ceiling and forwards the selector', async () => {
    resetAll()
    const selector = { kind: 'scope', scope: 'work' } as const
    await handoff('u1', { selector, now: NOW })
    for (const fn of [openCommitments, recentDecisions, activePreferences]) {
      expect(fn.mock.calls[0]?.[2]).toEqual(selector)
      expect(fn.mock.calls[0]?.[3]).toBe(MAX_HANDOFF_SECTION)
    }
  })

  it('runs all three reads inside one withTenant transaction (reused SQL)', async () => {
    resetAll()
    await handoff('u1', { selector: { kind: 'all' }, now: NOW })
    expect(withTenant).toHaveBeenCalledOnce()
  })
})
