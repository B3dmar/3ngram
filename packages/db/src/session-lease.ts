// SPDX-License-Identifier: Apache-2.0
// The agent-session LEASE predicates and the monotonic refresh expression
// (docs/concepts/session-continuity.mdx, "Lease").
//
// WHY A MODULE OF ITS OWN. Two paths now decide "is this row still live, and if
// not, does touching it resurrect": the native write attach
// (session-provenance.ts) and the hook-facing lifecycle routes
// (session-lifecycle.ts). The page's rules — implicit close is evaluated on
// read and write rather than only after a sweeper stamps `closed_at`, an
// explicit close is identified forever by `closed_at <= last_seen_at + lease`,
// and a refresh is a FLOOR rather than an assignment — have to be spelled the
// same way in both or the two paths disagree about whether the same row is
// open. Provenance is the wrong home: the lifecycle routes are bookkeeping, not
// write-time attribution, so importing them from there would point the
// dependency backwards.
import { SESSION_LEASE_MS } from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import { agentSessions } from './schema/agent-sessions.js'

/** The oldest `last_seen_at` that still counts as leased at `now`. */
export function leaseFloor(now: Date): Date {
  return new Date(now.getTime() - SESSION_LEASE_MS)
}

/** Lease still live at `now` (a stale lease is the resurrect trigger). */
export function isLeased(lastSeenAt: Date, now: Date): boolean {
  return lastSeenAt.getTime() > leaseFloor(now).getTime()
}

/**
 * Explicit SessionEnd: closed while the lease was still live. Durable —
 * `last_seen_at` freezes at close, so the window never re-opens and the row
 * itself keeps telling an explicit close apart from a sweeper's implicit one.
 */
export function isExplicitClose(closedAt: Date | null, lastSeenAt: Date): boolean {
  return closedAt !== null && closedAt.getTime() <= lastSeenAt.getTime() + SESSION_LEASE_MS
}

/**
 * MONOTONIC lease refresh: never move `last_seen_at` backwards.
 *
 * `now` is captured in the caller's process before the statement runs, so a
 * slow writer can reach its UPDATE after a later one already committed a NEWER
 * heartbeat. A bare `SET last_seen_at = now` would then overwrite the fresher
 * timestamp with the older captured one, SHORTENING the lease — enough for the
 * next write to read the run as stale and resurrect it for no reason. GREATEST
 * makes a successful heartbeat a floor, never a rollback. The `::timestamptz`
 * cast is the repo's convention for an interpolated timestamp param (search.ts,
 * search-list.ts) — without it the param arrives untyped.
 */
export function monotonicLastSeen(now: Date) {
  return sql`GREATEST(${agentSessions.lastSeenAt}, ${now.toISOString()}::timestamptz)`
}
