// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface, PluginOptions } from 'claude-code'
import type { Selection } from './lib/argv.ts'
import { listArgv, selectionKey, showArgv } from './lib/argv.ts'
import { parseEnvelope } from './lib/contract.ts'
import { needsVerification } from './lib/state.ts'
import {
  confirmSelection,
  dispatch,
  dispatchApplied,
  readPanel,
  releaseDetailRead,
  runtime,
  stopReads,
} from './runtime.ts'
import { PROCESS_CEILING_MS, probe, runHook } from './spawn.ts'

// The panel's reads: the list (refresh, one at a time), a commitment's detail
// (openDetail), and the context checks around both (verifyIfNeeded). Every
// await in them is a point where a cancel, a session transition or a reload
// can have taken the read away, so the check after each one stays next to it.
// The module state those checks read is declared in runtime.ts.

function selectionOf(options: PluginOptions, cwd: string): Selection {
  const scope = typeof options.scope === 'string' ? options.scope.trim() : ''
  return {
    cwd,
    scope,
    includeUnscoped: options.include_unscoped === true,
    github: options.github_evidence === true,
  }
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

export async function refresh($: EngineInterface, options: PluginOptions): Promise<void> {
  if (runtime.active !== null) {
    runtime.queued = true
    return
  }
  const token = ++runtime.tokens
  runtime.active = token
  const epoch = runtime.startEpoch
  try {
    await refreshOnce($, options, token, epoch)
  } catch {
    // A refresh that was already superseded reports nothing: the current
    // generation belongs to the read that replaced it. A reported failure
    // has cleared or verified what was held, so the pane shows it.
    if (runtime.active === token && (await reportUnexpected($, options)))
      await confirmSelection($, epoch)
  } finally {
    if (runtime.active === token) runtime.active = null
  }
  if (runtime.queued && runtime.active === null) {
    runtime.queued = false
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
  if (runtime.active !== token) return
  // With rows held, the context is checked before the read: rows read under
  // another key or backend are cleared now, not after the read returns.
  const held = (await readPanel($)).record !== null
  if (runtime.active !== token) return
  if (held) await dispatch($, { type: 'check_started' })
  if (runtime.active !== token) return
  const fingerprint = held ? await probe($, sel) : null
  if (runtime.active !== token) return
  const gen = (await readPanel($)).gen + 1
  if (runtime.active !== token) return
  await dispatch($, { type: 'refresh_started', gen, selectionKey: selectionKey(sel), fingerprint })
  // refresh_started clears whatever was held under another selection, or
  // under a context the probe did not confirm.
  await confirmSelection($, epoch)
  if (runtime.active !== token) return
  const outcome = await runHook($, listArgv(sel), PROCESS_CEILING_MS, (stop) => {
    if (runtime.active === token) runtime.listRead = { token, stop }
    else stop()
  })
  if (runtime.listRead?.token === token) runtime.listRead = null
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
      if (runtime.active !== token) return
      if (now !== parsed.envelope.context.fingerprint) {
        const rerun = now !== null && now !== runtime.requeuedFor
        // The message says a read follows only when one does.
        await dispatch($, {
          type: 'list_failed',
          gen,
          failure: rerun ? 'context_changed' : 'context_moved',
          at,
        })
        await dispatch($, { type: 'context_verified', gen, fingerprint: now, at })
        if (rerun) {
          runtime.requeuedFor = now
          runtime.queued = true
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
  runtime.requeuedFor = null
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

export async function cancel($: EngineInterface, options: PluginOptions): Promise<void> {
  stopReads()
  try {
    await dispatch($, { type: 'cancel' })
    await verifyIfNeeded($, options)
  } catch {
    await reportUnexpected($, options)
  }
}

export async function openDetail(
  $: EngineInterface,
  options: PluginOptions,
  memoryId: string,
): Promise<void> {
  const s = await dispatch($, { type: 'detail_requested', memoryId })
  const detail = s.detail
  if (!detail || detail.memoryId !== memoryId) return
  const seq = detail.seq
  const epoch = runtime.stops
  runtime.wantedDetail = seq
  try {
    // An earlier detail's child is stopped now; one that has not started yet
    // sees it is no longer wanted and never starts.
    runtime.detailRead?.stop()
    runtime.detailRead = null
    const sel = selectionOf(options, await $.session.cwd())
    const outcome = await runHook(
      $,
      showArgv(sel, memoryId, detail.fingerprint),
      PROCESS_CEILING_MS,
      (stop) => {
        if (runtime.stops === epoch && runtime.wantedDetail === seq) {
          runtime.detailRead?.stop()
          runtime.detailRead = { seq, stop }
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
      if (runtime.stops !== epoch || runtime.wantedDetail !== seq) {
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

export async function closeDetail($: EngineInterface): Promise<void> {
  // A detail read that has not started its child yet sees the epoch move and
  // never starts one.
  runtime.stops++
  runtime.detailRead?.stop()
  runtime.detailRead = null
  await dispatch($, { type: 'detail_closed' })
}

// startup is the first read after a session start or a reload. A reload
// that changed the options (a scope, the unscoped opt-in, GitHub lookups)
// leaves rows and a detail read under the old ones in the state the host
// kept, and one under the same options can keep rows read under another key.
// They never draw (selectionConfirmed is closed until they are confirmed)
// and they are cleared before any read, not when the next read lands.
export async function startup($: EngineInterface, options: PluginOptions): Promise<void> {
  const epoch = runtime.startEpoch
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
