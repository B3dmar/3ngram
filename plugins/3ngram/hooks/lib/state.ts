// SPDX-License-Identifier: Apache-2.0

import type { CommitmentRow, Envelope } from './contract.ts'

// The panel's state machine. It is pure: register.tsx runs the processes and
// feeds their outcomes in as events. The invariants it holds:
//
// - Rows exist only inside a record, next to the envelope (and so the context
//   fingerprint) that produced them; a new envelope replaces a record whole.
// - A refresh for a different selection clears the record before anything is
//   read, and a result from an older generation is ignored.
// - After a failure, rows are kept (as stale) only when the failed attempt's
//   context is VERIFIED to be the record's: by the error envelope's own
//   fingerprint, or, when no envelope came back at all (a timeout, a missing
//   binary, a crash, a cancel), by the local `commitments context` probe.
//   Otherwise list and detail are both cleared.

// How a run can fail without producing an envelope.
export type FailureKind =
  | 'timeout'
  | 'missing_binary'
  | 'too_old'
  | 'crash'
  | 'unparseable'
  | 'contract'
  | 'cancelled'

export type PanelStatus =
  | 'idle'
  | 'loading'
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
  | { type: 'refresh_started'; gen: number; selectionKey: string }
  | { type: 'list_envelope'; gen: number; envelope: Envelope; at: number }
  | { type: 'list_failed'; gen: number; failure: FailureKind; at: number }
  | { type: 'cancel' }
  | { type: 'context_verified'; gen: number; fingerprint: string | null; at: number }
  | { type: 'detail_requested'; memoryId: string }
  | { type: 'detail_envelope'; seq: number; envelope: Envelope }
  | { type: 'detail_failed'; seq: number; failure: FailureKind }
  | { type: 'detail_closed' }
  | { type: 'session_transition' }
  | { type: 'reloaded' }

// Envelope error kinds that say nothing changed about WHO or WHAT is read:
// with a matching fingerprint, the rows held are still the right rows.
const TRANSIENT = new Set(['timeout', 'unavailable', 'rate_limited', 'cancelled'])

const IN_FLIGHT = new Set<PanelStatus>(['loading', 'refreshing'])

function cleared(s: PanelState, status: PanelStatus, error: PanelError | null): PanelState {
  return { ...s, status, error, record: null, detail: null, stale: null, pending: null }
}

export function reduce(s: PanelState, e: PanelEvent): PanelState {
  switch (e.type) {
    case 'refresh_started': {
      if (e.selectionKey !== s.selectionKey) {
        return { ...cleared(s, 'loading', null), gen: e.gen, selectionKey: e.selectionKey }
      }
      // Rows stay visible during a refresh only if they were visible before
      // it: a record whose context is still being verified, or one an error
      // already hid, must not reappear just because a new read started.
      const shown =
        s.record !== null &&
        (s.status === 'ready' || s.status === 'refreshing' || s.status === 'stale')
      return {
        ...s,
        gen: e.gen,
        status: shown ? 'refreshing' : 'loading',
        error: null,
        pending: null,
      }
    }
    case 'list_envelope':
      return e.gen === s.gen ? onListEnvelope(s, e.envelope, e.at) : s
    case 'list_failed': {
      if (e.gen !== s.gen) return s
      if (!s.record) return cleared(s, 'error', { kind: e.failure })
      return { ...s, status: 'verifying', pending: e.failure }
    }
    case 'cancel': {
      if (!IN_FLIGHT.has(s.status)) return s
      const next = { ...s, gen: s.gen + 1 }
      return s.record
        ? { ...next, status: 'verifying', pending: 'cancelled' }
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
      return { ...s, detail: null }
    case 'session_transition':
      return { ...cleared(s, 'idle', null), gen: s.gen + 1, selectionKey: null }
    case 'reloaded': {
      // A reload drops the module and kills the children it was waiting on.
      // Whatever was in flight is treated as cancelled.
      return reduce(s, { type: 'cancel' })
    }
  }
}

function onListEnvelope(s: PanelState, envelope: Envelope, at: number): PanelState {
  if (envelope.ok) {
    const fingerprint = envelope.context.fingerprint
    const detail = s.detail && s.detail.fingerprint === fingerprint ? s.detail : null
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
  if (!detail || detail.seq !== seq) return s
  // A detail is only ever shown under the context its list came from.
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
  if (!s.record) return null
  if (s.status !== 'ready' && s.status !== 'refreshing' && s.status !== 'stale') return null
  return s.record.envelope.commitments ?? null
}

export function needsVerification(s: PanelState): boolean {
  return s.status === 'verifying'
}
