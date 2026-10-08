// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Selection } from './lib/argv.ts'
import { contextArgv, isAllowedArgv, listArgv, selectionKey, showArgv } from './lib/argv.ts'
import { parseEnvelope } from './lib/contract.ts'
import { classifyEmptyOutput, classifySpawnError } from './lib/process.ts'
import type { FailureKind, PanelEvent, PanelState } from './lib/state.ts'
import { initialState, needsVerification, reduce, unconfirmed, visibleDetail } from './lib/state.ts'
import { detailView, panelView, statusLine } from './lib/view.ts'

// The 3ngram commitment panel: a read-only pane over `3ngram-hook
// commitments`. Everything it shows comes from that binary's JSON envelopes;
// the module itself never reads the API key, never calls the network or an
// MCP server, and never writes a file or the store. All of that is pinned by
// tests/panel.test.ts and by `claude plugin validate` (it reads no env).

const PANE = '3ngram-commitments'
const TITLE = '3ngram commitments'
const PROCESS_CEILING_MS = 12_000
const PROBE_CEILING_MS = 3_000
const MIN_REFRESH_MS = 60_000
const MAX_STDOUT = 8 * 1024 * 1024
const MAX_LABEL = 90

const panel = atom({ plugin: '3ngram', key: 'panel' } as const, initialState)

// The contract (types/index.d.ts) names the value opaquely; this module is its
// only writer, and every write goes through reduce(), so reading it back as
// PanelState is sound.
async function readPanel($: EngineInterface): Promise<PanelState> {
  return (await read($, panel)) as unknown as PanelState
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
let active: number | null = null
let tokens = 0
let queued = false
let listRead: { token: number; stop: () => void } | null = null
let detailRead: { seq: number; stop: () => void } | null = null
// The refresh interval and the startup kick of the last session.start, ended
// before a later session.start arms new ones. One-shot kicks from commands
// and transitions fire at once and are not kept.
let tick: { cancel: () => void } | null = null
let kick: { cancel: () => void } | null = null
// stops counts stopReads calls, so a read that had not started its child
// when it was stopped still sees that it was, and never starts one.
let stops = 0
// wantedDetail is the sequence of the detail last asked for: a detail read
// that is no longer it stops its child instead of registering it.
let wantedDetail = 0
// resetPending is set by a session.end that announces a /clear or a /resume,
// so the classic.SessionStart that follows the state reset reads again, and
// a resume at launch (no session.end before it) does not read twice.
let resetPending = false
// requeuedFor is the fingerprint a read was last re-run for after its context
// changed mid-read, so a probe and a list that keep disagreeing about one
// context re-run it once, not forever.
let requeuedFor: string | null = null
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
let selectionConfirmed = false
// startEpoch counts session.starts. Every startup and refresh takes the
// epoch it began in, so one begun before the latest session.start can never
// open the gate that start closed.
let startEpoch = 0

// Opening the gate redraws the pane and republishes the status line from the
// state now held: a dispatch made while the gate was closed (a failure, a
// check or refresh start) published the unconfirmed status, which would
// otherwise stay until the next dispatch.
async function confirmSelection($: EngineInterface, epoch: number): Promise<void> {
  if (selectionConfirmed || epoch !== startEpoch) return
  selectionConfirmed = true
  $.ui.invalidate('ui.render')
  const held = await readPanel($)
  // A later session.start may have closed the gate during the read.
  if (selectionConfirmed && epoch === startEpoch) $.ui.status(statusLine(held))
}

// releaseDetailRead forgets the handle of a detail read that has ended, if it
// is still the one held.
function releaseDetailRead(seq: number): void {
  if (detailRead?.seq === seq) detailRead = null
}

function stopReads(): void {
  stops++
  // A stop is final: a refresh queued behind the stopped one is dropped too.
  queued = false
  listRead?.stop()
  detailRead?.stop()
  listRead = null
  detailRead = null
  active = null
}

type RunOutcome = { kind: 'output'; stdout: string } | { kind: 'failure'; failure: FailureKind }

function selectionOf(options: PluginOptions, cwd: string): Selection {
  const scope = typeof options.scope === 'string' ? options.scope.trim() : ''
  return {
    cwd,
    scope,
    includeUnscoped: options.include_unscoped === true,
    github: options.github_evidence === true,
  }
}

// armRefresh starts the background reads: the startup read now, then one per
// interval. It runs once a session can draw the pane, never twice.
function armRefresh($: EngineInterface, options: PluginOptions): void {
  if (tick !== null) return
  kick = $.clock.after(0, () => fire($, startup($, options)))
  tick = $.clock.every(refreshMs(options), () => fire($, refresh($, options)))
}

// disarmRefresh stops the background reads and anything they started.
function disarmRefresh(): void {
  tick?.cancel()
  kick?.cancel()
  tick = null
  kick = null
  stopReads()
}

function refreshMs(options: PluginOptions): number {
  const minutes = typeof options.refresh_minutes === 'number' ? options.refresh_minutes : 5
  return Math.max(MIN_REFRESH_MS, minutes * 60_000)
}

async function dispatch($: EngineInterface, event: PanelEvent): Promise<PanelState> {
  return (await dispatchApplied($, event)).state
}

// dispatchApplied is dispatch that also answers whether the reducer took the
// event: one it ignores (an older generation, a verification another one
// already settled) comes back as the very state it was given.
async function dispatchApplied(
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
  if (next.detail?.seq !== wantedDetail) wantedDetail = 0
  if (detailRead && detailRead.seq !== next.detail?.seq) {
    detailRead.stop()
    detailRead = null
  }
  // The status line is gated like the pane: no counts of an unconfirmed
  // selection.
  $.ui.status(statusLine(selectionConfirmed ? next : unconfirmed(next)))
  return { state: next, applied }
}

// fire runs work a handler or timer does not wait for, so a failure in it is
// still seen: in the panel's state where it can be, in the debug log always.
function fire($: EngineInterface, work: Promise<unknown>): void {
  work.catch(() => {
    $.ui.log('3ngram: a panel action failed', { to: 'debug' })
  })
}

// runHook spawns one allow-listed command and collects its stdout under a
// hard ceiling. onStart receives the function that ends the child early.
async function runHook(
  $: EngineInterface,
  argv: string[],
  ceilingMs: number,
  onStart?: (stop: () => void) => void,
): Promise<RunOutcome> {
  if (!isAllowedArgv(argv)) return { kind: 'failure', failure: 'contract' }
  let stdout = ''
  let stderr = ''
  let stopped: 'timeout' | 'cancelled' | 'crash' | null = null
  const stream = $.process.spawn({ argv })
  const stop = (why: 'timeout' | 'cancelled' | 'crash') => {
    stopped ??= why
    // Returning the stream ends the child (SIGTERM).
    stream.return(undefined as never).catch(() => {
      $.ui.log('3ngram: stopping a child failed', { to: 'debug' })
    })
  }
  const timer = $.clock.after(ceilingMs, () => stop('timeout'))
  onStart?.(() => stop('cancelled'))
  try {
    for await (const chunk of stream) {
      if (chunk.stream === 'stdout') stdout += chunk.text
      else stderr = (stderr + chunk.text).slice(-4096)
      if (stdout.length > MAX_STDOUT) stop('crash')
    }
  } catch (err) {
    if (stopped) return { kind: 'failure', failure: stopped }
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'failure', failure: classifySpawnError(message) }
  } finally {
    timer.cancel()
  }
  if (stopped) return { kind: 'failure', failure: stopped }
  if (stdout.trim() === '') return { kind: 'failure', failure: classifyEmptyOutput(stderr) }
  return { kind: 'output', stdout }
}

// probe runs `commitments context`, which makes no network call, and answers
// the fingerprint of the context a read would use now, or null.
async function probe($: EngineInterface, sel: Selection): Promise<string | null> {
  const outcome = await runHook($, contextArgv(sel), PROBE_CEILING_MS)
  if (outcome.kind !== 'output') return null
  const parsed = parseEnvelope(outcome.stdout)
  return parsed.ok && parsed.envelope.ok ? parsed.envelope.context.fingerprint : null
}

// verifyIfNeeded settles a pending verification: the probe's fingerprint, or
// null when the probe, or even reading the session's directory, failed. It
// never leaves the panel waiting on a verification nothing will finish, and
// answers whether its own probe settled one: the record is then kept, as
// stale, only under the context that probe confirmed. Two calls can find the
// same verification pending (a reload landing while an earlier startup's
// probe runs). The first answer settles it, possibly for the context from
// before the reload; the reducer ignores the second, which answers false.
async function verifyIfNeeded($: EngineInterface, options: PluginOptions): Promise<boolean> {
  const s = await readPanel($)
  if (!needsVerification(s)) return false
  let fingerprint: string | null = null
  try {
    fingerprint = await probe($, selectionOf(options, await $.session.cwd()))
  } catch {
    fingerprint = null
  }
  const at = await $.clock.now()
  const verified = await dispatchApplied($, {
    type: 'context_verified',
    gen: s.gen,
    fingerprint,
    at,
  })
  return verified.applied
}

async function refresh($: EngineInterface, options: PluginOptions): Promise<void> {
  if (active !== null) {
    queued = true
    return
  }
  const token = ++tokens
  active = token
  const epoch = startEpoch
  try {
    await refreshOnce($, options, token, epoch)
  } catch {
    // A refresh that was already superseded reports nothing: the current
    // generation belongs to the read that replaced it. A reported failure
    // has cleared or verified what was held, so the pane shows it.
    if (active === token && (await reportUnexpected($, options))) await confirmSelection($, epoch)
  } finally {
    if (active === token) active = null
  }
  if (queued && active === null) {
    queued = false
    await refresh($, options)
  }
}

// refreshOnce is one read. It stops at every await where its token may have
// been taken away (a cancel, a session transition, a reload), so a read that
// was stopped before its child started never starts one. epoch is the
// session.start it began under: a reload closes the gate before it takes the
// token away, and a read still running in between must not reopen it.
async function refreshOnce(
  $: EngineInterface,
  options: PluginOptions,
  token: number,
  epoch: number,
): Promise<void> {
  const sel = selectionOf(options, await $.session.cwd())
  // Stopped while the directory was read (a /clear, a fork, a reload): the
  // state may already be a later refresh's, so nothing is read or written.
  if (active !== token) return
  // With rows held, the context is checked before the read: rows read under
  // another key or backend are cleared now, not after the read returns.
  const held = (await readPanel($)).record !== null
  if (active !== token) return
  if (held) await dispatch($, { type: 'check_started' })
  if (active !== token) return
  const fingerprint = held ? await probe($, sel) : null
  if (active !== token) return
  const gen = (await readPanel($)).gen + 1
  if (active !== token) return
  await dispatch($, { type: 'refresh_started', gen, selectionKey: selectionKey(sel), fingerprint })
  // refresh_started clears whatever was held under another selection, or
  // under a context the probe did not confirm.
  await confirmSelection($, epoch)
  if (active !== token) return
  const outcome = await runHook($, listArgv(sel), PROCESS_CEILING_MS, (stop) => {
    if (active === token) listRead = { token, stop }
    else stop()
  })
  if (listRead?.token === token) listRead = null
  if (outcome.kind === 'failure' && outcome.failure === 'cancelled') return
  const at = await $.clock.now()
  if (outcome.kind === 'output') {
    const parsed = parseEnvelope(outcome.stdout)
    // The key or backend can change while the list runs, and the envelope
    // then speaks for the context it started under. One whose content would
    // be shown (its rows, or the stale rows a same-context error keeps) is
    // checked once more first: on a change nothing of it is, the rows go, and
    // the read runs again. An error for another context clears them anyway.
    const record = (await readPanel($)).record
    const shown =
      parsed.ok &&
      (parsed.envelope.ok ||
        (record !== null &&
          record.envelope.context.fingerprint === parsed.envelope.context.fingerprint))
    if (parsed.ok && shown) {
      const now = await probe($, sel)
      if (active !== token) return
      if (now !== parsed.envelope.context.fingerprint) {
        const rerun = now !== null && now !== requeuedFor
        // The message says a read follows only when one does.
        await dispatch($, {
          type: 'list_failed',
          gen,
          failure: rerun ? 'context_changed' : 'context_moved',
          at,
        })
        await dispatch($, { type: 'context_verified', gen, fingerprint: now, at })
        if (rerun) {
          requeuedFor = now
          queued = true
        }
        return
      }
    }
    await dispatch(
      $,
      parsed.ok
        ? { type: 'list_envelope', gen, envelope: parsed.envelope, at }
        : { type: 'list_failed', gen, failure: parsed.reason, at },
    )
  } else {
    await dispatch($, { type: 'list_failed', gen, failure: outcome.failure, at })
  }
  // Any read that ended without its context moving re-arms the one re-run.
  requeuedFor = null
  await verifyIfNeeded($, options)
}

// A refresh that failed outside its own handling (the session's directory
// could not be read, a state write was refused) is still a visible failure,
// never a silent one: it fails the current generation like a crash, and any
// verification that leaves pending is settled at once.
async function reportUnexpected($: EngineInterface, options: PluginOptions): Promise<boolean> {
  try {
    const s = await readPanel($)
    await dispatch($, {
      type: 'list_failed',
      gen: s.gen,
      failure: 'crash',
      at: await $.clock.now(),
    })
    await verifyIfNeeded($, options)
    return true
  } catch {
    $.ui.status('3ngram: unavailable')
    return false
  }
}

async function cancel($: EngineInterface, options: PluginOptions): Promise<void> {
  stopReads()
  try {
    await dispatch($, { type: 'cancel' })
    await verifyIfNeeded($, options)
  } catch {
    await reportUnexpected($, options)
  }
}

async function openDetail(
  $: EngineInterface,
  options: PluginOptions,
  memoryId: string,
): Promise<void> {
  const s = await dispatch($, { type: 'detail_requested', memoryId })
  const detail = s.detail
  if (!detail || detail.memoryId !== memoryId) return
  const seq = detail.seq
  const epoch = stops
  wantedDetail = seq
  try {
    // An earlier detail's child is stopped now; one that has not started yet
    // sees it is no longer wanted and never starts.
    detailRead?.stop()
    detailRead = null
    const sel = selectionOf(options, await $.session.cwd())
    const outcome = await runHook(
      $,
      showArgv(sel, memoryId, detail.fingerprint),
      PROCESS_CEILING_MS,
      (stop) => {
        if (stops === epoch && wantedDetail === seq) {
          detailRead?.stop()
          detailRead = { seq, stop }
        } else {
          stop()
        }
      },
    )
    releaseDetailRead(seq)
    // Stopped (Back, Cancel, a transition): close this detail quietly rather
    // than showing the stop as an error.
    if (outcome.kind === 'failure' && outcome.failure === 'cancelled') {
      await dispatch($, { type: 'detail_closed', seq })
      return
    }
    if (outcome.kind === 'failure') {
      await dispatch($, { type: 'detail_failed', seq, failure: outcome.failure })
      return
    }
    const parsed = parseEnvelope(outcome.stdout)
    if (!parsed.ok) {
      await dispatch($, { type: 'detail_failed', seq, failure: parsed.reason })
      return
    }
    // As for a list read: the key or backend can change while show runs, and
    // the answer then speaks for the context it started under. Checked once
    // more before any of it is shown; on a change the detail fails and the
    // list is read again, which clears the rows under the new context.
    if (parsed.envelope.ok) {
      const now = await probe($, sel)
      if (stops !== epoch || wantedDetail !== seq) {
        await dispatch($, { type: 'detail_closed', seq })
        return
      }
      if (now !== parsed.envelope.context.fingerprint) {
        await dispatch($, { type: 'detail_failed', seq, failure: 'context_changed' })
        await refresh($, options)
        return
      }
    }
    const after = await dispatch($, { type: 'detail_envelope', seq, envelope: parsed.envelope })
    // The binary refused because the context moved on: read the list again.
    if (after.detail?.error?.kind === 'context_changed') await refresh($, options)
  } catch {
    await dispatch($, { type: 'detail_failed', seq, failure: 'crash' })
  }
}

async function closeDetail($: EngineInterface): Promise<void> {
  // A detail read that has not started its child yet sees the epoch move and
  // never starts one.
  stops++
  detailRead?.stop()
  detailRead = null
  await dispatch($, { type: 'detail_closed' })
}

// startup is the first read after a session start or a reload. A reload
// that changed the options (a scope, the unscoped opt-in, GitHub lookups)
// leaves rows and a detail read under the old ones in the state the host
// kept, and one under the same options can keep rows read under another key.
// They never draw (selectionConfirmed is closed until they are confirmed)
// and they are cleared before any read, not when the next read lands.
async function startup($: EngineInterface, options: PluginOptions): Promise<void> {
  const epoch = startEpoch
  let settled = false
  try {
    settled = await settleHeld($, options)
  } catch {
    // Failed and cleared, or verified by the probe; if even that could not
    // be written, the gate stays closed and the status line says so.
    settled = await reportUnexpected($, options)
  }
  if (settled) await confirmSelection($, epoch)
  // A record that is not settled yet is the refresh's to confirm: its probe
  // runs before the read, and refresh_started (or a reported failure) opens
  // the gate.
  await refresh($, options)
}

// settleHeld compares the state the host kept with the current selection and
// answers whether it now belongs to it: true when a different selection was
// cleared, when no record is held, or when this startup's own probe settled
// a pending verification (the record kept as stale under the context that
// probe confirmed, cleared otherwise). A record held under the same
// selection with nothing pending, or one another verification settled
// first, is not settled here: its context is checked by the refresh that
// follows, so startup makes no read of its own.
async function settleHeld($: EngineInterface, options: PluginOptions): Promise<boolean> {
  const key = selectionKey(selectionOf(options, await $.session.cwd()))
  const held = await readPanel($)
  if (held.selectionKey !== null && held.selectionKey !== key) {
    await dispatch($, { type: 'session_transition' })
    return true
  }
  if (held.record === null) return true
  return verifyIfNeeded($, options)
}

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // First, before any await: nothing the host kept draws until the current
    // selection is confirmed (see selectionConfirmed).
    selectionConfirmed = false
    startEpoch++
    $.ui.invalidate('ui.render')
    $.ui.status(statusLine(unconfirmed(initialState)))
    await $.command.register({
      name: 'commitments',
      description: 'Open the read-only 3ngram commitment panel',
    })
    // session.start fires again after a reload. Whatever this environment
    // still holds from an earlier start (its timers, a child) is ended first,
    // so timers never pile up; a read the reload interrupted counts as
    // cancelled and its context is checked again.
    tick?.cancel()
    kick?.cancel()
    tick = null
    kick = null
    stopReads()
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
      resetPending = true
    }
    return next(e)
  })

  // Fires after /clear, /resume and /branch (source fork) have reset $.state,
  // which session.start does not. Startup and compaction reset nothing, so
  // the matcher leaves them out. The settings hooks beneath still run.
  // /branch reports fork and has no session.end of its own, so a fork always
  // reads again; a launch with --fork-session costs one extra read.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (resetPending || e.source === 'fork') {
      resetPending = false
      stopReads()
      await dispatch($, { type: 'session_transition' })
      if (tick !== null) $.clock.after(0, () => fire($, refresh($, options)))
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const held = await readPanel($)
    const s = selectionConfirmed ? held : unconfirmed(held)

    const shownDetail = visibleDetail(s)
    if (shownDetail) {
      const d = detailView(shownDetail)
      const lines = (prefix: string, items: string[], dim: boolean) =>
        items.map((line, i) => (
          <Text key={`${prefix}-${i}`} dimColor={dim}>
            {line}
          </Text>
        ))
      return (
        <Box flexDirection="column">
          <Box>
            <Button key="back" label="Back" hotkey="b" onPress={() => fire($, closeDetail($))} />
          </Box>
          <Text bold>{d.title}</Text>
          <Text bold={d.status.tone === 'error'} dimColor={d.status.tone === 'busy'}>
            {d.status.label}
          </Text>
          {d.labels.length > 0 ? <Text dimColor>{d.labels.join(' · ')}</Text> : null}
          {d.content !== null ? <Text>{d.content}</Text> : null}
          {lines('source', d.source, true)}
          {d.evidence.length > 0 ? <Text bold>Evidence</Text> : null}
          {lines('evidence', d.evidence, false)}
          {lines('window', d.window, true)}
          {d.history.length > 0 ? <Text bold>History</Text> : null}
          {lines('history', d.history, true)}
          {lines('note', d.notes, true)}
        </Box>
      )
    }

    const view = panelView(s)
    return (
      <Box flexDirection="column">
        {view.header.map((line, i) => (
          <Text key={`header-${i}`} bold={i === 0}>
            {line}
          </Text>
        ))}
        <Text
          bold={view.status.tone === 'stale' || view.status.tone === 'error'}
          dimColor={view.status.tone === 'busy'}
        >
          {view.status.label}
        </Text>
        <Box>
          <Button
            key="refresh"
            label="Refresh"
            hotkey="r"
            onPress={() => fire($, refresh($, options))}
          />
          {view.canCancel ? (
            <Button
              key="cancel"
              label="Cancel"
              hotkey="c"
              onPress={() => fire($, cancel($, options))}
            />
          ) : null}
        </Box>
        {view.empty !== null ? <Text dimColor>{view.empty}</Text> : null}
        {view.sections.map((section, si) => (
          <Box key={`section-${si}`} flexDirection="column" marginTop={1}>
            <Text bold>{section.title}</Text>
            {section.rows.map((row, ri) => (
              <Box key={`row-${si}-${ri}`} flexDirection="column">
                <Button
                  key={`open-${si}-${ri}`}
                  label={clip(row.title, MAX_LABEL)}
                  plain
                  onPress={() => fire($, openDetail($, options, row.memoryId))}
                />
                <Text dimColor>{row.labels.join(' · ')}</Text>
              </Box>
            ))}
          </Box>
        ))}
        {view.notes.map((note, i) => (
          <Text key={`note-${i}`} dimColor>
            {note}
          </Text>
        ))}
      </Box>
    )
  })
}
