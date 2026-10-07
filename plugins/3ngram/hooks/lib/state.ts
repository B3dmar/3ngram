// SPDX-License-Identifier: Apache-2.0

import type { CommitmentRow, Envelope } from './contract.ts'

// The panel's state machine. It is pure: register.tsx runs the processes and
// feeds their outcomes in as events. The invariants it holds:
//
// - Rows exist only inside a record, next to the envelope (and so the context
//   fingerprint) that produced them; a new envelope replaces a record whole.
// - A refresh for a different selection, or one whose context probe could not
//   confirm the held record's fingerprint, clears the record before anything
//   is read; a result from an older generation is ignored.
// - After a failure, rows are kept (as stale) only when the failed attempt's
//   context is VERIFIED to be the record's: by the error envelope's own
//   fingerprint, or, when no envelope came back at all (a timeout, a missing
//   binary, a crash, a cancel), by the local `commitments context` probe.
//   Otherwise list and detail are both cleared.
// - The detail view shows under exactly the conditions the rows do, and is
//   dropped whenever the rows stop showing.

// How a run can fail without producing an envelope.
export type FailureKind =
  | 'timeout'
  | 'missing_binary'
  | 'too_old'
  | 'crash'
  | 'unparseable'
  | 'contract'
  | 'cancelled'
  | 'context_changed'
  | 'context_moved'

export type PanelStatus =
  | 'idle'
  | 'loading'
  | 'checking'
  | 'refreshing'
  | 'verifying'
  | 'ready'
  | 'stale'
  | 'error'

export type PanelError = { kind: string; hint?: string; contextUnverified?: boolean }

export type DetailState = {
  seq: number
  memoryId: string
  fingerprint: string
  status: 'loading' | 'ready' | 'error'
  envelope: Envelope | null
  error: PanelError | null
}

export type PanelState = {
  gen: number
  selectionKey: string | null
  status: PanelStatus
  record: { envelope: Envelope; fetchedAt: number } | null
  error: PanelError | null
  stale: { since: number; reason: string } | null
  // The failure a verification is pending for.
  pending: string | null
  detail: DetailState | null
  detailSeq: number
}

export const initialState: PanelState = {
  gen: 0,
  selectionKey: null,
  status: 'idle',
  record: null,
  error: null,
  stale: null,
  pending: null,
  detail: null,
  detailSeq: 0,
}

export type PanelEvent =
  // A refresh holding rows is about to probe the context: until the probe
  // confirms it, nothing read under the old context shows.
  | { type: 'check_started' }
  // fingerprint is what the local context probe reported just before this
  // refresh: null when it could not answer, or when no record was held.
  | { type: 'refresh_started'; gen: number; selectionKey: string; fingerprint: string | null }
  | { type: 'list_envelope'; gen: number; envelope: Envelope; at: number }
  | { type: 'list_failed'; gen: number; failure: FailureKind; at: number }
  | { type: 'cancel' }
  | { type: 'context_verified'; gen: number; fingerprint: string | null; at: number }
  | { type: 'detail_requested'; memoryId: string }
  | { type: 'detail_envelope'; seq: number; envelope: Envelope }
  | { type: 'detail_failed'; seq: number; failure: FailureKind }
  // seq, when given, closes only that detail (a later one stays open).
  | { type: 'detail_closed'; seq?: number }
  | { type: 'session_transition' }
  | { type: 'reloaded' }

// Envelope error kinds that say nothing changed about WHO or WHAT is read:
// with a matching fingerprint, the rows held are still the right rows.
const TRANSIENT = new Set(['timeout', 'unavailable', 'rate_limited', 'cancelled'])

const IN_FLIGHT = new Set<PanelStatus>(['loading', 'checking', 'refreshing'])

// The statuses in which rows, and an open detail, are shown.
const SHOWING = new Set<PanelStatus>(['ready', 'refreshing', 'stale'])

function cleared(s: PanelState, status: PanelStatus, error: PanelError | null): PanelState {
  return { ...s, status, error, record: null, detail: null, stale: null, pending: null }
}

export function reduce(s: PanelState, e: PanelEvent): PanelState {
  switch (e.type) {
    case 'check_started':
      return s.record && SHOWING.has(s.status) ? { ...s, status: 'checking' } : s
    case 'refresh_started':
      return onRefreshStarted(s, e.gen, e.selectionKey, e.fingerprint)
    case 'list_envelope':
      return e.gen === s.gen ? onListEnvelope(s, e.envelope, e.at) : s
    case 'list_failed': {
      if (e.gen !== s.gen) return s
      if (!s.record) return cleared(s, 'error', { kind: e.failure })
      // The detail goes with the rows: neither shows while the context is
      // unconfirmed, and a confirmed context brings back the rows only.
      return { ...s, status: 'verifying', pending: e.failure, detail: null }
    }
    case 'cancel': {
      if (!IN_FLIGHT.has(s.status)) return s
      const next = { ...s, gen: s.gen + 1 }
      return s.record
        ? { ...next, status: 'verifying', pending: 'cancelled', detail: null }
        : cleared(next, 'error', { kind: 'cancelled' })
    }
    case 'context_verified': {
      if (e.gen !== s.gen || s.status !== 'verifying') return s
      const reason = s.pending ?? 'unknown'
      if (
        s.record &&
        e.fingerprint !== null &&
        e.fingerprint === s.record.envelope.context.fingerprint
      ) {
        return { ...s, status: 'stale', stale: { since: e.at, reason }, pending: null }
      }
      return cleared(s, 'error', { kind: reason, contextUnverified: true })
    }
    case 'detail_requested':
      return onDetailRequested(s, e.memoryId)
    case 'detail_envelope':
      return onDetailEnvelope(s, e.seq, e.envelope)
    case 'detail_failed': {
      if (!s.detail || s.detail.seq !== e.seq) return s
      return {
        ...s,
        detail: { ...s.detail, status: 'error', envelope: null, error: { kind: e.failure } },
      }
    }
    case 'detail_closed':
      if (e.seq !== undefined && s.detail?.seq !== e.seq) return s
      return { ...s, detail: null }
    case 'session_transition':
      return { ...cleared(s, 'idle', null), gen: s.gen + 1, selectionKey: null }
    case 'reloaded':
      // A reload drops the module and kills the children it was waiting on.
      // Whatever was in flight is treated as cancelled.
      return reduce(s, { type: 'cancel' })
  }
}

function onRefreshStarted(
  s: PanelState,
  gen: number,
  selectionKey: string,
  fingerprint: string | null,
): PanelState {
  // A different selection, or a held record the probe could not confirm
  // (another key, another backend, or no answer), is cleared before the read
  // starts: its rows never show while the new context is being read.
  const unconfirmed = s.record !== null && fingerprint !== s.record.envelope.context.fingerprint
  if (selectionKey !== s.selectionKey || unconfirmed) {
    return { ...cleared(s, 'loading', null), gen, selectionKey }
  }
  // Rows stay visible during a refresh only if they were visible before it:
  // a record whose context is still being verified, or one an error already
  // hid, must not reappear just because a new read started.
  // checking hid the rows only until this confirmation.
  const shown = s.record !== null && (SHOWING.has(s.status) || s.status === 'checking')
  return {
    ...s,
    gen,
    status: shown ? 'refreshing' : 'loading',
    error: null,
    pending: null,
    detail: shown ? s.detail : null,
  }
}

function onListEnvelope(s: PanelState, envelope: Envelope, at: number): PanelState {
  if (envelope.ok) {
    const fingerprint = envelope.context.fingerprint
    // An open detail survives a refresh only under the same context AND while
    // its commitment is still in the list with the filing it was opened
    // under: one resolved or superseded since, or moved between this project
    // and unscoped in place, must not keep showing its old state.
    const detail =
      s.detail && s.detail.fingerprint === fingerprint && sameRow(s, envelope, s.detail.memoryId)
        ? s.detail
        : null
    return {
      ...s,
      status: 'ready',
      record: { envelope, fetchedAt: at },
      error: null,
      stale: null,
      pending: null,
      detail,
    }
  }
  const kind = envelope.error?.kind ?? 'unknown'
  const sameContext =
    s.record !== null && s.record.envelope.context.fingerprint === envelope.context.fingerprint
  if (sameContext && TRANSIENT.has(kind)) {
    return { ...s, status: 'stale', stale: { since: at, reason: kind }, pending: null }
  }
  const error: PanelError = envelope.error?.hint ? { kind, hint: envelope.error.hint } : { kind }
  return cleared(s, 'error', error)
}

// sameRow reports whether the refreshed list still holds memoryId as the
// open detail knows it: the same commitment status (open and waiting change
// in place) and no contradicting filing. What the detail knows is its own
// answer once it has one, the row it was opened from before that. A filing of
// `unknown` contradicts nothing: a list row is unknown when its lookup failed
// or was over budget, which says nothing about a move.
function sameRow(s: PanelState, envelope: Envelope, memoryId: string): boolean {
  const row = (envelope.commitments ?? []).find((r) => r.memoryId === memoryId)
  if (!row) return false
  const opened = s.record?.envelope.commitments?.find((r) => r.memoryId === memoryId)
  const commitment = s.detail?.envelope?.commitment
  // The detail's commitmentStatus is the list's status vocabulary (open,
  // waiting); its memory status (active) is not, so it is never compared.
  const heldStatus = commitment?.commitmentStatus ?? opened?.status
  if (heldStatus !== undefined && row.status !== heldStatus) return false
  const held = commitment?.filing ?? opened?.filing
  if (held === undefined || held === 'unknown' || row.filing === 'unknown') return true
  return row.filing === held
}

function onDetailRequested(s: PanelState, memoryId: string): PanelState {
  const rows = visibleRows(s)
  if (!s.record || !rows?.some((row) => row.memoryId === memoryId)) return s
  const seq = s.detailSeq + 1
  return {
    ...s,
    detailSeq: seq,
    detail: {
      seq,
      memoryId,
      fingerprint: s.record.envelope.context.fingerprint,
      status: 'loading',
      envelope: null,
      error: null,
    },
  }
}

function onDetailEnvelope(s: PanelState, seq: number, envelope: Envelope): PanelState {
  const detail = s.detail
  // A detail lands only while its rows show, under the context its list came
  // from.
  // While the context is being checked the detail is kept but hidden, so an
  // answer that lands then is kept too; visibleDetail shows it only once the
  // check confirms the context, and a disagreeing check clears it.
  if (!detail || detail.seq !== seq || !(SHOWING.has(s.status) || s.status === 'checking')) return s
  if (!s.record || s.record.envelope.context.fingerprint !== detail.fingerprint) {
    return { ...s, detail: null }
  }
  if (envelope.context.fingerprint !== detail.fingerprint) {
    return {
      ...s,
      detail: { ...detail, status: 'error', envelope: null, error: { kind: 'context_changed' } },
    }
  }
  if (!envelope.ok) {
    const error: PanelError = { kind: envelope.error?.kind ?? 'unknown' }
    return { ...s, detail: { ...detail, status: 'error', envelope: null, error } }
  }
  return { ...s, detail: { ...detail, status: 'ready', envelope, error: null } }
}

// visibleRows is the ONLY way the view reads rows: none while a load, a
// verification or an error is showing, even if a record is still held.
export function visibleRows(s: PanelState): CommitmentRow[] | null {
  if (!s.record || !SHOWING.has(s.status)) return null
  return s.record.envelope.commitments ?? null
}

// visibleDetail is the only way the view reads the detail: the same gate as
// the rows, and only under the record's own context.
export function visibleDetail(s: PanelState): DetailState | null {
  if (!s.detail || !s.record || !SHOWING.has(s.status)) return null
  return s.detail.fingerprint === s.record.envelope.context.fingerprint ? s.detail : null
}

export function needsVerification(s: PanelState): boolean {
  return s.status === 'verifying'
}
