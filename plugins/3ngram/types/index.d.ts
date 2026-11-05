// SPDX-License-Identifier: Apache-2.0

// The 3ngram plugin's $.state contract: the panel's state, and whether the
// pane was opened unasked this session.
//
// A contract is self-contained (no imports), so it names the value's shape
// only as far as other plugins may rely on it: a generation counter and a
// status. Its full type is PanelState in hooks/lib/state.ts, and the reducer
// there is its only writer.
export type ThreengramPanelState = {
  gen: number
  status: 'idle' | 'loading' | 'checking' | 'refreshing' | 'verifying' | 'ready' | 'stale' | 'error'
  [field: string]: unknown
}

declare module 'claude-code' {
  interface PluginState {
    // autoOpened: whether the auto_open option has opened the pane this
    // session, so a reload does not open it again.
    '3ngram': { panel: ThreengramPanelState; autoOpened: boolean }
  }
}
