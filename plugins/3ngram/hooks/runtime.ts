// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { PanelEvent, PanelState } from './lib/state.ts'
import { initialState, reduce, unconfirmed } from './lib/state.ts'
import { statusLine } from './lib/view.ts'

// What the panel holds between events, all in this file: the panel's state in
// $.state (the panel atom, written only through dispatch), and the module
// state (runtime), which the hooks (register.tsx), the reads (reads.ts) and
// the timers (timers.ts) share. Each field says which race it settles.

const panel = atom({ plugin: '3ngram', key: 'panel' } as const, initialState)

// The contract (types/index.d.ts) names the value opaquely; this module is its
// only writer, and every write goes through reduce(), so reading it back as
// PanelState is sound.
export async function readPanel($: EngineInterface): Promise<PanelState> {
  return (await read($, panel)) as unknown as PanelState
}

type Cancellable = { cancel: () => void }

type Runtime = {
  active: number | null
  tokens: number
  queued: boolean
  listRead: { token: number; stop: () => void } | null
  detailRead: { seq: number; stop: () => void } | null
  tick: Cancellable | null
  kick: Cancellable | null
  midnight: { at: number; timer: Cancellable } | null
  stops: number
  halts: number
  wantedDetail: number
  resetPending: boolean
  requeuedFor: string | null
  selectionConfirmed: boolean
  startEpoch: number
}

// Module state, on purpose: a hot reload drops it together with the children
// and timers, which the engine ends on unload.
//
// active is the token of the refresh holding the single-flight guard, taken
// synchronously before its first await so two triggers in one tick cannot
// both start one. A refresh asked for while one runs is not dropped: queued
// makes it run once the current one ends. listRead and detailRead are the
// children in flight, so Cancel, a session transition and a reload can stop
// them; a stopped read's results are ignored by generation or sequence.
export const runtime: Runtime = {
  active: null,
  tokens: 0,
  queued: false,
  listRead: null,
  detailRead: null,
  // The refresh interval and the startup kick of the last session.start, ended
  // before a later session.start arms new ones. One-shot kicks from commands
  // and transitions fire at once and are not kept. A startup whose kick has
  // fired reads only while tick is still set (startup in reads.ts).
  tick: null,
  kick: null,
  // midnight is the redraw armed for the next UTC midnight after a draw
  // (redrawAtMidnight), ended with the background reads.
  midnight: null,
  // stops counts stopReads calls and Backs (closeDetail), so a read that had
  // not started its child when it was stopped still sees that it was, and
  // never starts one.
  stops: 0,
  // halts counts stopReads calls alone. A detail read that finds its context
  // changed asks for the list again only if none came since it was asked for
  // (openDetail); a Back is no stop, and its list read still runs.
  halts: 0,
  // wantedDetail is the sequence of the detail last asked for: a detail read
  // that is no longer it stops its child instead of registering it.
  wantedDetail: 0,
  // resetPending is set by a session.end that announces a /clear or a /resume,
  // so the classic.SessionStart that follows the state reset reads again, and
  // a resume at launch (no session.end before it) does not read twice.
  resetPending: false,
  // requeuedFor is the fingerprint a read was last re-run for after its context
  // changed mid-read, so a probe and a list that keep disagreeing about one
  // context re-run it once, not forever.
  requeuedFor: null,
  // selectionConfirmed gates what the pane draws. The host keeps $.state across
  // a reload, and a reload is how a changed scope, include_unscoped or GitHub
  // option takes effect, so rows and a detail read under the old options are
  // still held while startup awaits the session's directory. A record held
  // under the same selection can still be another account's or backend's (the
  // key rotated between sessions). The gate is closed from the moment the
  // module loads (this line), and closed again, before any await, at every
  // session.start; it opens only once the held state has been compared with
  // the current selection and its record, if any, with the current context:
  // cleared when either differs, or confirmed by the context probe
  // (confirmSelection). A failure that settles the held state the same way
  // opens it too, so the pane shows the failure instead of staying blank.
  selectionConfirmed: false,
  // startEpoch counts session.starts. Every startup and refresh takes the
  // epoch it began in, so one begun before the latest session.start can never
  // open the gate that start closed.
  startEpoch: 0,
}

// Opening the gate redraws the pane and republishes the status line from the
// state now held: a dispatch made while the gate was closed (a failure, a
// check or refresh start) published the unconfirmed status, which would
// otherwise stay until the next dispatch.
export async function confirmSelection($: EngineInterface, epoch: number): Promise<void> {
  if (runtime.selectionConfirmed || epoch !== runtime.startEpoch) return
  runtime.selectionConfirmed = true
  $.ui.invalidate('ui.render')
  const held = await readPanel($)
  // A later session.start may have closed the gate during the read.
  if (runtime.selectionConfirmed && epoch === runtime.startEpoch) $.ui.status(statusLine(held))
}

// releaseDetailRead forgets the handle of a detail read that has ended, if it
// is still the one held.
export function releaseDetailRead(seq: number): void {
  if (runtime.detailRead?.seq === seq) runtime.detailRead = null
}

export function stopReads(): void {
  runtime.stops++
  runtime.halts++
  // A stop is final: a refresh queued behind the stopped one is dropped too.
  runtime.queued = false
  runtime.listRead?.stop()
  runtime.detailRead?.stop()
  runtime.listRead = null
  runtime.detailRead = null
  runtime.active = null
}

export async function dispatch($: EngineInterface, event: PanelEvent): Promise<PanelState> {
  return (await dispatchApplied($, event)).state
}

// dispatchApplied is dispatch that also answers whether the reducer took the
// event: one it ignores (an older generation, a verification another one
// already settled) comes back as the very state it was given.
export async function dispatchApplied(
  $: EngineInterface,
  event: PanelEvent,
): Promise<{ state: PanelState; applied: boolean }> {
  let next = initialState
  let applied = false
  await update($, panel, (s) => {
    const prev = (s as unknown as PanelState | undefined) ?? initialState
    next = reduce(prev, event)
    applied = next !== prev
    return next
  })
  // A detail the panel no longer holds (a refresh found another context, its
  // row moved or left the list) has no use for its read. Its child is stopped
  // now rather than reading on under the old context, and a read still on its
  // way to starting one sees it is no longer wanted.
  if (next.detail?.seq !== runtime.wantedDetail) runtime.wantedDetail = 0
  if (runtime.detailRead && runtime.detailRead.seq !== next.detail?.seq) {
    runtime.detailRead.stop()
    runtime.detailRead = null
  }
  // The status line is gated like the pane: no counts of an unconfirmed
  // selection.
  $.ui.status(statusLine(runtime.selectionConfirmed ? next : unconfirmed(next)))
  return { state: next, applied }
}

// fire runs work a handler or timer does not wait for, so a failure in it is
// still seen: in the panel's state where it can be, in the debug log always.
export function fire($: EngineInterface, work: Promise<unknown>): void {
  work.catch(() => {
    $.ui.log('3ngram: a panel action failed', { to: 'debug' })
  })
}
