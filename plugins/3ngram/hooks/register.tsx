// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Selection } from './lib/argv.ts'
import { contextArgv, isAllowedArgv, listArgv, selectionKey, showArgv } from './lib/argv.ts'
import { parseEnvelope } from './lib/contract.ts'
import { classifyEmptyOutput, classifySpawnError } from './lib/process.ts'
import type { FailureKind, PanelEvent, PanelState } from './lib/state.ts'
import { initialState, needsVerification, reduce } from './lib/state.ts'
import { detailView, panelView, statusLine } from './lib/view.ts'

// The 3ngram commitment panel: a read-only pane over `3ngram-hook
// commitments`. Everything it shows comes from that binary's JSON envelopes;
// the module itself never reads the API key, never calls the network or an
// MCP server, and never writes a file or the store. All of that is pinned by
// tests/panel.test.ts and by `claude plugin validate` (env reads: nothing).

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

// The child a refresh or detail is waiting on, so Cancel and a session
// transition can stop it. Module state on purpose: a hot reload drops it
// together with the children, which the engine kills on unload.
let inflight: { gen: number; stop: () => void } | null = null
// The token of the refresh that holds the single-flight guard. Taken
// synchronously, before the first await, so two triggers in the same tick
// cannot both start one; released when that refresh ends, or at once when its
// read is stopped (its results are ignored by generation from then on).
let active: number | null = null
let tokens = 0

// stopRead ends the read in flight, if any, and frees the guard for the next.
function stopRead(): void {
  inflight?.stop()
  inflight = null
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

// runHook spawns one allow-listed command and collects its stdout under a
// hard ceiling. onStop receives the function that ends the child early.
async function runHook(
  $: EngineInterface,
  argv: string[],
  ceilingMs: number,
  onStop?: (stop: () => void) => void,
): Promise<RunOutcome> {
  if (!isAllowedArgv(argv)) return { kind: 'failure', failure: 'contract' }
  let stdout = ''
  let stderr = ''
  let stopped: 'timeout' | 'cancelled' | 'crash' | null = null
  const stream = $.process.spawn({ argv })
  const stop = (why: 'timeout' | 'cancelled' | 'crash') => {
    stopped ??= why
    void stream.return(undefined as never)
  }
  const timer = $.clock.after(ceilingMs, () => stop('timeout'))
  onStop?.(() => stop('cancelled'))
  try {
    for await (const chunk of stream) {
      if (chunk.stream === 'stdout') stdout += chunk.text
      else stderr = (stderr + chunk.text).slice(-4096)
      if (stdout.length > MAX_STDOUT) stop('crash')
    }
  } catch (err) {
    if (stopped) return { kind: 'failure', failure: stopped }
    return {
      kind: 'failure',
      failure: classifySpawnError(err instanceof Error ? err.message : String(err)),
    }
  } finally {
    timer.cancel()
  }
  if (stopped) return { kind: 'failure', failure: stopped }
  if (stdout.trim() === '') return { kind: 'failure', failure: classifyEmptyOutput(stderr) }
  return { kind: 'output', stdout }
}

// verifyIfNeeded runs the local `commitments context` probe when a failure left
// rows whose context is unconfirmed, and reports the fingerprint it found
// (null when the probe could not answer).
async function verifyIfNeeded($: EngineInterface, sel: Selection): Promise<void> {
  const s = await readPanel($)
  if (!needsVerification(s)) return
  const gen = s.gen
  const outcome = await runHook($, contextArgv(sel), PROBE_CEILING_MS)
  let fingerprint: string | null = null
  if (outcome.kind === 'output') {
    const parsed = parseEnvelope(outcome.stdout)
    if (parsed.ok && parsed.envelope.ok) fingerprint = parsed.envelope.context.fingerprint
  }
  await dispatch($, { type: 'context_verified', gen, fingerprint, at: await $.clock.now() })
}

async function refresh($: EngineInterface, options: PluginOptions): Promise<void> {
  if (active !== null) return
  const token = ++tokens
  active = token
  try {
    await refreshOnce($, options)
  } catch {
    await reportUnexpected($)
  } finally {
    if (active === token) active = null
  }
}

// A refresh that failed outside its own handling (the session's directory
// could not be read, a state write was refused) is still a visible failure,
// never a silent one: it fails the current generation like a crash.
async function reportUnexpected($: EngineInterface): Promise<void> {
  try {
    const s = await readPanel($)
    await dispatch($, {
      type: 'list_failed',
      gen: s.gen,
      failure: 'crash',
      at: await $.clock.now(),
    })
  } catch {
    $.ui.status('3ngram: unavailable')
  }
}

// startup is the first read of a session or a reload: finish any
// verification a reload interrupted, then refresh.
async function startup($: EngineInterface, options: PluginOptions, cwd: string): Promise<void> {
  try {
    await verifyIfNeeded($, selectionOf(options, cwd))
  } catch {
    await reportUnexpected($)
  }
  await refresh($, options)
}

async function refreshOnce($: EngineInterface, options: PluginOptions): Promise<void> {
  const sel = selectionOf(options, await $.session.cwd())
  const gen = (await readPanel($)).gen + 1
  await dispatch($, { type: 'refresh_started', gen, selectionKey: selectionKey(sel) })
  try {
    const outcome = await runHook($, listArgv(sel), PROCESS_CEILING_MS, (stop) => {
      inflight = { gen, stop }
    })
    const at = await $.clock.now()
    if (outcome.kind === 'output') {
      const parsed = parseEnvelope(outcome.stdout)
      await dispatch(
        $,
        parsed.ok
          ? { type: 'list_envelope', gen, envelope: parsed.envelope, at }
          : { type: 'list_failed', gen, failure: parsed.reason, at },
      )
    } else if (outcome.failure === 'cancelled') {
      // cancel() already moved the generation on and runs the probe itself.
      return
    } else {
      await dispatch($, { type: 'list_failed', gen, failure: outcome.failure, at })
    }
  } catch {
    await dispatch($, { type: 'list_failed', gen, failure: 'crash', at: await $.clock.now() })
  } finally {
    if (inflight?.gen === gen) inflight = null
  }
  await verifyIfNeeded($, sel)
}

async function cancel($: EngineInterface, options: PluginOptions): Promise<void> {
  stopRead()
  try {
    await dispatch($, { type: 'cancel' })
    await verifyIfNeeded($, selectionOf(options, await $.session.cwd()))
  } catch {
    await reportUnexpected($)
  }
}

async function openDetail(
  $: EngineInterface,
  options: PluginOptions,
  memoryId: string,
): Promise<void> {
  try {
    await openDetailOnce($, options, memoryId)
  } catch {
    const seq = (await readPanel($)).detail?.seq
    if (seq !== undefined) await dispatch($, { type: 'detail_failed', seq, failure: 'crash' })
  }
}

async function openDetailOnce(
  $: EngineInterface,
  options: PluginOptions,
  memoryId: string,
): Promise<void> {
  const s = await dispatch($, { type: 'detail_requested', memoryId })
  const detail = s.detail
  if (!detail || detail.memoryId !== memoryId) return
  const sel = selectionOf(options, await $.session.cwd())
  const outcome = await runHook($, showArgv(sel, memoryId, detail.fingerprint), PROCESS_CEILING_MS)
  if (outcome.kind === 'failure') {
    await dispatch($, { type: 'detail_failed', seq: detail.seq, failure: outcome.failure })
    return
  }
  const parsed = parseEnvelope(outcome.stdout)
  if (!parsed.ok) {
    await dispatch($, { type: 'detail_failed', seq: detail.seq, failure: parsed.reason })
    return
  }
  const after = await dispatch($, {
    type: 'detail_envelope',
    seq: detail.seq,
    envelope: parsed.envelope,
  })
  // The binary refused because the context moved on: read the list again.
  if (after.detail?.error?.kind === 'context_changed') void refresh($, options)
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
    // A reload while a read was in flight: the child is gone with the old
    // module, so the read counts as cancelled and its context is re-checked.
    // A child this environment still holds is stopped for the same reason.
    stopRead()
    const s = await readPanel($)
    if (s.status === 'loading' || s.status === 'refreshing') await dispatch($, { type: 'reloaded' })
    // Background work starts from timers, never inside this dispatch, so the
    // first prompt is never held by a read.
    $.clock.after(0, () => {
      void startup($, options, e.cwd)
    })
    $.clock.every(refreshMs(options), () => {
      void refresh($, options)
    })
    if (options.auto_open === true && e.isInteractive) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear, /resume and /branch keep the module but not the conversation:
    // nothing read for the old one is kept, and the next read starts over.
    if (e.reason === 'clear' || e.reason === 'resume') {
      stopRead()
      await dispatch($, { type: 'session_transition' })
      $.clock.after(0, () => {
        void refresh($, options)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'commitments' }, async ($) => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    $.clock.after(0, () => {
      void refresh($, options)
    })
    // The model reads this line: it names the action, never a record.
    return { text: 'Opened the 3ngram commitments panel.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await readPanel($)

    if (s.detail) {
      const d = detailView(s.detail)
      return (
        <Box flexDirection="column">
          <Box>
            <Button
              key="back"
              label="Back"
              hotkey="b"
              onPress={() => void dispatch($, { type: 'detail_closed' })}
            />
          </Box>
          <Text bold>{d.title}</Text>
          <Text bold={d.status.tone === 'error'} dimColor={d.status.tone === 'busy'}>
            {d.status.label}
          </Text>
          {d.labels.length > 0 ? <Text dimColor>{d.labels.join(' · ')}</Text> : null}
          {d.content !== null ? <Text>{d.content}</Text> : null}
          {d.source.map((line) => (
            <Text key={`source-${line}`} dimColor>
              {line}
            </Text>
          ))}
          {d.evidence.length > 0 ? <Text bold>Evidence</Text> : null}
          {d.evidence.map((line) => (
            <Text key={`evidence-${line}`}>{line}</Text>
          ))}
          {d.window.map((line) => (
            <Text key={`window-${line}`} dimColor>
              {line}
            </Text>
          ))}
          {d.history.length > 0 ? <Text bold>History</Text> : null}
          {d.history.map((line) => (
            <Text key={`history-${line}`} dimColor>
              {line}
            </Text>
          ))}
          {d.notes.map((line) => (
            <Text key={`note-${line}`} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )
    }

    const view = panelView(s)
    return (
      <Box flexDirection="column">
        {view.header.map((line, i) => (
          <Text key={`header-${line}`} bold={i === 0}>
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
            onPress={() => void refresh($, options)}
          />
          {view.canCancel ? (
            <Button
              key="cancel"
              label="Cancel"
              hotkey="c"
              onPress={() => void cancel($, options)}
            />
          ) : null}
        </Box>
        {view.empty !== null ? <Text dimColor>{view.empty}</Text> : null}
        {view.sections.map((section) => (
          <Box key={`section-${section.title}`} flexDirection="column" marginTop={1}>
            <Text bold>{section.title}</Text>
            {section.rows.map((row) => (
              <Box key={`row-${row.memoryId}`} flexDirection="column">
                <Button
                  key={`open-${row.memoryId}`}
                  label={clip(row.title, MAX_LABEL)}
                  plain
                  onPress={() => void openDetail($, options, row.memoryId)}
                />
                <Text dimColor>{row.labels.join(' · ')}</Text>
              </Box>
            ))}
          </Box>
        ))}
        {view.notes.map((note) => (
          <Text key={`note-${note}`} dimColor>
            {note}
          </Text>
        ))}
      </Box>
    )
  })
}
