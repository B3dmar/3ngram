// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Selection } from './lib/argv.ts'
import { contextArgv, isAllowedArgv, listArgv, selectionKey, showArgv } from './lib/argv.ts'
import { parseEnvelope } from './lib/contract.ts'
import { classifyEmptyOutput, classifySpawnError } from './lib/process.ts'
import type { FailureKind, PanelEvent, PanelState } from './lib/state.ts'
import { initialState, needsVerification, reduce, visibleDetail } from './lib/state.ts'
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

function stopReads(): void {
  stops++
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

function refreshMs(options: PluginOptions): number {
  const minutes = typeof options.refresh_minutes === 'number' ? options.refresh_minutes : 5
  return Math.max(MIN_REFRESH_MS, minutes * 60_000)
}

async function dispatch($: EngineInterface, event: PanelEvent): Promise<PanelState> {
  let next = initialState
  await update($, panel, (s) => {
    next = reduce((s as unknown as PanelState | undefined) ?? initialState, event)
    return next
  })
  $.ui.status(statusLine(next))
  return next
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
// never leaves the panel waiting on a verification nothing will finish.
async function verifyIfNeeded($: EngineInterface, options: PluginOptions): Promise<void> {
  const s = await readPanel($)
  if (!needsVerification(s)) return
  let fingerprint: string | null = null
  try {
    fingerprint = await probe($, selectionOf(options, await $.session.cwd()))
  } catch {
    fingerprint = null
  }
  await dispatch($, { type: 'context_verified', gen: s.gen, fingerprint, at: await $.clock.now() })
}

async function refresh($: EngineInterface, options: PluginOptions): Promise<void> {
  if (active !== null) {
    queued = true
    return
  }
  const token = ++tokens
  active = token
  try {
    await refreshOnce($, options, token)
  } catch {
    // A refresh that was already superseded reports nothing: the current
    // generation belongs to the read that replaced it.
    if (active === token) await reportUnexpected($, options)
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
// was stopped before its child started never starts one.
async function refreshOnce(
  $: EngineInterface,
  options: PluginOptions,
  token: number,
): Promise<void> {
  const sel = selectionOf(options, await $.session.cwd())
  // With rows held, the context is checked before the read: rows read under
  // another key or backend are cleared now, not after the read returns.
  const held = (await readPanel($)).record !== null
  const fingerprint = held ? await probe($, sel) : null
  if (active !== token) return
  const gen = (await readPanel($)).gen + 1
  await dispatch($, { type: 'refresh_started', gen, selectionKey: selectionKey(sel), fingerprint })
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
    await dispatch(
      $,
      parsed.ok
        ? { type: 'list_envelope', gen, envelope: parsed.envelope, at }
        : { type: 'list_failed', gen, failure: parsed.reason, at },
    )
  } else {
    await dispatch($, { type: 'list_failed', gen, failure: outcome.failure, at })
  }
  await verifyIfNeeded($, options)
}

// A refresh that failed outside its own handling (the session's directory
// could not be read, a state write was refused) is still a visible failure,
// never a silent one: it fails the current generation like a crash, and any
// verification that leaves pending is settled at once.
async function reportUnexpected($: EngineInterface, options: PluginOptions): Promise<void> {
  try {
    const s = await readPanel($)
    await dispatch($, {
      type: 'list_failed',
      gen: s.gen,
      failure: 'crash',
      at: await $.clock.now(),
    })
    await verifyIfNeeded($, options)
  } catch {
    $.ui.status('3ngram: unavailable')
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
  try {
    detailRead?.stop()
    const sel = selectionOf(options, await $.session.cwd())
    const outcome = await runHook(
      $,
      showArgv(sel, memoryId, detail.fingerprint),
      PROCESS_CEILING_MS,
      (stop) => {
        if (stops === epoch) detailRead = { seq, stop }
        else stop()
      },
    )
    if (detailRead?.seq === seq) detailRead = null
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
    const after = await dispatch($, { type: 'detail_envelope', seq, envelope: parsed.envelope })
    // The binary refused because the context moved on: read the list again.
    if (after.detail?.error?.kind === 'context_changed') await refresh($, options)
  } catch {
    await dispatch($, { type: 'detail_failed', seq, failure: 'crash' })
  }
}

async function closeDetail($: EngineInterface): Promise<void> {
  detailRead?.stop()
  detailRead = null
  await dispatch($, { type: 'detail_closed' })
}

async function startup($: EngineInterface, options: PluginOptions): Promise<void> {
  await verifyIfNeeded($, options)
  await refresh($, options)
}

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
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
    stopReads()
    const s = await readPanel($)
    if (s.status === 'loading' || s.status === 'refreshing') await dispatch($, { type: 'reloaded' })
    // Background work starts from timers, never inside this dispatch, so the
    // first prompt is never held by a read.
    kick = $.clock.after(0, () => fire($, startup($, options)))
    tick = $.clock.every(refreshMs(options), () => fire($, refresh($, options)))
    if (options.auto_open === true && e.isInteractive) {
      fire($, $.ui.open({ id: PANE, title: TITLE }))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear, /resume and /branch keep the module but not the conversation:
    // nothing read for the old one is kept, and the next read starts over.
    if (e.reason === 'clear' || e.reason === 'resume') {
      stopReads()
      await dispatch($, { type: 'session_transition' })
      $.clock.after(0, () => fire($, refresh($, options)))
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
    const s = await readPanel($)

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
