// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import type { ActivityState } from '../hooks/lib/activity.ts'
import {
  ACTIVITY_LIMITS,
  activityOf,
  fold,
  initialActivity,
  summarize,
} from '../hooks/lib/activity.ts'
import type { ObservedCall } from '../hooks/lib/observe.ts'
import { observe, THREENGRAM_TOOLS, TOPIC_LIMIT, threengramCall } from '../hooks/lib/observe.ts'
import * as f from './activity-fixtures.ts'

const { id, call } = f

function foldAll(calls: ObservedCall[], limits = ACTIVITY_LIMITS): ActivityState {
  return calls.reduce((s, c) => fold(s, observe(c), limits), initialActivity)
}

// --- which calls are 3ngram's ---

const ACCEPTED: [string, string, string][] = [
  ['mcp__3ngram__search', '3ngram', 'search'],
  ['mcp__3ngram-personal__remember', '3ngram-personal', 'remember'],
  ['mcp__claude_ai_3ngram__briefing', 'claude_ai_3ngram', 'briefing'],
  ['mcp__3ngram_staging__get_memories', '3ngram_staging', 'get_memories'],
  ['mcp__3NGRAM__search', '3NGRAM', 'search'],
  ['mcp__3ngram__forget', '3ngram', 'forget'],
]

const REFUSED = [
  'Bash',
  'mcp__github__search',
  'mcp__my3ngram__search',
  'mcp__3ngramx__search',
  'mcp__foo__3ngram_search',
  'mcp__3ngram__',
  'mcp____search',
  'mcp__3ngram',
  `mcp__3ngram-${'x'.repeat(200)}__search`,
]

test('a 3ngram server is told by a 3ngram word in its name, the tool after the last __', () => {
  for (const [name, server, tool] of ACCEPTED)
    assert.deepEqual(threengramCall(name), { server, tool }, name)
  for (const name of REFUSED) assert.equal(threengramCall(name), null, name)
})

// The hook's matcher is a literal in register.tsx, so validate can show it.
function hookMatcher(): RegExp {
  const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('register.tsx', source, ts.ScriptTarget.Latest, true)
  let found: RegExp | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [event, matcher] = node.arguments
      if (
        node.expression.text === 'on' &&
        event !== undefined &&
        ts.isStringLiteral(event) &&
        event.text === 'tool.call' &&
        matcher !== undefined &&
        ts.isObjectLiteralExpression(matcher)
      ) {
        for (const p of matcher.properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText(file) === 'tool') {
            const literal = p.initializer.getText(file)
            const end = literal.lastIndexOf('/')
            found = new RegExp(literal.slice(1, end), literal.slice(end + 1))
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, 'register.tsx hooks tool.call with a tool pattern')
  return found
}

test("the hook's matcher lets through every name the parser takes, and no built-in tool", () => {
  const matcher = hookMatcher()
  for (const [name] of ACCEPTED) assert.ok(matcher.test(name), name)
  for (const name of REFUSED) if (threengramCall(name) !== null) assert.ok(matcher.test(name), name)
  for (const name of ['Bash', 'Read', 'Agent', 'mcp__github__search'])
    assert.equal(matcher.test(name), false, name)
})

// The MCP surface snapshot (hard rule 8) lists the tools a 3ngram server
// registers: a new tool fails here until observe.ts decides how to read it.
test('the tool set is the MCP surface snapshot', () => {
  const surfaces = JSON.parse(
    readFileSync(
      new URL('../../../eval/fixtures/transport-surfaces.json', import.meta.url),
      'utf8',
    ),
  ) as { mcp: { tools: { name: string }[] } }
  const snapshot = surfaces.mcp.tools.map((t) => t.name).sort()
  assert.deepEqual([...THREENGRAM_TOOLS].sort(), snapshot)
})

// --- reading each tool's result ---

test('remember records the written memory; a commitment opens with it', () => {
  const seen = observe(call('remember', f.remembered))
  assert.equal(seen.kind, 'write')
  assert.equal(seen.outcome, 'ok')
  assert.deepEqual(seen.entries, [
    {
      id: id(1),
      via: 'remembered',
      memoryType: 'commitment',
      topic: 'Ship the session tab',
      scope: 'work',
      project: '3ngram',
      commitmentStatus: 'open',
    },
  ])
  const note = observe(call('remember', f.rememberedNote))
  assert.deepEqual(note.entries[0], {
    id: id(2),
    via: 'remembered',
    memoryType: 'note',
    topic: 'A note',
    scope: 'personal',
    project: null,
  })
})

test('revise records the successor and the memory it superseded', () => {
  const seen = observe(call('revise', f.revisedSuccessor, { predecessorId: id(30) }))
  assert.deepEqual(
    seen.entries.map((e) => [e.id, e.via, e.topic]),
    [
      [id(3), 'successor', 'Use tool.call'],
      [id(30), 'revised', undefined],
    ],
  )
})

test('a revise move refiles in place; a disposition records what it did per id', () => {
  const moved = observe(call('revise', f.revisedMove, { predecessorId: id(4), kind: 'move' }))
  assert.deepEqual(
    moved.entries.map((e) => [e.id, e.via, e.project]),
    [[id(4), 'moved', 'other']],
  )
  const archived = observe(call('revise', f.archivedDisposition, { kind: 'archive' }))
  assert.equal(archived.returned, 3)
  assert.deepEqual(archived.entries, [{ id: id(5), via: 'archived', status: 'archived' }])
  const reaffirmed = observe(call('revise', f.reaffirmedDisposition, { kind: 'reaffirm' }))
  assert.deepEqual(reaffirmed.entries, [{ id: id(8), via: 'reaffirmed' }])
})

test('resolve records the memory its arguments named and what it settled on', () => {
  const settled = observe(
    call('resolve', f.resolvedCommitment, { memoryId: id(1), status: 'resolved' }),
  )
  assert.deepEqual(settled.entries, [{ id: id(1), via: 'resolved', commitmentStatus: 'resolved' }])
  const blocker = observe(
    call('resolve', f.resolvedBlocker, { memoryId: id(9), status: 'resolved' }),
  )
  assert.deepEqual(blocker.entries, [{ id: id(9), via: 'resolved', status: 'archived' }])
  // A result without the memory's id in the arguments counts, recording nothing.
  const anonymous = observe(call('resolve', f.resolvedCommitment))
  assert.equal(anonymous.outcome, 'ok')
  assert.deepEqual(anonymous.entries, [])
})

test('search records its hits, full or compact, and never their content', () => {
  const seen = observe(call('search', f.searched, { query: 'tab' }))
  assert.equal(seen.kind, 'read')
  assert.equal(seen.returned, 2)
  assert.deepEqual(seen.entries[1], {
    id: id(1),
    via: 'read',
    memoryType: 'commitment',
    topic: 'Hit 1',
    scope: 'work',
    project: '3ngram',
    commitmentStatus: 'open',
  })
  const compact = observe(call('search', f.searchedCompact))
  assert.deepEqual(compact.entries, [
    { id: id(11), via: 'read', memoryType: 'note', topic: 'Compact', scope: 'work', project: null },
  ])
  assert.ok(!JSON.stringify(seen).includes('excerpt'))
})

test('get_memories records each memory with its status, never its content', () => {
  const seen = observe(call('get_memories', f.gotMemories, { ids: [id(12), id(98)] }))
  assert.equal(seen.returned, 1)
  assert.deepEqual(seen.entries, [
    {
      id: id(12),
      via: 'read',
      memoryType: 'blocker',
      topic: 'Archived blocker',
      scope: 'work',
      project: '3ngram',
      status: 'archived',
    },
  ])
  assert.ok(!JSON.stringify(seen).includes('never be kept'))
})

test('briefing records each section it returned, a commitment by its memory id, once', () => {
  const seen = observe(call('briefing', f.briefed))
  // The overdue commitment is listed twice and recorded once.
  assert.equal(seen.returned, 4)
  assert.deepEqual(
    seen.entries.map((e) => [e.id, e.memoryType, e.commitmentStatus]),
    [
      [id(1), 'commitment', 'waiting'],
      [id(13), 'blocker', undefined],
      [id(14), 'decision', undefined],
    ],
  )
  assert.equal(seen.entries[1]?.project, null)
})

test('handoff is a read of its decisions, preferences and commitments', () => {
  const seen = observe(call('handoff', f.handedOff))
  assert.equal(seen.kind, 'read')
  assert.deepEqual(
    seen.entries.map((e) => [e.id, e.memoryType, e.commitmentStatus]),
    [
      [id(15), 'decision', undefined],
      [id(16), 'commitment', 'open'],
    ],
  )
  assert.ok(!JSON.stringify(seen).includes('never be kept'))
})

test('get_facts counts the facts it returned; a fact names no memory', () => {
  const seen = observe(call('get_facts', f.facts))
  assert.deepEqual([seen.kind, seen.outcome, seen.returned, seen.entries], ['read', 'ok', 1, []])
})

test('review_proposals: a list reads the memories proposals name; a decision acts on them', () => {
  const listed = observe(call('review_proposals', f.proposalsListed, { action: 'list' }))
  assert.equal(listed.kind, 'read')
  assert.equal(listed.returned, 4)
  assert.deepEqual(
    listed.entries.map((e) => e.id),
    [id(17), id(18), id(19), id(1), id(20), id(21)],
  )
  const rejected = observe(call('review_proposals', f.proposalRejected, { action: 'reject' }))
  assert.equal(rejected.kind, 'write')
  assert.deepEqual(
    rejected.entries.map((e) => [e.id, e.via]),
    [
      [id(17), 'proposal_rejected'],
      [id(18), 'proposal_rejected'],
    ],
  )
  const applied = observe(call('review_proposals', f.resolutionApplied, { action: 'accept' }))
  assert.deepEqual(applied.entries, [
    { id: id(1), via: 'proposal_applied', commitmentStatus: 'resolved' },
  ])
  const retention = observe(call('review_proposals', f.retentionApplied, { action: 'accept' }))
  assert.deepEqual(
    retention.entries.map((e) => e.id),
    [id(20), id(21)],
  )
})

test('the admin tools and a tool this version does not know are counted with no memory', () => {
  for (const tool of ['configure_scope', 'describe_environment', 'forget']) {
    const seen = observe(call(tool, '{"action":"list","scopes":[]}'))
    assert.deepEqual([seen.kind, seen.outcome, seen.entries], ['other', 'ok', []], tool)
  }
})

// --- calls that did not answer as expected ---

test('an error, a refusal and an unreadable result are counted with no memory', () => {
  const error = observe(call('search', 'Invalid input: query', {}, { isError: true }))
  assert.deepEqual([error.kind, error.outcome, error.entries], ['read', 'error', []])
  const denied = observe(call('remember', undefined, {}, { isDenied: true }))
  assert.deepEqual([denied.kind, denied.outcome, denied.entries], ['write', 'denied', []])
  for (const text of [
    undefined,
    '',
    'not json',
    '{"hits": [',
    '[]',
    'null',
    '42',
    '"text"',
    '{}',
    '{"hits": "x"}',
    // The engine's note on an output too large to show is not the JSON.
    'Output too large (91.2KB). Saved to a file.',
  ]) {
    const seen = observe(call('search', text))
    assert.deepEqual([seen.outcome, seen.entries], ['unparsed', []], String(text))
  }
})

test('result lines without a valid id are skipped, the rest kept', () => {
  const text = JSON.stringify({
    hits: [null, 1, 'x', { id: 5 }, { id: 'not-a-uuid' }, { id: id(40).toUpperCase(), topic: 7 }],
  })
  const seen = observe(call('search', text))
  assert.equal(seen.returned, 6)
  assert.deepEqual(seen.entries, [{ id: id(40), via: 'read' }])
})

test('no input makes observe throw', () => {
  const bodies = [
    '{"memory": null}',
    '{"memory": {"id": []}}',
    '{"outcomes": [null, {"memoryId": {}}]}',
    '{"commitmentId": 1, "status": {}}',
    '{"commitments": {"items": [null, {"memoryId": null}]}}',
    '{"decisions": {}, "commitments": [], "preferences": []}',
    '{"facts": {}}',
    '{"action": "list", "proposals": {}}',
    '{"action": "applied_x", "proposal": null}',
    '{"action": "explode", "proposal": {}}',
    '{"__proto__": {"hits": []}}',
  ]
  const oddArgs = [{}, { predecessorId: 5, kind: {} }, { memoryId: null, action: [] }]
  for (const tool of [...THREENGRAM_TOOLS, 'constructor', '__proto__', 'toString'])
    for (const text of bodies)
      for (const args of oddArgs) assert.doesNotThrow(() => observe(call(tool, text, args)))
})

test('a long topic is cut at the limit, never inside a character', () => {
  const long = '🧠'.repeat(TOPIC_LIMIT + 50)
  const text = JSON.stringify({ hits: [{ id: id(41), topic: long }] })
  const topic = observe(call('search', text)).entries[0]?.topic ?? ''
  assert.equal(Array.from(topic).length, TOPIC_LIMIT)
  assert.ok(topic.endsWith('…'))
  // encodeURIComponent refuses a lone surrogate, half of a cut character.
  assert.doesNotThrow(() => encodeURIComponent(topic))
})

// --- folding calls into the session's state ---

test('the first call starts the session activity; each call is numbered', () => {
  const s = foldAll([
    call('search', f.searched, {}, { at: 5_000 }),
    call('briefing', f.briefed, {}, { at: 6_000 }),
  ])
  assert.equal(s.startedAt, 5_000)
  assert.equal(s.seq, 2)
  assert.deepEqual(
    s.calls.map((c) => [c.seq, c.tool, c.kind, c.outcome, c.returned, c.memories]),
    [
      [1, 'search', 'read', 'ok', 2, 2],
      [2, 'briefing', 'read', 'ok', 4, 3],
    ],
  )
})

test('a memory gathers its reads, the tools that read it and what was done to it', () => {
  const s = foldAll([
    call('remember', f.remembered, {}, { at: 1 }),
    call('search', f.searched, {}, { at: 2 }),
    call('briefing', f.briefed, {}, { at: 3 }),
    call('resolve', f.resolvedCommitment, { memoryId: id(1) }, { at: 4 }),
    call('review_proposals', f.resolutionApplied, { action: 'accept' }, { at: 5 }),
  ])
  const [m] = activityOf(s, id(1).toUpperCase())
  assert.deepEqual(m, {
    server: '3ngram',
    id: id(1),
    // The topic the briefing reported, kept through writes that report none.
    memoryType: 'commitment',
    topic: 'Ship the session tab',
    scope: 'work',
    project: '3ngram',
    commitmentStatus: 'resolved',
    firstSeen: 1,
    lastSeen: 5,
    lastCall: 5,
    reads: 2,
    readVia: ['search', 'briefing'],
    actions: ['remembered', 'resolved', 'proposal_applied'],
  })
  // The most recently seen memory is last.
  assert.equal(s.memories.at(-1)?.id, id(1))
})

test('two servers are two accounts: one memory id is two entries, counted apart', () => {
  const s = foldAll([
    call('search', f.searched),
    call('search', f.searched, {}, { server: '3ngram-personal' }),
    call('remember', f.remembered, {}, { server: '3ngram-personal' }),
  ])
  assert.deepEqual(
    activityOf(s, id(1)).map((m) => [m.server, m.reads, m.actions]),
    [
      ['3ngram', 1, []],
      ['3ngram-personal', 1, ['remembered']],
    ],
  )
  assert.deepEqual(summarize(s), [
    { server: '3ngram', calls: 1, read: 2, changed: 0, resolved: 0, evictedMemories: 0 },
    { server: '3ngram-personal', calls: 2, read: 2, changed: 1, resolved: 0, evictedMemories: 0 },
  ])
})

test("a subagent's call is recorded with its loop", () => {
  const s = foldAll([
    call('search', f.searched, {}, { agentId: 'agent-1' }),
    call('get_facts', f.facts),
  ])
  assert.deepEqual(
    s.calls.map((c) => c.agentId),
    ['agent-1', undefined],
  )
  assert.equal(activityOf(s, id(10)).length, 1)
})

test('each outcome is counted on its server', () => {
  const s = foldAll([
    call('search', f.searched),
    call('remember', 'Write refused', {}, { isError: true }),
    call('revise', undefined, {}, { isDenied: true }),
    call('briefing', 'garbled'),
    call('describe_environment', '{}'),
  ])
  const [row] = s.servers
  assert.deepEqual(
    row && [row.calls, row.reads, row.writes, row.errors, row.denied, row.unparsed],
    [5, 2, 2, 1, 1, 1],
  )
})

test('the state keeps the last calls, counting those it dropped', () => {
  const limits = { calls: 3, memories: 50, servers: 4 }
  const s = foldAll(
    Array.from({ length: 5 }, (_, i) => call('get_facts', f.facts, {}, { at: i })),
    limits,
  )
  assert.deepEqual(
    s.calls.map((c) => c.seq),
    [3, 4, 5],
  )
  assert.equal(s.seq, 5)
  assert.equal(s.servers[0]?.calls, 5)
  assert.equal(s.servers[0]?.evictedCalls, 2)
})

function readOne(n: number, at: number): ObservedCall {
  return call('search', JSON.stringify({ hits: [{ id: id(n), topic: `t${n}` }] }), {}, { at })
}

test('past the bound the least recently seen read goes first; a changed memory stays', () => {
  const limits = { calls: 100, memories: 3, servers: 4 }
  const s = foldAll(
    [
      call('remember', f.rememberedNote, {}, { at: 0 }),
      readOne(50, 1),
      readOne(51, 2),
      readOne(50, 3),
      readOne(52, 4),
    ],
    limits,
  )
  // 51 was read longest ago (50 was read again); the remembered note, older
  // still, is kept because the agent changed it.
  assert.deepEqual(
    s.memories.map((m) => m.id),
    [id(2), id(50), id(52)],
  )
  assert.equal(activityOf(s, id(50))[0]?.reads, 2)
  assert.equal(s.servers[0]?.evictedMemories, 1)
})

test('with only changed memories left, the oldest of them goes', () => {
  const limits = { calls: 100, memories: 1, servers: 4 }
  const s = foldAll(
    [
      call('remember', f.rememberedNote, {}, { at: 0 }),
      call('remember', f.remembered, {}, { at: 1 }),
    ],
    limits,
  )
  assert.deepEqual(
    s.memories.map((m) => m.id),
    [id(1)],
  )
  assert.equal(s.servers[0]?.evictedMemories, 1)
})

test('the default bound holds the session to 500 memories and 200 calls', () => {
  const calls = Array.from({ length: 30 }, (_, c) =>
    call(
      'search',
      JSON.stringify({
        hits: Array.from({ length: 25 }, (_, h) => ({ id: id(1000 + c * 25 + h) })),
      }),
      {},
      { at: c },
    ),
  )
  const s = foldAll([...calls, ...Array.from({ length: 200 }, () => call('get_facts', f.facts))])
  assert.equal(s.memories.length, ACTIVITY_LIMITS.memories)
  assert.equal(s.calls.length, ACTIVITY_LIMITS.calls)
  assert.equal(s.servers[0]?.evictedMemories, 30 * 25 - ACTIVITY_LIMITS.memories)
  assert.equal(s.servers[0]?.evictedCalls, 30)
})

test('a server past the bound is counted as ignored and changes nothing else', () => {
  const limits = { calls: 10, memories: 10, servers: 1 }
  const one = foldAll([call('search', f.searched)], limits)
  const two = fold(one, observe(call('search', f.searched, {}, { server: '3ngram-other' })), limits)
  assert.equal(two.ignored, 1)
  assert.deepEqual({ ...two, ignored: 0 }, one)
})

test('a value of another shape starts the activity over instead of breaking the fold', () => {
  for (const held of [undefined, null, {}, { seq: 'x' }, []]) {
    const s = fold(held as unknown as ActivityState, observe(call('search', f.searched)))
    assert.equal(s.seq, 1)
    assert.equal(s.memories.length, 2)
  }
})

test('the fold never changes the state it was given', () => {
  const before = foldAll([call('search', f.searched)])
  const frozen = structuredClone(before)
  fold(before, observe(call('remember', f.remembered)))
  fold(before, observe(call('search', f.searched)), { calls: 1, memories: 1, servers: 1 })
  assert.deepEqual(before, frozen)
})
