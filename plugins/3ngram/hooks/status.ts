// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface } from 'claude-code'
import type { ActivityState } from './lib/activity.ts'
import { activityStatus } from './lib/session-view.ts'

// Last published counts only. Keeping composition synchronous preserves the
// commitment context gate: no async state read can outlive its decision.
let commitments = '3ngram: checking'
let session = ''
let sequence = 0

export function commitmentStatus($: EngineInterface, text: string): void {
  commitments = text
  publish($)
}

export function sessionStatus($: EngineInterface, state: ActivityState): void {
  if (state.seq < sequence) return
  sequence = state.seq
  session = activityStatus(state)
  publish($)
}

export function clearSessionStatus($: EngineInterface): void {
  sequence = 0
  session = ''
  publish($)
}

function publish($: EngineInterface): void {
  $.ui.status(session ? `${commitments} · ${session}` : commitments)
}
