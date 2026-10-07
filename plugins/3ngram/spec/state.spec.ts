// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Envelope } from '../hooks/lib/contract.ts'
import type { FailureKind, PanelEvent, PanelState } from '../hooks/lib/state.ts'
import {
  initialState,
  needsVerification,
  reduce,
  visibleDetail,
  visibleRows,
} from '../hooks/lib/state.ts'
import { FP_A, FP_B, golden, withFingerprint } from './fixtures.ts'

const KEY_A = '["/repo","work",true]'
const KEY_B = '["/repo","personal",false]'

function run(events: PanelEvent[], from: PanelState = initialState): PanelState {
  return events.reduce(reduce, from)
}

const listA = withFingerprint(golden('list-unscoped.json'), FP_A)
const listB = withFingerprint(golden('list-unscoped.json'), FP_B)

function errorEnvelope(kind: string, fingerprint: string): Envelope {
  return withFingerprint(
    { ...golden('list-auth.json'), error: { kind, route: 'briefing' } },
    fingerprint,
  )
}

// A panel showing context A's rows, generation 1.
const showingA = run([
  { type: 'refresh_started', gen: 1, selectionKey: KEY_A, fingerprint: FP_A },
  { type: 'list_envelope', gen: 1, envelope: listA, at: 1000 },
])

function rowCount(s: PanelState): number | null {
  return visibleRows(s)?.length ?? null
}

describe('rows only ever show with the context that produced them', () => {
  test('a successful read shows its rows', () => {
    assert.equal(showingA.status, 'ready')
    assert.equal(rowCount(showingA), 4)
  })

  test('a refresh for another selection clears rows before anything is read', () => {
    const s = reduce(showingA, {
      type: 'refresh_started',
      gen: 2,
      selectionKey: KEY_B,
      fingerprint: FP_A,
    })
    assert.equal(s.record, null)
    assert.equal(rowCount(s), null)
    assert.equal(s.status, 'loading')
  })

  test('a refresh for the same selection keeps rows visible while it runs', () => {
    const s = reduce(showingA, {
      type: 'refresh_started',
      gen: 2,
      selectionKey: KEY_A,
      fingerprint: FP_A,
    })
    assert.equal(s.status, 'refreshing')
    assert.equal(rowCount(s), 4)
  })

  test('a result from an older generation is ignored', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_B, fingerprint: FP_A },
        { type: 'list_envelope', gen: 1, envelope: listA, at: 2000 },
      ],
      showingA,
    )
    assert.equal(s.record, null)
  })

  test('a new envelope replaces the record whole, under its own fingerprint', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_envelope', gen: 2, envelope: listB, at: 2000 },
      ],
      showingA,
    )
    assert.equal(s.record?.envelope.context.fingerprint, FP_B)
  })
})

describe('an error envelope keeps rows only when it proves the same context', () => {
  for (const kind of ['timeout', 'unavailable', 'rate_limited', 'cancelled']) {
    test(`${kind} under the same fingerprint leaves the rows stale`, () => {
      const s = run(
        [
          { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
          { type: 'list_envelope', gen: 2, envelope: errorEnvelope(kind, FP_A), at: 2000 },
        ],
        showingA,
      )
      assert.equal(s.status, 'stale')
      assert.equal(s.stale?.reason, kind)
      assert.equal(rowCount(s), 4)
    })

    test(`${kind} under another fingerprint (key or backend changed) clears the rows`, () => {
      const s = run(
        [
          { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
          { type: 'list_envelope', gen: 2, envelope: errorEnvelope(kind, FP_B), at: 2000 },
        ],
        showingA,
      )
      assert.equal(s.status, 'error')
      assert.equal(s.record, null)
      assert.equal(rowCount(s), null)
    })
  }

  test('an auth failure clears the rows even under the same fingerprint', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_envelope', gen: 2, envelope: errorEnvelope('auth', FP_A), at: 2000 },
      ],
      showingA,
    )
    assert.equal(s.status, 'error')
    assert.equal(s.error?.kind, 'auth')
    assert.equal(s.record, null)
  })
})

// The account-switch gap: a failure that produces NO envelope carries no
// fingerprint, so rows may only stay after the local context probe confirms
// the record's context.
describe('a failure without an envelope keeps rows only after verification', () => {
  const failures: FailureKind[] = ['timeout', 'missing_binary', 'crash', 'unparseable', 'contract']

  for (const failure of failures) {
    const failed = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_failed', gen: 2, failure, at: 2000 },
      ],
      showingA,
    )

    test(`${failure}: rows are hidden while the context is checked`, () => {
      assert.equal(needsVerification(failed), true)
      assert.equal(rowCount(failed), null)
    })

    test(`${failure} after a key or backend change: the probe disagrees and everything is cleared`, () => {
      const detailed = run(
        [{ type: 'detail_requested', memoryId: listA.commitments?.[0]?.memoryId ?? '' }],
        showingA,
      )
      const s = run(
        [
          { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
          { type: 'list_failed', gen: 2, failure, at: 2000 },
          { type: 'context_verified', gen: 2, fingerprint: FP_B, at: 2100 },
        ],
        detailed,
      )
      assert.equal(s.status, 'error')
      assert.equal(s.error?.contextUnverified, true)
      assert.equal(s.record, null)
      assert.equal(s.detail, null)
    })

    test(`${failure} when the probe itself fails: everything is cleared`, () => {
      const s = reduce(failed, { type: 'context_verified', gen: 2, fingerprint: null, at: 2100 })
      assert.equal(s.record, null)
      assert.equal(s.status, 'error')
    })

    test(`${failure} under the same context: the rows come back as stale`, () => {
      const s = reduce(failed, { type: 'context_verified', gen: 2, fingerprint: FP_A, at: 2100 })
      assert.equal(s.status, 'stale')
      assert.equal(s.stale?.reason, failure)
      assert.equal(rowCount(s), 4)
    })
  }

  test('with no rows held, a failure is an error at once', () => {
    const s = run([
      { type: 'refresh_started', gen: 1, selectionKey: KEY_A, fingerprint: FP_A },
      { type: 'list_failed', gen: 1, failure: 'missing_binary', at: 1000 },
    ])
    assert.equal(s.status, 'error')
    assert.equal(s.error?.kind, 'missing_binary')
  })

  test('a refresh that starts during verification does not reveal the rows', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_failed', gen: 2, failure: 'timeout', at: 2000 },
        { type: 'refresh_started', gen: 3, selectionKey: KEY_A, fingerprint: FP_A },
      ],
      showingA,
    )
    assert.equal(s.status, 'loading')
    assert.equal(rowCount(s), null)
  })

  test('a verification for an older generation is ignored', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_failed', gen: 2, failure: 'timeout', at: 2000 },
        { type: 'refresh_started', gen: 3, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'context_verified', gen: 2, fingerprint: FP_A, at: 2100 },
      ],
      showingA,
    )
    assert.equal(s.status, 'loading')
  })
})

describe('cancellation', () => {
  test('cancel invalidates the generation; the cancelled read cannot land', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'cancel' },
        { type: 'list_envelope', gen: 2, envelope: listB, at: 2000 },
      ],
      showingA,
    )
    assert.equal(s.gen, 3)
    assert.equal(s.status, 'verifying')
    assert.equal(s.record?.envelope.context.fingerprint, FP_A)
  })

  test('cancel after a key change: the probe disagrees and everything is cleared', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'cancel' },
        { type: 'context_verified', gen: 3, fingerprint: FP_B, at: 2100 },
      ],
      showingA,
    )
    assert.equal(s.record, null)
    assert.equal(s.error?.kind, 'cancelled')
  })

  test('cancel under the same context leaves the rows stale', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'cancel' },
        { type: 'context_verified', gen: 3, fingerprint: FP_A, at: 2100 },
      ],
      showingA,
    )
    assert.equal(s.status, 'stale')
    assert.equal(s.stale?.reason, 'cancelled')
  })

  test('cancel with nothing in flight changes nothing', () => {
    assert.deepEqual(reduce(showingA, { type: 'cancel' }), showingA)
  })

  test('a hot reload during a read acts as a cancel', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'reloaded' },
      ],
      showingA,
    )
    assert.equal(s.gen, 3)
    assert.equal(needsVerification(s), true)
  })
})

describe('session transitions', () => {
  test('a /clear, /resume or /branch clears rows and detail and invalidates in-flight work', () => {
    const s = run(
      [
        { type: 'detail_requested', memoryId: listA.commitments?.[0]?.memoryId ?? '' },
        { type: 'session_transition' },
        { type: 'list_envelope', gen: 1, envelope: listA, at: 3000 },
      ],
      showingA,
    )
    assert.equal(s.status, 'idle')
    assert.equal(s.record, null)
    assert.equal(s.detail, null)
    assert.equal(s.selectionKey, null)
  })
})

describe('detail', () => {
  const memoryId = listA.commitments?.[0]?.memoryId ?? ''
  const show = withFingerprint(golden('show-review.json'), FP_A)

  test('only a visible row can be opened, and it carries the list context', () => {
    const s = reduce(showingA, { type: 'detail_requested', memoryId })
    assert.equal(s.detail?.fingerprint, FP_A)
    assert.equal(s.detail?.status, 'loading')
    assert.equal(reduce(showingA, { type: 'detail_requested', memoryId: 'not-a-row' }).detail, null)
    const loading = reduce(showingA, {
      type: 'refresh_started',
      gen: 2,
      selectionKey: KEY_B,
      fingerprint: FP_A,
    })
    assert.equal(reduce(loading, { type: 'detail_requested', memoryId }).detail, null)
  })

  test('a detail answered under another context is refused', () => {
    const s = run(
      [
        { type: 'detail_requested', memoryId },
        { type: 'detail_envelope', seq: 1, envelope: withFingerprint(show, FP_B) },
      ],
      showingA,
    )
    assert.equal(s.detail?.status, 'error')
    assert.equal(s.detail?.error?.kind, 'context_changed')
    assert.equal(s.detail?.envelope, null)
  })

  test('a list read under a new context drops an open detail', () => {
    const s = run(
      [
        { type: 'detail_requested', memoryId },
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_envelope', gen: 2, envelope: listB, at: 2000 },
        { type: 'detail_envelope', seq: 1, envelope: show },
      ],
      showingA,
    )
    assert.equal(s.detail, null)
  })

  test('a detail lands when it matches; a stale sequence is ignored', () => {
    const s = run(
      [
        { type: 'detail_requested', memoryId },
        { type: 'detail_requested', memoryId },
        { type: 'detail_envelope', seq: 1, envelope: show },
      ],
      showingA,
    )
    assert.equal(s.detail?.status, 'loading')
    const landed = reduce(s, { type: 'detail_envelope', seq: 2, envelope: show })
    assert.equal(landed.detail?.status, 'ready')
  })

  test('a failed detail shows the failure, never an old envelope', () => {
    const s = run(
      [
        { type: 'detail_requested', memoryId },
        { type: 'detail_failed', seq: 1, failure: 'timeout' },
      ],
      showingA,
    )
    assert.equal(s.detail?.status, 'error')
    assert.equal(s.detail?.envelope, null)
  })
})

describe('the probe before each refresh', () => {
  test('a held record the probe confirms keeps showing while the read runs', () => {
    const s = reduce(showingA, {
      type: 'refresh_started',
      gen: 2,
      selectionKey: KEY_A,
      fingerprint: FP_A,
    })
    assert.equal(s.status, 'refreshing')
    assert.equal(rowCount(s), 4)
  })

  test('a key or backend change is caught before the read: the record is cleared', () => {
    const s = reduce(showingA, {
      type: 'refresh_started',
      gen: 2,
      selectionKey: KEY_A,
      fingerprint: FP_B,
    })
    assert.equal(s.record, null)
    assert.equal(s.status, 'loading')
  })

  test('a probe that could not answer clears the record too', () => {
    const s = reduce(showingA, {
      type: 'refresh_started',
      gen: 2,
      selectionKey: KEY_A,
      fingerprint: null,
    })
    assert.equal(s.record, null)
  })
})

describe('the detail never outlives the context check of its list', () => {
  const memoryId = listA.commitments?.[0]?.memoryId ?? ''
  const show = withFingerprint(golden('show-review.json'), FP_A)
  const open = run(
    [
      { type: 'detail_requested', memoryId },
      { type: 'detail_envelope', seq: 1, envelope: show },
    ],
    showingA,
  )

  test('an open detail is visible while its rows are', () => {
    assert.equal(visibleDetail(open)?.status, 'ready')
  })

  test('a failure without an envelope drops the detail with the rows', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_failed', gen: 2, failure: 'timeout', at: 2000 },
      ],
      open,
    )
    assert.equal(s.detail, null)
    assert.equal(visibleDetail(s), null)
    // Confirmed: the rows come back, the detail does not.
    const back = reduce(s, { type: 'context_verified', gen: 2, fingerprint: FP_A, at: 2100 })
    assert.equal(rowCount(back), 4)
    assert.equal(back.detail, null)
  })

  test('a cancel drops the detail with the rows', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'cancel' },
      ],
      open,
    )
    assert.equal(s.detail, null)
  })

  test('a detail answer arriving while the list is verified is ignored', () => {
    const pendingDetail = run(
      [
        { type: 'detail_requested', memoryId },
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_failed', gen: 2, failure: 'timeout', at: 2000 },
        { type: 'detail_envelope', seq: 1, envelope: show },
      ],
      showingA,
    )
    assert.equal(pendingDetail.detail, null)
    assert.equal(visibleDetail(pendingDetail), null)
  })

  test('a refresh that hides the rows hides the detail', () => {
    const s = reduce(open, {
      type: 'refresh_started',
      gen: 2,
      selectionKey: KEY_B,
      fingerprint: FP_A,
    })
    assert.equal(visibleDetail(s), null)
  })
})

describe('closing a detail', () => {
  const memoryId = listA.commitments?.[0]?.memoryId ?? ''

  test('a close for an earlier detail leaves a later one open', () => {
    const s = run(
      [
        { type: 'detail_requested', memoryId },
        { type: 'detail_requested', memoryId },
        { type: 'detail_closed', seq: 1 },
      ],
      showingA,
    )
    assert.equal(s.detail?.seq, 2)
    assert.equal(reduce(s, { type: 'detail_closed', seq: 2 }).detail, null)
    assert.equal(reduce(s, { type: 'detail_closed' }).detail, null)
  })
})

describe('a refresh and the open detail', () => {
  const memoryId = listA.commitments?.[0]?.memoryId ?? ''
  const show = withFingerprint(golden('show-review.json'), FP_A)
  const open = run(
    [
      { type: 'detail_requested', memoryId },
      { type: 'detail_envelope', seq: 1, envelope: show },
    ],
    showingA,
  )

  test('a detail whose commitment left the list is closed by the refresh', () => {
    const without = {
      ...listA,
      commitments: (listA.commitments ?? []).filter((r) => r.memoryId !== memoryId),
    }
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_envelope', gen: 2, envelope: without, at: 2000 },
      ],
      open,
    )
    assert.equal(s.detail, null)
  })

  test('a detail whose commitment is still listed stays open', () => {
    const s = run(
      [
        { type: 'refresh_started', gen: 2, selectionKey: KEY_A, fingerprint: FP_A },
        { type: 'list_envelope', gen: 2, envelope: listA, at: 2000 },
      ],
      open,
    )
    assert.equal(s.detail?.status, 'ready')
  })
})
