// SPDX-License-Identifier: Apache-2.0
// The ONE spelling rule for `sessionRunId` (docs/concepts/session-continuity.mdx).
//
// WHY THIS IS A MODULE OF ITS OWN. Every contract that accepts a run id must
// canonicalize it identically — native remember/revise (write.ts), resolve
// (mcp.ts), archive (rest.ts), the provenance payload and the typed provenance
// read (agent-sessions.ts). agent-sessions.ts already imports write.ts for
// `projectSchema`, so hosting this in either of them would make the two import
// each other; a leaf module with no schema-package imports lets all four share
// one definition without a cycle.
//
// WHY LOWERCASE IS LOAD-BEARING. The id is compared two different ways:
//
//   - as `uuid` — `agent_sessions.id = $1` (ownership) and
//     `memory_events.id > $cursor` (keyset). Postgres parses both spellings to
//     the same value, so casing is invisible here.
//   - as `text` — `payload->>'sessionRunId' = $1` (session-events-read.ts) and
//     the matching expression index. Here casing is NOT invisible.
//
// Stamped payloads are always canonical: both attach paths in
// session-provenance.ts return the row id READ BACK from Postgres
// (`readSession`/`attachSingleOpen` select `agent_sessions.id`), never the
// caller's string, and pg renders a uuid column lowercase. So the corpus is
// uniform and only the QUERY side could disagree — an uppercase spelling would
// clear the uuid-typed ownership check and then match nothing in the text
// comparison, returning an empty page for a run that has events. Normalizing at
// the boundary (hard rule 2: one validation boundary) closes that without the
// reader having to lower() the indexed expression, which would deoptimize the
// index it was built for.
import { z } from 'zod'

/**
 * A `sessionRunId` in its canonical spelling.
 *
 * `.toLowerCase()` is Zod 4's type-preserving `overwrite` check, NOT a
 * `.transform()`: the schema stays a `ZodUUID` whose input and output are both
 * `string`, so `z.infer`/`z.input` are unchanged for every consumer (the SDK's
 * exported argument types included) and `z.toJSONSchema()` still renders it in
 * BOTH `io: 'input'` and `io: 'output'` mode. A `.transform()` would throw
 * "Transforms cannot be represented in JSON Schema" in output mode, which is
 * how the MCP reference generator and the tools/list surface are built.
 */
export const sessionRunIdSchema = z.uuid().toLowerCase()
export type SessionRunId = z.infer<typeof sessionRunIdSchema>
