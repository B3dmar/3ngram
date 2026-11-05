// SPDX-License-Identifier: Apache-2.0

// The 3ngram plugin's $.state contract: the panel, session activity and
// whether the pane was opened unasked this session.
//
// A contract is self-contained (no imports), so it names each value's shape
// only as far as other plugins may rely on it. The panel's: a generation
// counter and a status; its full type is PanelState in hooks/lib/state.ts,
// and the reducer there is its only writer. The activity's: when the first
// observed 3ngram tool call came and how many have been recorded; its full
// type is ActivityState in hooks/lib/activity.ts, whose fold() is its only
// writer. It is kept under a shape tag ({ shape, value }), so a reader checks
// the tag (`activity-2` for this shape) before it reads the value.
export type ThreengramPanelState = {
  gen: number
  status: 'idle' | 'loading' | 'checking' | 'refreshing' | 'verifying' | 'ready' | 'stale' | 'error'
  [field: string]: unknown
}

export type ThreengramActivityState = {
  startedAt: number | null
  seq: number
  [field: string]: unknown
}

declare module 'claude-code' {
  interface PluginState {
    '3ngram': {
      panel: ThreengramPanelState
      activity: { shape: string; value: ThreengramActivityState }
      // Persists across reloads, so auto_open opens only once per session.
      autoOpened: boolean
    }
  }
}
