// SPDX-License-Identifier: Apache-2.0

// The 3ngram plugin's $.state contract: one value, the panel's state.
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
    '3ngram': { panel: ThreengramPanelState }
  }
}
