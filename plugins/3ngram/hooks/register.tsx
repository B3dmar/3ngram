// SPDX-License-Identifier: Apache-2.0

import type { Register } from 'claude-code'
import { initialState, unconfirmed } from './lib/state.ts'
import { statusLine } from './lib/view.ts'
import { drawPane } from './pane.tsx'
import { cancel, closeDetail, openDetail, refresh } from './reads.ts'
import { dispatch, fire, readPanel, runtime, stopReads } from './runtime.ts'
import { armRefresh, disarmRefresh, redrawAtMidnight } from './timers.ts'

// The 3ngram commitment panel: a read-only pane over `3ngram-hook
// commitments`. Everything it shows comes from that binary's JSON envelopes;
// the module itself never reads the API key, never calls the network or an
// MCP server, and never writes a file or the store. All of that is pinned by
// tests/panel.test.ts and by `claude plugin validate` (it reads no env).
//
// This file registers the hooks and says what each event starts or stops.
// What the module holds between events is in runtime.ts, the reads in
// reads.ts, the child process in spawn.ts, the timers in timers.ts, and the
// drawing in pane.tsx.

const PANE = '3ngram-commitments'
const TITLE = '3ngram commitments'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // First, before any await: nothing the host kept draws until the current
    // selection is confirmed (see selectionConfirmed in runtime.ts).
    runtime.selectionConfirmed = false
    runtime.startEpoch++
    $.ui.invalidate('ui.render')
    $.ui.status(statusLine(unconfirmed(initialState)))
    await $.command.register({
      name: 'commitments',
      description: 'Open the read-only 3ngram commitment panel',
    })
    // session.start fires again after a reload. Whatever this environment
    // still holds from an earlier start (its timers, a child) is ended first,
    // so timers never pile up; a read the reload interrupted counts as
    // cancelled and its context is checked again. This also ends a midnight
    // redraw that a draw during the await above armed; it is armed again by
    // the next draw, at the latest the one opening the gate makes
    // (confirmSelection).
    disarmRefresh()
    const s = await readPanel($)
    if (s.status === 'loading' || s.status === 'checking' || s.status === 'refreshing') {
      await dispatch($, { type: 'reloaded' })
    }
    // A detail read the reload killed would otherwise stay "Loading…" for good.
    if (s.detail?.status === 'loading')
      await dispatch($, { type: 'detail_closed', seq: s.detail.seq })
    // Background work starts from timers, never inside this dispatch, so the
    // first prompt is never held by a read. A -p run or the SDK draws
    // nowhere (no surface), so it reads nothing in the background (no REST
    // reads, no gh) unless a client attaches later. The surface, not
    // isInteractive, decides: a reload after a client attached to such a
    // session starts with that client's surface and keeps the reads.
    if (e.surface !== null) armRefresh($, options)
    if (options.auto_open === true && e.isInteractive) {
      fire($, $.ui.open({ id: PANE, title: TITLE }))
    }
    return next(e)
  })

  // A client joining a session that started where nothing draws: the pane
  // can now be shown, so the background reads start.
  on('session.attach', async ($, e, next) => {
    armRefresh($, options)
    return next(e)
  })

  // The last client that could draw the pane left: the background reads stop
  // until another attaches. A session ending under its clients is
  // session.end's to handle.
  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'detach' && (await $.session.surfaces()).length === 0) disarmRefresh()
    return result
  })

  on('session.end', async (_$, e, next) => {
    // /clear, /resume and /branch keep the module but end the conversation:
    // its reads stop now. Its $.state is reset to the defaults after this
    // hook, so the fresh read starts from classic.SessionStart below.
    if (e.reason === 'clear' || e.reason === 'resume') {
      stopReads()
      runtime.resetPending = true
    }
    return next(e)
  })

  // Fires after /clear, /resume and /branch (source fork) have reset $.state,
  // which session.start does not. Startup and compaction reset nothing, so
  // the matcher leaves them out. The settings hooks beneath still run.
  // /branch reports fork and has no session.end of its own, so a fork always
  // reads again; a launch with --fork-session costs one extra read.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (runtime.resetPending || e.source === 'fork') {
      runtime.resetPending = false
      stopReads()
      await dispatch($, { type: 'session_transition' })
      if (runtime.tick !== null) $.clock.after(0, () => fire($, refresh($, options)))
    }
    return next(e)
  })

  on('command.run', { command: 'commitments' }, async ($) => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    $.clock.after(0, () => fire($, refresh($, options)))
    // The model reads this line: it names the action, never a record.
    return { text: 'Opened the 3ngram commitments panel.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    // Decides only whether a time shown needs its date: every refresh redraws,
    // and so does the next UTC midnight (redrawAtMidnight). Read first: the
    // gate below must follow the render's last await, or a session.start
    // landing in it would draw what it closed the gate on.
    const now = await $.clock.now()
    const held = await readPanel($)
    const s = runtime.selectionConfirmed ? held : unconfirmed(held)
    redrawAtMidnight($, now)
    // The drawing is synchronous (pane.tsx): nothing suspends past the gate.
    return drawPane(ui, s, now, {
      back: () => fire($, closeDetail($)),
      refresh: () => fire($, refresh($, options)),
      cancel: () => fire($, cancel($, options)),
      open: (memoryId) => fire($, openDetail($, options, memoryId)),
    })
  })
}
