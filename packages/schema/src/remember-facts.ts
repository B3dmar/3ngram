// SPDX-License-Identifier: Apache-2.0
// The `remember` V2 transport contract: the shipped tool surface EXTENDED with
// the structured facts a memory asserts.
//
// This lives beside mcp.ts rather than inside it for the same reason
// search-cursor.ts and retrieval-scope.ts do: mcp.ts is already well past the
// 500-line file budget (AGENTS.md hard rule 5), and a composed successor is
// exactly the seam where a new module costs nothing. The V1 schemas it builds
// on stay untouched and byte-identical (ADR-0011).
import { z } from 'zod'
import { rememberToolOutputSchema } from './mcp.js'
import { OPEN_OUTPUT_META } from './output-openness.js'
import { nativeRememberInputSchema } from './write.js'

/**
 * `remember` V2 input: a thin MCP-facing alias of the canonical NATIVE write
 * contract ({@link nativeRememberInputSchema}: facts + optional sessionRunId),
 * so the tool, REST, and SDK validate the same shape. Import still uses the
 * facts-less {@link rememberInputSchema} and rejects sessionRunId.
 *
 * Composed beside the V1 alias, never over it: `revise` shares the V1 base and
 * must keep rejecting a `facts` key.
 */
export const rememberToolInputV2Schema = nativeRememberInputSchema
export type RememberToolInputV2 = z.infer<typeof rememberToolInputV2Schema>
/**
 * Caller-side (pre-parse) shape: the `z.input` side where server-defaulted
 * fields (`scope`, `tags`) are OPTIONAL and the validity instants may still be
 * ISO-8601 strings. Use this for request bodies a client sends.
 */
export type RememberToolArgsV2 = z.input<typeof rememberToolInputV2Schema>

/**
 * `remember` V2 output: the shipped result plus the ids of the facts written
 * with the memory.
 *
 * `factIds` is OPTIONAL and present only when facts were actually written, so a
 * write without facts returns a byte-identical V1 response. Ids only — a fact's
 * subject/predicate/value is memory content and is not echoed back through the
 * transport (hard rule 6); the caller already holds what it sent.
 *
 * The openness marker is REAPPLIED here (issue #154): `.safeExtend()` builds a
 * fresh object that does not inherit the base's metadata, so the V2 envelope
 * would otherwise advertise itself closed while its nested `memory` stayed open.
 */
export const rememberToolOutputV2Schema = rememberToolOutputSchema
  .safeExtend({
    factIds: z.array(z.uuid()).optional(),
  })
  .meta(OPEN_OUTPUT_META)
export type RememberToolOutputV2 = z.infer<typeof rememberToolOutputV2Schema>
