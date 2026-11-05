// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface } from 'claude-code'
import { atom, update } from 'claude-code'
import type { ActivityState } from './lib/activity.ts'
import { fold, initialActivity } from './lib/activity.ts'
import type { ObservedCall } from './lib/observe.ts'
import { observe, threengramCall } from './lib/observe.ts'

// The session activity: what the agent read and changed through 3ngram MCP
// tools, recorded from the tool.call hook in register.tsx. The model is
// lib/activity.ts, the reading of one call lib/observe.ts.
//
// Kept in $.state under a shape tag, so code that changes the shape later
// reads a value this code stored as absent instead of misreading it. $.state
// is the session's: it survives a reload and starts over after /clear,
// /resume and /branch, as the panel's does.
export const activity = atom({ plugin: '3ngram', key: 'activity' } as const, initialActivity, {
  shape: 'activity-2',
})

let epoch = 0
const pending = new Set<Promise<void>>()
const timers = new Set<{ cancel: () => void }>()

// Taken before next(e), so a result from the previous conversation cannot
// be recorded in the new one even when the tool itself finishes late.
export const activityEpoch = (): number => epoch

export async function stopActivity(): Promise<void> {
  epoch++
  for (const timer of timers) timer.cancel()
  timers.clear()
  // Drain state writes before the host resets state. A fork has no end
  // event, so resetActivity also drains before clearing our own atom.
  await Promise.allSettled([...pending])
}

export async function resetActivity($: EngineInterface): Promise<void> {
  await stopActivity()
  await update($, activity, () => initialActivity)
}

type Call = Readonly<Record<string, unknown>>
type Ran = { readonly text?: unknown; readonly isError?: unknown; readonly deny?: unknown }

// watchCall takes one tool call after it ran and, for a 3ngram tool, records
// it from a timer: the hook hands the result back first, so neither the time
// the recording takes nor a failure in it reaches the call. It reads the call
// and its result and changes neither. It cannot throw: every step runs inside
// a promise logged() watches, so a failure costs that one entry, said in the
// debug log.
export function watchCall($: EngineInterface, e: Call, ran: Ran, generation: number): void {
  if (generation === epoch) logged($, schedule($, e, ran, generation))
}

function logged($: EngineInterface, work: Promise<void>): void {
  const handled = work.catch(() => {
    $.ui.log('3ngram: a tool call was left out of the session activity', { to: 'debug' })
  })
  pending.add(handled)
  void handled.then(
    () => pending.delete(handled),
    () => pending.delete(handled),
  )
}

async function schedule($: EngineInterface, e: Call, ran: Ran, generation: number): Promise<void> {
  const name = threengramCall(String(e.tool))
  if (name === null) return
  const call: Omit<ObservedCall, 'at'> = {
    ...name,
    args: e,
    text: typeof ran.text === 'string' ? ran.text : undefined,
    isError: ran.isError === true,
    isDenied: ran.deny !== undefined,
    agentId: typeof e.agentId === 'string' ? e.agentId : undefined,
  }
  const timer = $.clock.after(0, () => {
    timers.delete(timer)
    if (generation === epoch) logged($, record($, call, generation))
  })
  timers.add(timer)
}

async function record(
  $: EngineInterface,
  call: Omit<ObservedCall, 'at'>,
  generation: number,
): Promise<void> {
  const seen = observe({ ...call, at: await $.clock.now() })
  // This module is the atom's only writer and every write goes through
  // fold(), so the value read back is an ActivityState.
  if (generation !== epoch) return
  await update($, activity, (s) =>
    generation === epoch ? fold(s as unknown as ActivityState, seen) : s,
  )
}
