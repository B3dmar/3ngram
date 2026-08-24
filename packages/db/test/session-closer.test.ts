// SPDX-License-Identifier: Apache-2.0
// The sweep's CLASSIFICATION MATH, pinned without a database.
//
// The load-bearing property of the lease-expiry sweep is not that it finds rows
// — it is that the `closed_at` it stamps still reads as an IMPLICIT close, so a
// user who comes back can resurrect the row. `isExplicitClose` decides that
// forever by `closed_at <= last_seen_at + lease`, and the ONLY thing keeping a
// swept stamp outside that window is the grace the sweep waits. If the grace
// ever went to zero, or the floor were computed off the lease alone, every
// swept row would silently start claiming to be an explicit SessionEnd — which
// would ALSO stop it resurrecting, permanently, with no error anywhere.
//
// So this suite pins the arithmetic and the boundary in both directions
// (docs/concepts/session-continuity.mdx, "Lease" and "Resurrection").
import {
  CLOSER_BACKOFF_BASE_MS,
  CLOSER_BACKOFF_MAX_MS,
  SESSION_LEASE_MS,
  SESSION_SWEEP_GRACE_MS,
} from '@3ngram/schema'
import { describe, expect, it } from 'vitest'
import { closerBackoffDelayMs, sweepFloor } from '../src/session-closer.js'
import { isExplicitClose, isLeased } from '../src/session-lease.js'

const NOW = new Date('2026-08-23T12:00:00.000Z')

/** `lastSeenAt` that far in the past, relative to NOW. */
function quietFor(ms: number): Date {
  return new Date(NOW.getTime() - ms)
}

describe('sweepFloor', () => {
  it('is one lease PLUS the grace behind now', () => {
    expect(sweepFloor(NOW).getTime()).toBe(
      NOW.getTime() - SESSION_LEASE_MS - SESSION_SWEEP_GRACE_MS,
    )
  })

  it('is strictly older than the lease floor, so a merely-expired lease is not swept', () => {
    const leaseExpired = quietFor(SESSION_LEASE_MS + 1)
    expect(isLeased(leaseExpired, NOW)).toBe(false)
    // Lease-expired but still inside the grace: NOT a sweep candidate. This is
    // the overnight-idle case the grace exists for — the page requires it to be
    // able to reopen rather than be debriefed mid-conversation.
    expect(leaseExpired.getTime() > sweepFloor(NOW).getTime()).toBe(true)
  })
})

describe('a swept close classifies as IMPLICIT', () => {
  it('at the earliest instant the sweep can fire', () => {
    // The tightest case: quiet for exactly lease + grace + 1ms, the first row
    // the `last_seen_at < sweepFloor(now)` predicate admits. If the margin is
    // wrong anywhere, it is wrong here.
    const lastSeenAt = quietFor(SESSION_LEASE_MS + SESSION_SWEEP_GRACE_MS + 1)
    expect(lastSeenAt.getTime() < sweepFloor(NOW).getTime()).toBe(true)

    // The sweep stamps closed_at = now.
    expect(isExplicitClose(NOW, lastSeenAt)).toBe(false)
  })

  it('for a row quiet far longer', () => {
    const lastSeenAt = quietFor(30 * SESSION_LEASE_MS)
    expect(isExplicitClose(NOW, lastSeenAt)).toBe(false)
  })

  it('and the boundary is exactly last_seen_at + lease', () => {
    // Not a sweep scenario — this pins the discriminator itself, so a future
    // change to the comparison operator cannot pass unnoticed. AT the boundary
    // the close is explicit; one millisecond past it, implicit.
    const lastSeenAt = quietFor(SESSION_LEASE_MS + SESSION_SWEEP_GRACE_MS + 1)
    const atBoundary = new Date(lastSeenAt.getTime() + SESSION_LEASE_MS)
    expect(isExplicitClose(atBoundary, lastSeenAt)).toBe(true)
    expect(isExplicitClose(new Date(atBoundary.getTime() + 1), lastSeenAt)).toBe(false)
  })
})

describe('an explicit SessionEnd close stays explicit', () => {
  it('when stamped while the lease is live', () => {
    // SessionEnd closes a live row and freezes last_seen_at there, so the
    // window never re-opens however long the row then sits.
    const lastSeenAt = quietFor(0)
    expect(isLeased(lastSeenAt, NOW)).toBe(true)
    expect(isExplicitClose(NOW, lastSeenAt)).toBe(true)
  })

  it('and is therefore never a sweep candidate in the first place', () => {
    // The sweep's WHERE requires `closed_at IS NULL`, so an already-closed row
    // is excluded before the floor is even consulted. This asserts the other
    // half: even a very old explicit close still classifies as explicit, so a
    // re-stamp would be the ONLY way to lose that — which is why the UPDATE
    // re-asserts `closed_at IS NULL` rather than trusting the SELECT.
    const lastSeenAt = quietFor(365 * SESSION_LEASE_MS)
    const closedAt = new Date(lastSeenAt.getTime() + 1000)
    expect(isExplicitClose(closedAt, lastSeenAt)).toBe(true)
  })
})

describe('closerBackoffDelayMs — the curve the backoff gate rides', () => {
  it('is exactly the base for the first failure', () => {
    expect(closerBackoffDelayMs(1)).toBe(CLOSER_BACKOFF_BASE_MS)
  })

  it('doubles per consecutive failure', () => {
    expect(closerBackoffDelayMs(2)).toBe(CLOSER_BACKOFF_BASE_MS * 2)
    expect(closerBackoffDelayMs(3)).toBe(CLOSER_BACKOFF_BASE_MS * 4)
    expect(closerBackoffDelayMs(4)).toBe(CLOSER_BACKOFF_BASE_MS * 8)
  })

  it('never exceeds the cap, however many consecutive failures', () => {
    expect(closerBackoffDelayMs(5)).toBe(CLOSER_BACKOFF_MAX_MS)
    expect(closerBackoffDelayMs(1000)).toBe(CLOSER_BACKOFF_MAX_MS)
    // Self-healing has a lower bound, not just an upper one: the cap is a
    // ceiling on the WAIT, never a signal that stops the row being retried.
    expect(closerBackoffDelayMs(1000)).toBeGreaterThan(0)
  })

  it('treats a non-positive count as the first failure — never a zero wait', () => {
    // The caller always passes the POST-increment count (>= 1), but a curve
    // that returned 0 or a negative delay for n <= 0 would gate nothing, which
    // silently defeats the whole mechanism for a mis-called caller.
    expect(closerBackoffDelayMs(0)).toBe(CLOSER_BACKOFF_BASE_MS)
    expect(closerBackoffDelayMs(-3)).toBe(CLOSER_BACKOFF_BASE_MS)
  })

  it('the base is at least one sweep tick, or the gate would never bind', () => {
    // Below the sweep's own cadence, next_attempt_at would already be in the
    // past by the time the very next tick runs — the floor is a property of
    // the mechanism, not a free constant.
    //
    // The 20-minute literal is SESSION_SWEEP_CRON's own cadence
    // (apps/worker/src/queues.ts), hardcoded here rather than imported because
    // this package cannot depend on apps/worker. It is NOT independent of that
    // cron — issue #184 audit note 9: widening the cron without lowering this
    // literal (or raising CLOSER_BACKOFF_BASE_MS to match) would let this
    // assertion drift from the invariant it exists to pin.
    expect(CLOSER_BACKOFF_BASE_MS).toBeGreaterThanOrEqual(20 * 60 * 1000)
  })
})

describe('the grace is non-zero', () => {
  it('so a swept stamp cannot land inside the explicit-close window', () => {
    // A regression guard with teeth: with SESSION_SWEEP_GRACE_MS at 0, the
    // earliest sweepable row would have last_seen_at === now - lease, and
    // stamping closed_at = now would give exactly `closed_at === last_seen_at +
    // lease` — an EXPLICIT close by the discriminator, and an unresurrectable
    // row. The grace is what buys the strict inequality.
    expect(SESSION_SWEEP_GRACE_MS).toBeGreaterThan(0)
  })
})
