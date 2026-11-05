// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CommitmentRow, GitHubEvidence } from '../hooks/lib/contract.ts'
import { githubLabel, githubRowLabel } from '../hooks/lib/github.ts'
import type { PanelState } from '../hooks/lib/state.ts'
import { initialState, reduce, unconfirmed } from '../hooks/lib/state.ts'
import type { Clock } from '../hooks/lib/time.ts'
import { dueLabels, hostZone, nextMidnight, stamp, usableZone } from '../hooks/lib/time.ts'
import {
  detailView,
  failureText,
  footerLine,
  headerLine,
  hintText,
  listNotice,
  MAX_CONTENT,
  panelView,
  partialNote,
  rowView,
  sharesLine,
  statusLine,
} from '../hooks/lib/view.ts'
import { FP_A, golden, goldenText, withFingerprint } from './fixtures.ts'

const list = withFingerprint(golden('list-unscoped.json'), FP_A)
const ready: PanelState = [
  { type: 'refresh_started', gen: 1, selectionKey: 'k', fingerprint: FP_A } as const,
  { type: 'list_envelope', gen: 1, envelope: list, at: Date.UTC(2026, 9, 7, 12, 30) } as const,
].reduce(reduce, initialState)
// The time the view is drawn at: the day of every time in the fixtures. The
// fixture tests draw in UTC; the wall-clock rules below name their zones.
const NOW = Date.UTC(2026, 9, 7, 14)
const UTC: Clock = { now: NOW, zone: 'UTC' }
const CPH = 'Europe/Copenhagen'
// 17:40 CET on Thursday 5 November 2026.
const CPH_NOW: Clock = { now: Date.UTC(2026, 10, 5, 16, 40), zone: CPH }

function firstRow(): CommitmentRow {
  const [row] = list.commitments ?? []
  assert.ok(row)
  return row
}

function listOf(rows: CommitmentRow[]): PanelState {
  return reduce(
    reduce(initialState, { type: 'refresh_started', gen: 1, selectionKey: 'k', fingerprint: FP_A }),
    { type: 'list_envelope', gen: 1, envelope: { ...list, commitments: rows }, at: 0 },
  )
}

test('the header names the project and the scope; the footer the rest of the context', () => {
  assert.equal(headerLine(list), '3ngram · project demo · work')
  const anyScope = {
    ...list,
    context: { ...list.context, effective: { kind: 'project', project: 'demo' } },
  }
  assert.equal(headerLine(anyScope), '3ngram · project demo · any scope')
  assert.equal(
    footerLine(list, list.commitments ?? []),
    'api.example.test · owner@example.test · project name from the directory name · unscoped records included · owners not recorded',
  )
  assert.match(footerLine(anyScope, []), /unscoped records excluded$/)
})

test('rows say what is and is not recorded, in words, deadline first', () => {
  const [overdue, cut, unscoped, unknown] = list.commitments ?? []
  assert.ok(overdue && cut && unscoped && unknown)
  assert.deepEqual(rowView(overdue, 'open', UTC).labels, ['6 days overdue', 'due 1 Oct 00:00 UTC'])
  assert.deepEqual(rowView(cut, 'open', UTC).labels, ['no due date'])
  assert.deepEqual(rowView(unscoped, 'waiting', UTC).labels, [
    'no due date',
    'unscoped (no project)',
  ])
  assert.deepEqual(rowView(unknown, 'open', UTC).labels, ['no due date', 'filing unknown'])
  // A status the section does not imply is said: an overdue row that waits.
  assert.ok(rowView(unscoped, 'open', UTC).labels.includes('waiting'))
})

// #400: every row repeated "owner unclear (not recorded)".
test('an owner shows only where one is recorded; the footer says when any is not', () => {
  const row = firstRow()
  const owned = { ...row, ownership: { value: 'sebastian', reason: 'recorded' } }
  assert.ok(rowView(owned, 'open', UTC).labels.includes('owner sebastian'))
  assert.ok(!rowView(row, 'open', UTC).labels.some((l) => l.startsWith('owner')))
  assert.ok(!footerLine(list, [owned]).includes('owners not recorded'))
  assert.ok(footerLine(list, [owned, row]).endsWith('owners not recorded'))
})

test('a deadline reads relative to the day it is drawn, in the zone it is drawn in', () => {
  const due = (iso: string | null, clock = CPH_NOW) => dueLabels(iso, clock)
  assert.deepEqual(due('2026-11-05T17:00:00Z'), ['due today 18:00'])
  assert.deepEqual(due('2026-11-06T08:30:00Z'), ['due tomorrow 09:30'])
  assert.deepEqual(due('2026-11-10T17:00:00Z'), ['due in 5 days', '10 Nov 18:00'])
  assert.deepEqual(due('2026-11-05T08:00:00Z'), ['overdue since today 09:00'])
  assert.deepEqual(due('2026-11-04T17:00:00Z'), ['overdue since yesterday 18:00'])
  assert.deepEqual(due('2026-11-02T17:00:00Z'), ['3 days overdue', 'due 2 Nov 18:00'])
  // The year shows only when it is not this one, on the local calendar: this
  // instant is in 2025 in UTC and in 2026 in Copenhagen.
  assert.deepEqual(due('2027-01-04T11:00:00Z'), ['due in 60 days', '4 Jan 2027 12:00'])
  assert.deepEqual(due('2025-12-31T23:30:00Z'), ['308 days overdue', 'due 1 Jan 00:30'])
  // A deadline at midnight UTC is an instant like any other: it shows its time.
  assert.deepEqual(due('2026-11-10T00:00:00Z'), ['due in 5 days', '10 Nov 01:00'])
})

test('a deadline at its exact instant is still due; one millisecond past, overdue', () => {
  const at = '2026-11-05T16:40:00.000Z'
  assert.deepEqual(dueLabels(at, CPH_NOW), ['due today 17:40'])
  assert.deepEqual(dueLabels(at, { ...CPH_NOW, now: CPH_NOW.now + 1 }), [
    'overdue since today 17:40',
  ])
})

test('days are counted across local midnight, not in hours or in UTC', () => {
  // 23:59 in Copenhagen, a deadline two minutes later: tomorrow there, still
  // today in UTC.
  const late = { now: Date.UTC(2026, 10, 5, 22, 59), zone: CPH }
  assert.deepEqual(dueLabels('2026-11-05T23:01:00Z', late), ['due tomorrow 00:01'])
  assert.deepEqual(dueLabels('2026-11-05T23:01:00Z', { ...late, zone: 'UTC' }), ['due today 23:01'])
  // Across the change from summer time, a 25-hour day is still one day.
  const before = { now: Date.UTC(2026, 9, 24, 10), zone: CPH }
  assert.deepEqual(dueLabels('2026-10-26T10:00:00Z', before), ['due in 2 days', '26 Oct 11:00'])
})

test('an undated or unreadable deadline says so', () => {
  assert.deepEqual(dueLabels(null, CPH_NOW), ['no due date'])
  assert.deepEqual(dueLabels('soon', CPH_NOW), ['due date unreadable: soon'])
})

test('a deadline drawn with its zone names the zone in force at that instant', () => {
  assert.deepEqual(dueLabels('2026-11-05T17:00:00Z', CPH_NOW, true), ['due today 18:00 CET'])
  assert.deepEqual(dueLabels('2026-11-02T17:00:00Z', CPH_NOW, true), [
    '3 days overdue',
    'due 2 Nov 18:00 CET',
  ])
  assert.deepEqual(dueLabels('2027-07-01T10:00:00Z', CPH_NOW, true), [
    'due in 238 days',
    '1 Jul 2027 12:00 CEST',
  ])
})

test('a time carries its zone, and its date when it is not from the day drawn', () => {
  assert.equal(stamp(CPH_NOW.now, CPH_NOW), '17:40 CET')
  assert.equal(stamp(CPH_NOW.now - 86_400_000, CPH_NOW), '4 Nov 17:40 CET')
  assert.equal(stamp(Date.UTC(2025, 11, 31, 22, 50), CPH_NOW), '31 Dec 2025 23:50 CET')
  assert.equal(stamp(Date.UTC(2026, 6, 1, 10), CPH_NOW), '1 Jul 12:00 CEST')
  assert.equal(
    stamp(Date.UTC(2026, 10, 5, 16, 40), { ...CPH_NOW, zone: 'America/New_York' }),
    '11:40 GMT-5',
  )
})

// The module runtime reports the host's zone (Intl); a zone it cannot use is
// never guessed at.
test('a zone the runtime cannot use is read as UTC', () => {
  assert.equal(usableZone(CPH), CPH)
  assert.equal(usableZone('Mars/Olympus_Mons'), 'UTC')
  assert.equal(usableZone(''), 'UTC')
  assert.equal(usableZone(undefined), 'UTC')
  assert.equal(usableZone(hostZone()), hostZone())
})

test('overdue rows are listed most overdue first', () => {
  const row = firstRow()
  // The binary lists the commitments slice first and appends the overdue
  // split, so an overdue row it cut from the slice comes after a later one.
  const s = listOf([
    { ...row, memoryId: 'm1', topic: 'Due 5 Oct', dueAt: '2026-10-05T00:00:00.000Z' },
    { ...row, memoryId: 'm2', topic: 'Due 1 Oct', dueAt: '2026-10-01T00:00:00.000Z' },
  ])
  assert.deepEqual(
    panelView(s, UTC).sections[0]?.rows.map((r) => r.title),
    ['Due 1 Oct', 'Due 5 Oct'],
  )
})

test('an overdue row whose deadline does not parse sorts last, the rest by deadline', () => {
  const row = firstRow()
  const s = listOf([
    { ...row, memoryId: 'm0', topic: 'Unreadable', dueAt: 'not a date' },
    { ...row, memoryId: 'm1', topic: 'Due 5 Oct', dueAt: '2026-10-05T00:00:00.000Z' },
    { ...row, memoryId: 'm2', topic: 'Due 1 Oct', dueAt: '2026-10-01T00:00:00.000Z' },
  ])
  assert.deepEqual(
    panelView(s, UTC).sections[0]?.rows.map((r) => r.title),
    ['Due 1 Oct', 'Due 5 Oct', 'Unreadable'],
  )
})

test('the panel groups rows under a mark and a word, and labels every partial part', () => {
  const view = panelView(ready, UTC)
  assert.deepEqual(
    view.sections.map((s) => s.title),
    ['! OVERDUE (1)', '◦ OPEN (2)', '◒ WAITING (1)'],
  )
  assert.ok(
    view.notes.includes(
      'Unscoped check: verified 2 of 3 rows (unavailable); the rest are labelled "filing unknown".',
    ),
  )
  assert.ok(
    view.notes.includes('Owners and source sessions are not exposed by the 3ngram read API.'),
  )
  assert.equal(view.header, '3ngram · project demo · work')
  assert.ok(view.footer?.startsWith('api.example.test · owner@example.test'))
  assert.equal(view.status.label, 'Updated 12:30 UTC')
})

// Each mark is one cell wide in every terminal: ASCII, or of neutral East
// Asian width (○ and ◐ are ambiguous, and two cells where those draw wide).
test('the section marks are narrow-safe glyphs', () => {
  const marks = panelView(ready, UTC).sections.map((s) => [...s.title][0])
  assert.deepEqual(marks, ['!', '◦', '◒'])
})

test('the status shares the header line only where both fit', () => {
  const header = '3ngram · project 3ngram · work'
  assert.equal(sharesLine(header, 'Updated 17:40 CET', 52), true)
  assert.equal(sharesLine(header, 'Updated 17:40 CET', 48), false)
  const stale = 'STALE since 17:45 CET: The read timed out. Rows from 17:40 CET.'
  assert.equal(sharesLine(header, stale, 50), false)
  assert.equal(sharesLine(header, stale, 100), true)
})

test('header fitting reserves two cells for wide or ambiguous characters', () => {
  assert.equal(
    sharesLine('3ngram · project 日本語日本語 · any scope', 'Updated 17:40 CET', 54),
    false,
  )
  assert.equal(sharesLine('x🚀', 'ok', 6), false)
  assert.equal(sharesLine('x🚀', 'ok', 7), true)
  assert.equal(sharesLine('a\tb', 'ok', 100), false)
})

test('list deadlines distinguish both occurrences of the DST repeated hour', () => {
  const clock = { now: Date.parse('2026-10-25T00:00:00Z'), zone: CPH }
  const row = firstRow()
  assert.ok(
    rowView({ ...row, dueAt: '2026-10-25T00:30:00Z' }, 'open', clock).labels.includes(
      'due today 02:30 CEST',
    ),
  )
  assert.ok(
    rowView({ ...row, dueAt: '2026-10-25T01:30:00Z' }, 'open', clock).labels.includes(
      'due today 02:30 CET',
    ),
  )
  assert.ok(
    rowView({ ...row, dueAt: '2026-10-26T10:00:00Z' }, 'open', clock).labels.includes(
      'due tomorrow 11:00 CET',
    ),
  )
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

// #400: the binary's error.hint was kept in the state and never shown.
test("an error shows the binary's hint, unless the error already says it", () => {
  const failed = (kind: string, hint?: string) =>
    reduce(
      reduce(initialState, {
        type: 'refresh_started',
        gen: 1,
        selectionKey: 'k',
        fingerprint: null,
      }),
      {
        type: 'list_envelope',
        gen: 1,
        envelope: { ...list, ok: false, error: { kind, ...(hint ? { hint } : {}) } },
        at: 0,
      },
    )
  const tooLarge = panelView(failed('bad_response', 'response body too large'), UTC)
  assert.equal(tooLarge.status.label, 'ERROR: The server sent a response the panel cannot read.')
  assert.equal(tooLarge.hint, '3ngram-hook: response body too large')
  assert.equal(panelView(failed('auth', 'run 3ngram-hook verify'), UTC).hint, null)
  assert.equal(panelView(failed('unavailable'), UTC).hint, null)
  assert.equal(panelView(ready, UTC).hint, null)
  assert.equal(hintText({ kind: 'usage', hint: '  ' }), null)
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
    panelView(verified, UTC).status.label,
    'STALE since 13:05 UTC: The read timed out. Rows from 12:30 UTC.',
  )
  assert.equal(panelView(verified, UTC).status.tone, 'stale')
  assert.equal(statusLine(verified), '3ngram: 4 open · 1 overdue (stale)')
  // An open detail says so too, rather than only once Back is pressed.
  assert.equal(listNotice(verified, UTC), panelView(verified, UTC).status.label)
  assert.equal(listNotice(ready, UTC), null)
  const refreshing = reduce(ready, {
    type: 'refresh_started',
    gen: 2,
    selectionKey: 'k',
    fingerprint: FP_A,
  })
  assert.equal(panelView(refreshing, UTC).status.label, 'Refreshing… Rows from 12:30 UTC.')
  // Drawn on a later day, a time without its date would read as today's.
  const tomorrow = { now: Date.UTC(2026, 9, 8, 9), zone: 'UTC' }
  assert.equal(
    panelView(verified, tomorrow).status.label,
    'STALE since 7 Oct 13:05 UTC: The read timed out. Rows from 7 Oct 12:30 UTC.',
  )
  assert.equal(
    panelView(refreshing, tomorrow).status.label,
    'Refreshing… Rows from 7 Oct 12:30 UTC.',
  )
  assert.equal(panelView(ready, tomorrow).status.label, 'Updated 7 Oct 12:30 UTC')
  // In the host's zone: 14:30 in Copenhagen, which is on summer time.
  assert.equal(panelView(ready, { now: NOW, zone: CPH }).status.label, 'Updated 14:30 CEST')

  const cleared = reduce(stale, { type: 'context_verified', gen: 2, fingerprint: 'other', at: 0 })
  const view = panelView(cleared, UTC)
  assert.equal(view.sections.length, 0)
  assert.equal(view.footer, null)
  assert.match(
    view.status.label,
    /^ERROR: The read timed out\. The account or selection could not be confirmed/,
  )
  assert.equal(statusLine(cleared), '3ngram: unavailable')
})

// #400: a pane drawn just before midnight is drawn again at it, when a time it
// showed as today's becomes yesterday's and every deadline a day nearer.
test('a view drawn on one day goes out of date at the next midnight in its zone', () => {
  const midnight = nextMidnight(UTC)
  assert.equal(midnight, Date.UTC(2026, 9, 8))
  assert.equal(nextMidnight({ now: midnight - 1, zone: 'UTC' }), midnight)
  assert.equal(nextMidnight({ now: midnight, zone: 'UTC' }), Date.UTC(2026, 9, 9))
  assert.equal(
    nextMidnight({ now: Date.UTC(2026, 11, 31, 23, 59), zone: 'UTC' }),
    Date.UTC(2027, 0, 1),
  )
  assert.equal(
    panelView(ready, { now: midnight - 1, zone: 'UTC' }).status.label,
    'Updated 12:30 UTC',
  )
  assert.equal(
    panelView(ready, { now: midnight, zone: 'UTC' }).status.label,
    'Updated 7 Oct 12:30 UTC',
  )
  // Copenhagen's midnight is 23:00 UTC in winter and 22:00 in summer.
  assert.equal(nextMidnight(CPH_NOW), Date.UTC(2026, 10, 5, 23))
  assert.equal(
    nextMidnight({ now: Date.UTC(2026, 9, 24, 10), zone: CPH }),
    Date.UTC(2026, 9, 24, 22),
  )
  // The days the clocks change: 25 hours on 25 October, 23 on 29 March.
  assert.equal(
    nextMidnight({ now: Date.UTC(2026, 9, 25, 10), zone: CPH }),
    Date.UTC(2026, 9, 25, 23),
  )
  assert.equal(
    nextMidnight({ now: Date.UTC(2026, 2, 29, 10), zone: CPH }),
    Date.UTC(2026, 2, 29, 22),
  )
  // Where the clocks skip midnight (Chile, 6 September 2026), the day starts
  // at 01:00, which is 04:00 UTC.
  const santiago = { now: Date.UTC(2026, 8, 5, 16), zone: 'America/Santiago' }
  assert.equal(nextMidnight(santiago), Date.UTC(2026, 8, 6, 4))
})

test('the status line carries counts only, never a topic', () => {
  const line = statusLine(ready) ?? ''
  assert.equal(line, '3ngram: 4 open · 1 overdue')
  for (const row of list.commitments ?? []) assert.ok(!line.includes(row.topic))
})

// #400: the status bar read "3ngram: loading" during every pre-refresh check.
// The counts still stay hidden then (they could be another key's), but the
// check says what it is.
test('the status line says checking, without counts, while the context is checked', () => {
  const checking = reduce(ready, { type: 'check_started' })
  assert.equal(statusLine(checking), '3ngram: checking')
  assert.equal(statusLine(unconfirmed(ready)), '3ngram: checking')
  const verifying = reduce(
    reduce(ready, { type: 'refresh_started', gen: 2, selectionKey: 'k', fingerprint: FP_A }),
    { type: 'list_failed', gen: 2, failure: 'timeout', at: 0 },
  )
  assert.equal(statusLine(verifying), '3ngram: checking')
  const loading = reduce(ready, {
    type: 'refresh_started',
    gen: 2,
    selectionKey: 'other',
    fingerprint: FP_A,
  })
  assert.equal(statusLine(loading), '3ngram: loading')
  assert.equal(statusLine(initialState), undefined)
})

test('nothing is shown while loading, even with a record held', () => {
  const loading = reduce(ready, {
    type: 'refresh_started',
    gen: 2,
    selectionKey: 'other',
    fingerprint: FP_A,
  })
  assert.equal(panelView(loading, UTC).sections.length, 0)
  assert.equal(panelView(loading, UTC).header, '3ngram commitments')
  assert.equal(panelView(loading, UTC).footer, null)
  assert.equal(panelView(loading, UTC).canCancel, true)
})

function ref(fields: Partial<GitHubEvidence>): GitHubEvidence {
  return {
    kind: 'github_reference',
    source: 'github',
    ref: 'o/r#7',
    referenceForm: 'qualified',
    type: 'pull_request',
    state: 'open',
    stateReason: null,
    closedAt: null,
    mergedAt: null,
    ...fields,
  }
}

test('a pull request closed without merging says so', () => {
  const closed = ref({ state: 'closed', closedAt: '2026-10-01T00:00:00Z' })
  assert.equal(githubLabel(closed, UTC), 'PR o/r#7 closed without merging 1 Oct')
  assert.equal(githubRowLabel(closed), 'o/r#7 closed without merging')
})

test('GitHub references read as related, never as done', () => {
  const merged = ref({
    ref: 'B3dmar/3ngram#251',
    referenceForm: 'bare',
    state: 'merged',
    mergedAt: '2026-10-06T09:16:23Z',
  })
  assert.equal(githubLabel(merged, UTC), 'PR B3dmar/3ngram#251 merged 6 Oct')
  // A row keeps the reference as its topic wrote it: a bare #N stays #N.
  assert.equal(githubRowLabel(merged), '#251 merged')
  const gone = ref({ ref: 'o/r#9', type: 'unknown', state: 'not_found' })
  assert.equal(githubLabel(gone, UTC), 'o/r#9 not found or not visible')
  assert.equal(githubRowLabel(gone), 'o/r#9 not found or not visible')
  const issue = ref({ ref: 'o/r#8', referenceForm: 'bare', type: 'issue' })
  assert.equal(githubRowLabel(issue), '#8 open')
  assert.equal(githubLabel(issue, UTC), 'issue o/r#8 open')
  const dropped = ref({ type: 'issue', state: 'closed', stateReason: 'not_planned' })
  assert.equal(githubRowLabel(dropped), 'o/r#7 closed as not planned')
})

test('the detail view frames evidence for review and states the window', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  const view = detailView(
    {
      seq: 1,
      memoryId: 'm',
      listAt: 0,
      fingerprint: FP_A,
      status: 'ready',
      envelope: show,
      error: null,
    },
    UTC,
  )
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

test("the detail's labels lead with the row's deadline, with its zone", () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  const detail = {
    seq: 1,
    memoryId: 'm',
    listAt: 0,
    fingerprint: FP_A,
    status: 'ready' as const,
    envelope: show,
    error: null,
  }
  const row = { ...firstRow(), dueAt: '2026-11-02T17:00:00Z' }
  assert.deepEqual(detailView(detail, CPH_NOW, row).labels, [
    '3 days overdue',
    'due 2 Nov 18:00 CET',
    'open',
    'project demo',
  ])
  const owned = { ...row, ownership: { value: 'sebastian', reason: 'recorded' } }
  assert.ok(detailView(detail, CPH_NOW, owned).labels.includes('owner sebastian'))
  // Without its row (none is listed), no deadline is claimed.
  assert.deepEqual(detailView(detail, CPH_NOW).labels, ['open', 'project demo'])
})

test('a detail with nothing found says so, without claiming nothing exists', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  assert.ok(show.evidence)
  const none = {
    ...show,
    evidence: { ...show.evidence, verdict: 'none_found' as const, items: [] },
  }
  const view = detailView(
    {
      seq: 1,
      memoryId: 'm',
      listAt: 0,
      fingerprint: FP_A,
      status: 'ready',
      envelope: none,
      error: null,
    },
    UTC,
  )
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
  const view = detailView(
    {
      seq: 1,
      memoryId: 'm',
      listAt: 0,
      fingerprint: FP_A,
      status: 'ready',
      envelope: unread,
      error: null,
    },
    UTC,
  )
  assert.equal(view.evidence[0], 'No evidence source could be read, so nothing was searched.')
  assert.ok(!view.evidence.some((l) => l.startsWith('No evidence found')))
})

test('a failed detail shows the reason, and the binary hint under it', () => {
  const failed = (error: { kind: string; hint?: string }) =>
    detailView(
      {
        seq: 1,
        memoryId: 'm',
        listAt: 0,
        fingerprint: FP_A,
        status: 'error',
        envelope: null,
        error,
      },
      UTC,
    )
  const outside = failed({ kind: 'outside_selector' })
  assert.equal(outside.status.label, 'ERROR: That commitment is outside the current selection.')
  assert.equal(outside.hint, null)
  assert.equal(
    failed({ kind: 'bad_response', hint: 'memory fields missing' }).hint,
    '3ngram-hook: memory fields missing',
  )
})

test('a detail that fails with a hint keeps the hint in the state', () => {
  const opened = reduce(ready, { type: 'detail_requested', memoryId: firstRow().memoryId })
  const seq = opened.detail?.seq ?? 0
  const failed = reduce(opened, {
    type: 'detail_envelope',
    seq,
    envelope: { ...list, ok: false, error: { kind: 'bad_response', hint: 'validTo missing' } },
  })
  assert.deepEqual(failed.detail?.error, { kind: 'bad_response', hint: 'validTo missing' })
})

test('a failed history read does not claim the creation is outside the window', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  assert.ok(show.source)
  const failed = {
    ...show,
    source: { ...show.source, createdBy: null, createdAt: null },
    partial: [{ part: 'history', reason: 'unavailable' }],
  }
  const view = detailView(
    {
      seq: 1,
      memoryId: 'm',
      listAt: 0,
      fingerprint: FP_A,
      status: 'ready',
      envelope: failed,
      error: null,
    },
    UTC,
  )
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
  const view = detailView(
    {
      seq: 1,
      memoryId: 'm',
      listAt: 0,
      fingerprint: FP_A,
      status: 'ready',
      envelope: degraded,
      error: null,
    },
    UTC,
  )
  assert.equal(view.source[0], 'Creation is unknown: the audit events could not be read.')
})

test('long content is cut to a bound the drawing can hold, and says so', () => {
  const show = withFingerprint(golden('show-review.json'), FP_A)
  assert.ok(show.commitment)
  const long = 'x'.repeat(MAX_CONTENT + 5)
  const view = detailView(
    {
      seq: 1,
      memoryId: 'm',
      listAt: 0,
      fingerprint: FP_A,
      status: 'ready',
      envelope: { ...show, commitment: { ...show.commitment, content: long } },
      error: null,
    },
    UTC,
  )
  assert.ok(view.content)
  assert.ok(view.content.startsWith('x'.repeat(MAX_CONTENT)))
  assert.ok(view.content.length < MAX_CONTENT + 100)
  assert.ok(
    view.content.endsWith(
      `[Showing the first 20,000 of ${(MAX_CONTENT + 5).toLocaleString('en-US')} characters.]`,
    ),
  )
  const short = detailView(
    {
      seq: 1,
      memoryId: 'm',
      listAt: 0,
      fingerprint: FP_A,
      status: 'ready',
      envelope: { ...show, commitment: { ...show.commitment, content: 'short' } },
      error: null,
    },
    UTC,
  )
  assert.equal(short.content, 'short')
})
