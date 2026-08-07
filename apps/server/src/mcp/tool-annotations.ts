// SPDX-License-Identifier: Apache-2.0
// Shared tool annotation constants (issue #102).
//
// A LEAF MODULE ON PURPOSE. tools.ts imports the per-domain tool arrays
// (tools-search, tools-orient, tools-inspect, tools-admin), so any VALUE those
// modules import back from tools.ts closes a runtime import cycle — the
// sub-module evaluates while tools.ts is still initializing and reads the
// constant as `undefined`. Type-only imports are erased and are therefore safe,
// which is why the existing `import type { ToolDefinition }` lines are fine and
// this one could not live alongside them.
//
// tsc does NOT catch that: the types line up perfectly and the failure is
// runtime-only. The registry invariant test in mcp-tools.test.ts is what does.
import type { ToolAnnotations } from '@modelcontextprotocol/server'

/**
 * Annotations for a read-only tool: it never mutates, and repeating it yields
 * the same answer. `destructiveHint` is deliberately omitted — the spec only
 * gives it meaning when `readOnlyHint` is false.
 *
 * `openWorldHint: false` holds for EVERY 3ngram tool: each one operates on the
 * tenant's own corpus, not an open external world. The embedding gateway is an
 * implementation detail of a write, not an open-world interaction.
 */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
}
