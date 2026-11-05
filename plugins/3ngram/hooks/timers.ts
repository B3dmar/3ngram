// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface, PluginOptions } from 'claude-code'
import { nextUtcMidnight } from './lib/view.ts'
import { refresh, startup } from './reads.ts'
import { fire, runtime, stopReads } from './runtime.ts'

// The timers the panel keeps: the background reads (the startup kick and the
// refresh interval) and the midnight redraw. Their handles are module state
// (runtime.ts), so a hot reload drops them with the timers the engine ends.

const MIN_REFRESH_MS = 60_000

// armRefresh starts the background reads: the startup read now, then one per
// interval. It runs once a session can draw the pane, never twice.
export function armRefresh($: EngineInterface, options: PluginOptions): void {
  if (runtime.tick !== null) return
  runtime.kick = $.clock.after(0, () => fire($, startup($, options)))
  runtime.tick = $.clock.every(refreshMs(options), () => fire($, refresh($, options)))
}

// disarmRefresh stops the background reads, anything they started, and the
// midnight redraw.
export function disarmRefresh(): void {
  runtime.tick?.cancel()
  runtime.kick?.cancel()
  runtime.midnight?.timer.cancel()
  runtime.tick = null
  runtime.kick = null
  runtime.midnight = null
  stopReads()
}

// redrawAtMidnight keeps one redraw armed for the next UTC midnight after a
// draw. A time is shown without its date only on the UTC day it is drawn,
// and nothing else redraws a pane before its next refresh. A redraw already
// armed for that midnight, or an earlier one, is kept: it redraws every
// instance, and their next draws arm the following one.
export function redrawAtMidnight($: EngineInterface, now: number): void {
  const at = nextUtcMidnight(now)
  if (runtime.midnight !== null && runtime.midnight.at <= at) return
  runtime.midnight?.timer.cancel()
  const timer = $.clock.after(at - now, () => {
    runtime.midnight = null
    $.ui.invalidate('ui.render')
  })
  runtime.midnight = { at, timer }
}

function refreshMs(options: PluginOptions): number {
  const minutes = typeof options.refresh_minutes === 'number' ? options.refresh_minutes : 5
  return Math.max(MIN_REFRESH_MS, minutes * 60_000)
}
