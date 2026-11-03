// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PanelState } from '../hooks/lib/state.ts'
import { initialState, reduce } from '../hooks/lib/state.ts'
import {
  detailView,
  failureText,
  githubLabel,
  headerLines,
  listNotice,
  MAX_CONTENT,
  panelView,
  partialNote,
  rowView,
  statusLine,
} from '../hooks/lib/view.ts'
import { FP_A, golden, goldenText, withFingerprint } from './fixtures.ts'

const list = withFingerprint(golden('list-unscoped.json'), FP_A)
const ready: PanelState = [
  { type: 'refresh_started', gen: 1, selectionKey: 'k', fingerprint: FP_A } as const,
  { type: 'list_envelope', gen: 1, envelope: list, at: Date.UTC(2026, 9, 7, 12, 30) } as const,
].reduce(reduce, initialState)
// The time the view is drawn at: the day of every time in the fixtures.
const NOW = Date.UTC(2026, 9, 7, 14)

test('the header names backend, account, project and its source, scope and unscoped opt-in', () => {
  const [backend, selection] = headerLines(list)
  assert.equal(backend, 'api.example.test · owner@example.test')
  assert.equal(
    selection,
    'project demo (from the directory name) · scope work · unscoped records included',
  )
})

test('rows say what is and is not recorded, in words', () => {
  const [overdue, cut, unscoped, unknown] = list.commitments ?? []
  assert.ok(overdue && cut && unscoped && unknown)
  assert.deepEqual(rowView(overdue).labels, [
    'OVERDUE',
    'open',
    'due 2026-10-01',
    'owner unclear (not recorded)',
  ])
  assert.ok(rowView(cut).labels.includes('no due date recorded'))
  assert.ok(rowView(unscoped).labels.includes('unscoped (no project)'))
  assert.ok(rowView(unscoped).labels.includes('waiting'))
  assert.ok(rowView(unknown).labels.includes('filing unknown'))
})

// A deadline is an instant (packages/schema: "a UTC ISO-8601 instant ending
// in Z (e.g. 2026-11-30T17:00:00Z)"), not a calendar date.
test('a deadline with a time of day shows that time, and its zone', () => {
  const [row] = list.commitments ?? []
  assert.ok(row)
  const at = (dueAt: string) => rowView({ ...row, dueAt }).labels
  assert.ok(at('2026-11-30T17:00:00.000Z').includes('due 2026-11-30 17:00 UTC'))
  assert.ok(at('2026-11-30T23:30:00.000Z').includes('due 2026-11-30 23:30 UTC'))
  assert.ok(at('2026-10-01T00:00:00.000Z').includes('due 2026-10-01'))
})

test('overdue rows are listed most overdue first', () => {
  const [row] = list.commitments ?? []
  assert.ok(row)
  // The binary lists the commitments slice first and appends the overdue
  // split, so an overdue row it cut from the slice comes after a later one.
  const rows = [
    { ...row, memoryId: 'm1', topic: 'Due 5 Oct', dueAt: '2026-10-05T00:00:00.000Z' },
    { ...row, memoryId: 'm2', topic: 'Due 1 Oct', dueAt: '2026-10-01T00:00:00.000Z' },
  ]
  const s = reduce(
    reduce(initialState, { type: 'refresh_started', gen: 1, selectionKey: 'k', fingerprint: FP_A }),
    { type: 'list_envelope', gen: 1, envelope: { ...list, commitments: rows }, at: 0 },
  )
  assert.deepEqual(
    panelView(s, NOW).sections[0]?.rows.map((r) => r.title),
    ['Due 1 Oct', 'Due 5 Oct'],
  )
})

test('an overdue row whose deadline does not parse sorts last, the rest by deadline', () => {
  const [row] = list.commitments ?? []
  assert.ok(row)
  const rows = [
    { ...row, memoryId: 'm0', topic: 'Unreadable', dueAt: 'not a date' },
    { ...row, memoryId: 'm1', topic: 'Due 5 Oct', dueAt: '2026-10-05T00:00:00.000Z' },
    { ...row, memoryId: 'm2', topic: 'Due 1 Oct', dueAt: '2026-10-01T00:00:00.000Z' },
  ]
  const s = reduce(
    reduce(initialState, { type: 'refresh_started', gen: 1, selectionKey: 'k', fingerprint: FP_A }),
    { type: 'list_envelope', gen: 1, envelope: { ...list, commitments: rows }, at: 0 },
  )
  assert.deepEqual(
    panelView(s, NOW).sections[0]?.rows.map((r) => r.title),
    ['Due 1 Oct', 'Due 5 Oct', 'Unreadable'],
  )
})

test('the panel groups rows and labels every partial part and what is missing', () => {
  const view = panelView(ready, NOW)
  assert.deepEqual(
    view.sections.map((s) => s.title),
    ['Overdue (1)', 'Open (2)', 'Waiting (1)'],
  )
  assert.ok(
    view.notes.includes(
      'Unscoped check: verified 2 of 3 rows (unavailable); the rest are labelled "filing unknown".',
    ),
  )
  assert.ok(
    view.notes.includes('Owners and source sessions are not exposed by the 3ngram read API.'),
  )
  assert.equal(view.status.label, 'Updated 12:30 UTC')
})

test('partial notes say how much was read', () => {
  assert.equal(
    partialNote({ part: 'commitments', reason: 'truncated', returned: 100, total: 140 }),
    'Showing 100 of 140 open or waiting commitments.',
  )
  assert.equal(
    partialNote({ part: 'github', reason: 'timeout', returned: 0, total: 3 }),
    'GitHub: checked 0 of 3 references (the lookups timed out).',
  )
  assert.equal(
    partialNote({ part: 'filing', reason: 'strict_read_selector_mismatch' }),
    'Unscoped check: the strict read failed (selector_mismatch), so rows were checked one by one, up to the lookup limit.',
  )
})

test('a GitHub lookup that stopped says why in words, and what to do', () => {
  const note = (reason: string) => partialNote({ part: 'github', reason, returned: 0, total: 3 })
  assert.equal(note('gh_missing'), 'GitHub: checked 0 of 3 references (gh is not on PATH).')
  assert.equal(
    note('gh_unauthenticated'),
    'GitHub: checked 0 of 3 references (gh is not signed in: run `gh auth login`).',
  )
  assert.equal(note('lookup_cap'), 'GitHub: checked 0 of 3 references (the per-read lookup limit).')
  assert.equal(note('something_new'), 'GitHub: checked 0 of 3 references (something_new).')
})

test('an invalid selection names the option to change', () => {
  assert.match(failureText('invalid_selector'), /needs a scope.*\/plugin configure 3ngram/)
})

test('stale and error states say so in words, not only by tone', () => {
  const stale = reduce(
    reduce(ready, { type: 'refresh_started', gen: 2, selectionKey: 'k', fingerprint: FP_A }),
    {
      type: 'list_failed',
      gen: 2,
      failure: 'timeout',
      at: 0,
    },
  )
  const verified = reduce(stale, {
    type: 'context_verified',
    gen: 2,
    fingerprint: FP_A,
    at: Date.UTC(2026, 9, 7, 13, 5),
  })
  assert.equal(
    panelView(verified, NOW).status.label,
    'STALE since 13:05 UTC: The read timed out. Rows from 12:30 UTC.',
  )
  assert.equal(panelView(verified, NOW).status.tone, 'stale')
  assert.equal(statusLine(verified), '3ngram: 4 open · 1 overdue (stale)')
  // An open detail says so too, rather than only once Back is pressed.
  assert.equal(listNotice(verified, NOW), panelView(verified, NOW).status.label)
  assert.equal(listNotice(ready, NOW), null)
  const refreshing = reduce(ready, {
    type: 'refresh_started',
    gen: 2,
    selectionKey: 'k',
    fingerprint: FP_A,
  })
  assert.equal(panelView(refreshing, NOW).status.label, 'Refreshing… Rows from 12:30 UTC.')
  // Drawn on a later day, a time without its date would read as today's.
  const tomorrow = Date.UTC(2026, 9, 8, 9)
  assert.equal(
    panelView(verified, tomorrow).status.label,
    'STALE since 2026-10-07 13:05 UTC: The read timed out. Rows from 2026-10-07 12:30 UTC.',
  )
  assert.equal(
    panelView(refreshing, tomorrow).status.label,
    'Refreshing… Rows from 2026-10-07 12:30 UTC.',
  )
  assert.equal(panelView(ready, tomorrow).status.label, 'Updated 2026-10-07 12:30 UTC')

  const cleared = reduce(stale, { type: 'context_verified', gen: 2, fingerprint: 'other', at: 0 })
  const view = panelView(cleared, NOW)
  assert.equal(view.sections.length, 0)
  assert.match(
    view.status.label,
    /^ERROR: The read timed out\. The account or selection could not be confirmed/,
  )
  assert.equal(statusLine(cleared), '3ngram: unavailable')
})

test('the status line carries counts only, never a topic', () => {
  const line = statusLine(ready) ?? ''
  assert.equal(line, '3ngram: 4 open · 1 overdue')
  for (const row of list.commitments ?? []) assert.ok(!line.includes(row.topic))
})

test('nothing is shown while loading, even with a record held', () => {
  const loading = reduce(ready, {
    type: 'refresh_started',
    gen: 2,
    selectionKey: 'other',
    fingerprint: FP_A,
  })
  assert.equal(panelView(loading, NOW).sections.length, 0)
  assert.deepEqual(panelView(loading, NOW).header, ['3ngram commitments'])
  assert.equal(panelView(loading, NOW).canCancel, true)
})

test('a pull request closed without merging says so', () => {
  assert.equal(
    githubLabel({
      kind: 'github_reference',
      source: 'github',
      ref: 'o/r#7',
      referenceForm: 'qualified',
      type: 'pull_request',
      state: 'closed',
      stateReason: null,
      closedAt: '2026-10-01T00:00:00Z',
      mergedAt: null,
    }),
    'PR o/r#7 closed without merging 2026-10-01',
  )
})

test('GitHub references read as related, never as done', () => {
  assert.equal(
    githubLabel({
      kind: 'github_reference',
      source: 'github',
      ref: 'B3dmar/3ngram#251',
      referenceForm: 'bare',
      type: 'pull_request',
      state: 'merged',
      stateReason: null,
      closedAt: null,
      mergedAt: '2026-10-06T09:16:23Z',
    }),
    'PR B3dmar/3ngram#251 merged 2026-10-06',
  )
  assert.equal(
    githubLabel({
      kind: 'github_reference',
      source: 'github',
      ref: 'o/r#9',
      referenceForm: 'qualified',
      type: 'unknown',
      state: 'not_found',
      stateReason: null,
      closedAt: null,
      mergedAt: null,
    }),
    'o/r#9 not found or not visible',
  )
})

test('the detail view frames evidence for review and states the window', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  const view = detailView({
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'ready',
    envelope: show,
    error: null,
  })
  assert.equal(
    view.evidence[0],
    'Related evidence to review. It does not prove the commitment is done.',
  )
  assert.ok(view.source.includes('Source session: not exposed by the 3ngram read API.'))
  assert.ok(
    view.window.some((l) =>
      l.startsWith('Proposals: the newest 2 pending (limit 100, tenant-wide)'),
    ),
  )
  // Two hidden lineage nodes, one hidden direct link that repeats one of
  // them: reported apart, never summed into "3 memories".
  assert.ok(
    view.history.includes('Outside this selection and hidden: 2 lineage memories, 1 direct link.'),
  )
  assert.ok(!goldenText('show-review.json').includes('HIDDEN'))
})

test('a detail with nothing found says so, without claiming nothing exists', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  assert.ok(show.evidence)
  const none = {
    ...show,
    evidence: { ...show.evidence, verdict: 'none_found' as const, items: [] },
  }
  const view = detailView({
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'ready',
    envelope: none,
    error: null,
  })
  assert.equal(view.evidence[0], 'No evidence found in the inspected window.')
})

test('a detail where no source could be read never says nothing was found', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  assert.ok(show.evidence)
  const unread = {
    ...show,
    evidence: {
      ...show.evidence,
      verdict: 'not_inspected' as const,
      items: [],
      inspected: { proposals: null, history: null },
    },
    partial: [
      { part: 'history', reason: 'unavailable' },
      { part: 'proposals', reason: 'unavailable' },
    ],
  }
  const view = detailView({
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'ready',
    envelope: unread,
    error: null,
  })
  assert.equal(view.evidence[0], 'No evidence source could be read, so nothing was searched.')
  assert.ok(!view.evidence.some((l) => l.startsWith('No evidence found')))
})

test('a failed detail shows the reason', () => {
  const view = detailView({
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'error',
    envelope: null,
    error: { kind: 'outside_selector' },
  })
  assert.equal(view.status.label, 'ERROR: That commitment is outside the current selection.')
})

test('a failed history read does not claim the creation is outside the window', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  assert.ok(show.source)
  const failed = {
    ...show,
    source: { ...show.source, createdBy: null, createdAt: null },
    partial: [{ part: 'history', reason: 'unavailable' }],
  }
  const view = detailView({
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'ready',
    envelope: failed,
    error: null,
  })
  assert.equal(view.source[0], 'Creation is unknown: the history could not be read.')
})

test('an unavailable events section leaves creation unknown, not outside the window', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  assert.ok(show.source && show.history)
  const degraded = {
    ...show,
    source: { ...show.source, createdBy: null, createdAt: null },
    history: { ...show.history, events: [] },
    partial: [{ part: 'events', reason: 'unavailable' }],
  }
  const view = detailView({
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'ready',
    envelope: degraded,
    error: null,
  })
  assert.equal(view.source[0], 'Creation is unknown: the audit events could not be read.')
})

test('long content is cut to a bound the drawing can hold, and says so', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  assert.ok(show.commitment)
  const long = 'x'.repeat(MAX_CONTENT + 5)
  const view = detailView({
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'ready',
    envelope: { ...show, commitment: { ...show.commitment, content: long } },
    error: null,
  })
  assert.ok(view.content)
  assert.ok(view.content.startsWith('x'.repeat(MAX_CONTENT)))
  assert.ok(view.content.length < MAX_CONTENT + 100)
  assert.ok(
    view.content.endsWith(
      `[Showing the first 20,000 of ${(MAX_CONTENT + 5).toLocaleString('en-US')} characters.]`,
    ),
  )
  const short = detailView({
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'ready',
    envelope: { ...show, commitment: { ...show.commitment, content: 'short' } },
    error: null,
  })
  assert.equal(short.content, 'short')
})
