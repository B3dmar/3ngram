// SPDX-License-Identifier: Apache-2.0

// Engine-kit tests for the session activity hook (hooks/activity.ts), run
// locally with `claude plugin test plugins/3ngram` like tests/panel.test.ts.
// The test's own tool.call hook sits beneath the plugin and answers as core
// would, with the result object, the text the model reads and a ref; the
// plugin must hand that object back unchanged whatever it records.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const TOPIC = 'Ship the session tab'

function memoryId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

const SEARCH = {
  hits: [
    {
      id: memoryId(1),
      memoryType: 'commitment',
      topic: TOPIC,
      content: 'excerpt',
      contentLength: 7,
      truncated: false,
      score: 0.5,
      superseded: false,
      scope: 'work',
      project: '3ngram',
      commitmentStatus: 'open',
    },
  ],
  count: 1,
  hasMore: false,
}

type Answer = { result: unknown; text: string; ref: number; isError?: true }

function answerOf(structured: object, ref = 7): Answer {
  return { result: structured, text: JSON.stringify(structured), ref }
}

type Held = {
  seq: number
  calls: { tool: string; server: string; outcome: string; agentId?: string }[]
  memories: { id: string; server: string; topic?: string; reads: number; actions: string[] }[]
}

// world answers what the hook asks of the engine (the clock and the debug
// log; the kit keeps the state), stands for core beneath every tool call,
// and records the activity the plugin writes and anything it must never do.
// A test's $ has no state noun, so the value is read where it is written.
function world(on: On, answer: (tool: string) => Answer) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 5, 12) })
  const ran: string[] = []
  const inputs: Record<string, unknown>[] = []
  const forbidden: string[] = []
  const logs: string[] = []
  const written: { shape?: string; value?: Held }[] = []
  let failWrites = false
  on('tool.call', async (_$, e) => {
    ran.push(String(e.tool))
    const { tool_use_id: _id, ...input } = e as Record<string, unknown>
    inputs.push(input)
    return answer(String(e.tool)) as never
  })
  on('state.set', { plugin: '3ngram', key: 'activity' }, async (_$, e, next) => {
    if (failWrites) return { deny: 'the state is unavailable' } as never
    // The contract types the value opaquely; fold() is its only writer.
    written.push({ shape: e.value.shape, value: e.value.value as unknown as Held })
    return next(e)
  })
  on('ui.log', async (_$, e) => {
    logs.push(String((e as { text?: unknown }).text))
    return { value: undefined } as never
  })
  for (const noun of [
    'mcp.call',
    'http.fetch',
    'session.append',
    'ui.status',
    'ui.toast',
    'store.set',
  ] as const) {
    on(noun, async () => {
      forbidden.push(noun)
      return { deny: `${noun} is not the activity hook's to call` } as never
    })
  }
  return {
    clock,
    ran,
    inputs,
    forbidden,
    logs,
    written,
    // The activity as last written; undefined before any write.
    held: (): Held | undefined => written.at(-1)?.value,
    failWrites: (on: boolean) => {
      failWrites = on
    },
  }
}

describe('the session activity hook', () => {
  test('a 3ngram search returns its own result object and records its hits', async ($, on) => {
    const w = world(on, () => answerOf(SEARCH))
    const got = await $.tool.call({ tool: 'mcp__3ngram__search', query: 'tab' } as never)
    expect(got).toEqual(answerOf(SEARCH))
    // The call reached core as the agent made it.
    expect(w.inputs).toEqual([{ tool: 'mcp__3ngram__search', query: 'tab' }])
    // The result came back before anything was recorded: the recording waits
    // for its timer, so it never holds the call.
    expect(w.written).toEqual([])
    await w.clock.advance(1)
    const held = w.held()
    expect(held?.seq).toBe(1)
    expect(held?.calls.map((c) => [c.server, c.tool, c.outcome])).toEqual([
      ['3ngram', 'search', 'ok'],
    ])
    expect(held?.memories.map((m) => [m.id, m.topic, m.reads])).toEqual([[memoryId(1), TOPIC, 1]])
    expect(w.forbidden).toEqual([])
  })

  test('the stored value carries its shape tag', async ($, on) => {
    const w = world(on, () => answerOf(SEARCH))
    await $.tool.call({ tool: 'mcp__3ngram__search', query: 'tab' } as never)
    await w.clock.advance(1)
    expect(w.written.map((v) => v.shape)).toEqual(['activity-1'])
  })

  test('other tools pass untouched and are not recorded', async ($, on) => {
    const other = { result: { ok: true }, text: 'other', ref: 3 }
    const w = world(on, () => other)
    for (const tool of ['mcp__github__search', 'mcp__my3ngram__search', 'Bash']) {
      const got = await $.tool.call({ tool, command: 'ls', query: 'x' } as never)
      expect(got).toEqual(other)
    }
    await w.clock.advance(1)
    expect(w.ran).toEqual(['mcp__github__search', 'mcp__my3ngram__search', 'Bash'])
    expect(w.held()?.seq ?? 0).toBe(0)
  })

  test('a result that does not parse returns unchanged and is counted as unparsed', async ($, on) => {
    const garbled = { result: 'Output too large', text: 'Output too large (91KB).', ref: 4 }
    const w = world(on, () => garbled)
    const got = await $.tool.call({ tool: 'mcp__3ngram__briefing', selector: {} } as never)
    expect(got).toEqual(garbled)
    await w.clock.advance(1)
    const held = w.held()
    expect(held?.calls.map((c) => c.outcome)).toEqual(['unparsed'])
    expect(held?.memories).toEqual([])
  })

  test('an errored call returns unchanged and records no memory', async ($, on) => {
    const failed: Answer = { result: 'Invalid input', text: 'Invalid input', ref: 5, isError: true }
    const w = world(on, () => failed)
    const got = await $.tool.call({ tool: 'mcp__3ngram__remember', topic: 'x' } as never)
    expect(got).toEqual(failed)
    await w.clock.advance(1)
    expect(w.held()?.calls.map((c) => c.outcome)).toEqual(['error'])
  })

  test('a failure while recording never reaches the call, and costs only that entry', async ($, on) => {
    const w = world(on, () => answerOf(SEARCH))
    w.failWrites(true)
    const first = await $.tool.call({ tool: 'mcp__3ngram__search', query: 'a' } as never)
    expect(first).toEqual(answerOf(SEARCH))
    await w.clock.advance(1)
    expect(w.held()?.seq ?? 0).toBe(0)
    expect(w.logs).toEqual(['3ngram: a tool call was left out of the session activity'])
    w.failWrites(false)
    const second = await $.tool.call({ tool: 'mcp__3ngram__search', query: 'b' } as never)
    expect(second).toEqual(answerOf(SEARCH))
    await w.clock.advance(1)
    expect(w.held()?.seq).toBe(1)
  })

  test('two servers and a subagent are kept apart', async ($, on) => {
    const w = world(on, () => answerOf(SEARCH))
    await $.tool.call({ tool: 'mcp__3ngram__search', query: 'a' } as never)
    await $.tool.call({
      tool: 'mcp__3ngram-personal__search',
      query: 'a',
      agentId: 'agent-1',
    } as never)
    await w.clock.advance(1)
    const held = w.held()
    expect(held?.calls.map((c) => [c.server, c.agentId])).toEqual([
      ['3ngram', undefined],
      ['3ngram-personal', 'agent-1'],
    ])
    expect(held?.memories.map((m) => m.server)).toEqual(['3ngram', '3ngram-personal'])
  })

  test('the hook shows the model nothing: no status, toast or appended row', async ($, on) => {
    const w = world(on, () => answerOf(SEARCH))
    await $.tool.call({ tool: 'mcp__3ngram__search', query: 'a' } as never)
    await w.clock.advance(1)
    expect(w.forbidden).toEqual([])
  })
})
