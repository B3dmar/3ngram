// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fold, initialActivity } from '../hooks/lib/activity.ts'
import { observe } from '../hooks/lib/observe.ts'
import { activityStatus, sessionView } from '../hooks/lib/session-view.ts'
import * as f from './activity-fixtures.ts'

const clock = { now: 5000, zone: 'UTC' }

test('empty session is explicit and never invents an automatic briefing', () => {
  assert.equal(activityStatus(initialActivity), '')
  assert.deepEqual(sessionView(initialActivity, clock).servers, [])
  assert.match(
    sessionView(initialActivity, clock).notes.join(' '),
    /automatic startup briefings are not included/,
  )
})

test('rereads rank memories without duplicating distinct counts or moving writes', () => {
  let state = fold(initialActivity, observe(f.call('remember', f.remembered, {}, { at: 1000 })))
  for (let n = 0; n < 2; n++)
    state = fold(state, observe(f.call('search', f.searched, {}, { at: 2000 + n })))
  const view = sessionView(state, clock).servers[0]
  assert.equal(view?.counts, 'Read 2 · Wrote 1 · Resolved 0')
  assert.match(view?.reads[0]?.labels ?? '', /2 reads/)
  assert.match(view?.writes[0]?.labels ?? '', /00:00 UTC · remembered/)
  assert.equal(state.writes[0]?.at, 1000)
  assert.equal(activityStatus(state), '2 read · 1 wrote · 0 resolved')
})

test('servers keep separate summaries and status contains no identifying metadata', () => {
  let state = fold(initialActivity, observe(f.call('search', f.searched)))
  state = fold(state, observe(f.call('search', f.searched, {}, { server: '3ngram-private' })))
  const view = sessionView(state, clock)
  assert.equal(view.servers.length, 2)
  assert.equal(view.servers[0]?.counts, view.servers[1]?.counts)
  assert.equal(activityStatus(state), 'activity in 2 servers')
})

test('truncation, eviction and unreadable results are visible', () => {
  const limits = { calls: 1, memories: 1, servers: 1 }
  let state = fold(initialActivity, observe(f.call('briefing', f.briefed)), limits)
  state = fold(state, observe(f.call('search', 'unreadable')), limits)
  state = fold(state, observe(f.call('search', f.searched, {}, { server: '3ngram-other' })), limits)
  const view = sessionView(state, clock)
  assert.match(view.servers[0]?.counts ?? '', /Read 1\+/)
  assert.match(view.servers[0]?.notes.join(' ') ?? '', /lower bounds/)
  assert.match(view.servers[0]?.notes.join(' ') ?? '', /1 unparsed/)
  assert.match(view.servers[0]?.notes.join(' ') ?? '', /older calls omitted/)
  assert.match(view.servers[0]?.briefing.join(' ') ?? '', /4 total · 1 returned · truncated/)
  assert.match(view.notes.join(' '), /1 calls omitted/)
})

test('recent writes are bounded with a notice and rendered labels neutralize controls', () => {
  let state = initialActivity
  for (let n = 0; n < 7; n++)
    state = fold(
      state,
      observe(
        f.call(
          'remember',
          JSON.stringify({
            memory: {
              id: f.id(n + 1),
              topic: `Title\u001b\n${n}`,
              scope: 'work\u202e',
              project: 'demo',
            },
          }),
          {},
          { at: n * 60000 },
        ),
      ),
    )
  const view = sessionView(state, { now: 420000, zone: 'UTC' }).servers[0]
  assert.equal(view?.writes.length, 5)
  assert.equal(view?.writes[0]?.title, 'Title  6')
  assert.match(view?.writes[0]?.labels ?? '', /^00:06 UTC/)
  assert.match(view?.notes.join(' ') ?? '', /Showing 5 of 7/)
  assert.doesNotMatch(JSON.stringify(view), /\\u001b|\\u202e/)
})
