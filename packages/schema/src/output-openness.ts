// SPDX-License-Identifier: Apache-2.0
// ADVERTISE OPEN, PARSE STRICT — the output-schema openness marker (issue #154).
//
// Every MCP tool OUTPUT object is `.strict()`, and Zod 4 turns that into
// `additionalProperties: false` in the JSON Schema `tools/list` advertises. A
// client caches that catalog for up to an hour, so ANY release that adds a
// response field hard-fails every validating client for the whole TTL window —
// and nothing prompts a refetch, because the failure is CLIENT-SIDE output
// validation, not a -32601/-32602 the client reads as a stale catalog. That is
// the v1.4.1 `get_facts` incident: a session holding the v1.3.0 catalog died on
// "data/facts/0 must NOT have additional properties" — a NESTED item object.
//
// The fix is an ASYMMETRY, not a loosening:
//   - ADVERTISED (JSON Schema): open. This meta overrides the emitted keyword —
//     through Zod's `~standard.jsonSchema` (the SDK's tools/list path) AND
//     `z.toJSONSchema()` (the docs/OpenAPI generators) alike — so a
//     forward-compatible client tolerates a field it was not compiled against.
//   - PARSED (runtime): unchanged. `.meta()` touches metadata only; the object
//     stays `.strict()`, so the server still REJECTS an unknown key it produced
//     itself. Same discipline as the `recordedAt` note in mcp.ts: OUTPUT-ONLY
//     widening — additive, `.strict()`-safe.
//
// `.loose()`/`.passthrough()` would be the wrong tool: they move the RUNTIME
// contract, and the search envelope's projection-homogeneity refinement
// (search-cursor.ts) depends on its hit members staying strict.
//
// INPUTS ARE NEVER MARKED. An unknown arg key must stay a loud rejection — a
// silently dropped `scope` filter reads as a scope leak. Where one object is
// reachable from BOTH an input and an output tree (the briefing/handoff
// selector union), the output side gets its OWN marked derivation and the input
// path stays byte-identical. The registry invariant test in
// apps/server/test/mcp-tools.test.ts asserts both halves, at every depth.

/**
 * Marks an OUTPUT schema node as open in the ADVERTISED JSON Schema, leaving its
 * runtime parsing untouched: `z.object({...}).strict().meta(OPEN_OUTPUT_META)`.
 * `.meta()` returns a CLONE, so marking a node never mutates the schema it was
 * derived from — which is what makes an output-side derivation of a shared node
 * safe.
 *
 * Apply it to EVERY object node an output tree can reach: root envelopes, array
 * item objects, union and discriminated-union members, and section wrappers.
 * The incident failed on a nested item, not a root.
 *
 * REAPPLY AFTER COMPOSITION: `.extend()`, `.safeExtend()`, and `.omit()` each
 * produce a fresh schema that does NOT inherit the base's metadata, so every
 * composed successor is marked at its own level.
 */
export const OPEN_OUTPUT_META = { additionalProperties: true } as const
