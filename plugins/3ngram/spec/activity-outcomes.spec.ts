// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fold, initialActivity, summarize } from '../hooks/lib/activity.ts'
import { observe } from '../hooks/lib/observe.ts'
import * as f from './activity-fixtures.ts'

test('an already archived result does not count as a write', () => {
  const seen = observe(
    f.call(
      'revise',
      JSON.stringify({
        outcomes: [{ memoryId: f.id(6), outcome: 'already_archived' }],
      }),
      { kind: 'archive' },
    ),
  )
  assert.deepEqual(seen.entries, [])
  assert.equal(summarize(fold(initialActivity, seen))[0]?.changed, 0)
})

test('resolve distinguishes reopened and waiting commitments from resolutions', () => {
  for (const status of ['open', 'waiting', 'expired']) {
    const seen = observe(
      f.call('resolve', JSON.stringify({ commitmentId: f.id(101), status }), {
        memoryId: f.id(1),
        status,
      }),
    )
    assert.equal(seen.entries[0]?.via, 'status_changed')
    assert.equal(seen.entries[0]?.commitmentStatus, status)
  }
})

test('distinct outcome counts ignore rereads, repeated writes, reopens and rejected proposals', () => {
  let state = initialActivity
  const inputs = [
    f.call('remember', f.remembered),
    f.call('remember', f.remembered),
    f.call('search', f.searched),
    f.call('search', f.searched),
    f.call('resolve', f.resolvedCommitment, { memoryId: f.id(1) }),
    f.call('resolve', JSON.stringify({ commitmentId: f.id(102), status: 'open' }), {
      memoryId: f.id(2),
    }),
    f.call('review_proposals', f.proposalRejected, { action: 'reject' }),
  ]
  for (const input of inputs) state = fold(state, observe(input))
  assert.equal(summarize(state)[0]?.read, 2)
  assert.equal(summarize(state)[0]?.changed, 2)
  assert.equal(summarize(state)[0]?.resolved, 1)
  assert.ok(state.writes.every((entry) => entry.via !== 'proposal_rejected'))
})

test('write events retain their own time and metadata after later reads', () => {
  let state = fold(initialActivity, observe(f.call('remember', f.remembered, {}, { at: 10 })))
  state = fold(state, observe(f.call('search', f.searched, {}, { at: 20 })))
  assert.equal(state.memories.find((m) => m.id === f.id(1))?.lastSeen, 20)
  assert.deepEqual(
    state.writes.map((w) => [w.id, w.via, w.at, w.topic]),
    [[f.id(1), 'remembered', 10, 'Ship the session tab']],
  )
  const limits = { calls: 1, memories: 500, servers: 16 }
  state = fold(state, observe(f.call('remember', f.rememberedNote, {}, { at: 30 })), limits)
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0]?.id, f.id(2))
  assert.equal(state.servers[0]?.evictedWrites, 1)
})

test('rejected proposals cannot displace successful writes from the bounded memory list', () => {
  const limits = { calls: 200, memories: 1, servers: 16 }
  let state = fold(initialActivity, observe(f.call('remember', f.rememberedNote)), limits)
  state = fold(
    state,
    observe(f.call('review_proposals', f.proposalRejected, { action: 'reject' })),
    limits,
  )
  assert.deepEqual(
    state.memories.map((m) => m.id),
    [f.id(2)],
  )
  assert.equal(summarize(state)[0]?.changed, 1)
  assert.equal(state.servers[0]?.evictedMemories, 2)
})

test('the latest MCP briefing keeps totals and its selector, separately per server', () => {
  const seen = observe(f.call('briefing', f.briefed))
  let state = fold(initialActivity, seen)
  state = fold(
    state,
    observe(f.call('briefing', f.briefed, {}, { server: '3ngram-personal', at: 2000 })),
  )
  assert.equal(state.servers[0]?.briefing?.at, 1000)
  assert.equal(state.servers[1]?.briefing?.at, 2000)
  assert.deepEqual(state.servers[0]?.briefing?.selector, {
    kind: 'scope_project',
    scope: 'work',
    project: '3ngram',
    includeUnscoped: false,
  })
  assert.deepEqual(state.servers[0]?.briefing?.sections[0], {
    name: 'commitments',
    count: 4,
    returned: 1,
    hasMore: true,
  })
  assert.ok(!JSON.stringify(state.servers).includes('Ship the session tab'))
})
