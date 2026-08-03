// SPDX-License-Identifier: Apache-2.0
// MCP SEARCH tool: `search`. A SEPARATE module from the core read/write tools
// (tools.ts) so the registry file stays thin (500-line cap) — tools.ts only
// IMPORTS this array and spreads it into TOOLS (append-only), the same pattern
// as tools-orient.ts / tools-admin.ts.
//
// Same THIN-ADAPTER contract as every tool: validate at the ONE boundary
// (packages/schema Zod), call the COMPLETE core service (which runs withTenant
// internally), shape the structured result. A read -> requiredScope
// memory:read; runTool enforces the scope BEFORE the handler runs.
import { search } from '@3ngram/core'
import { MEMORY_READ_SCOPE } from '@3ngram/core/auth'
import { type AsOfInput, searchQueryV2Schema, searchToolOutputSchema } from '@3ngram/schema'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { parseOutput } from '../output-validation.js'
import type { ToolDefinition } from './tools.js'

/** Wrap a structured payload as a tool success result (text mirror + structured). */
function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  }
}

/** Wrap a typed failure as an isError result. The message names the class only. */
function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Drop keys whose value is undefined so an exactOptional core param type fits. */
function defined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

/** Coerce an optional ISO-8601 string to a Date for the bi-temporal core query. */
function toDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value)
}

function toAsOf(asOf: AsOfInput | undefined): { validAt?: Date; asKnownAt?: Date } | undefined {
  if (asOf === undefined) return undefined
  return defined({ validAt: toDate(asOf.validAt), asKnownAt: toDate(asOf.asKnownAt) })
}

/**
 * search — unified fused retrieval (docs/concepts/mcp-design.mdx JTBD "find what I know").
 * Requires a configured embedding gateway: core search() embeds the query and
 * THROWS without an embedding source, so absent a gateway the tool returns a
 * clear typed error rather than a 500. The input contract is query + limit plus
 * the OPTIONAL candidate-narrowing filters (memoryType/scope/project/status,
 * asOf, and the V2 axes memoryTypes[]/recordedAfter/recordedBefore) — validated
 * at the ONE boundary ({@link searchQueryV2Schema}, hard rule 2: the V2
 * composition over the shipped searchQuerySchema, which enforces the
 * memoryTypes-vs-memoryType mutual exclusion)
 * and threaded straight to core search()'s SearchOptions. Each filter NARROWS the
 * candidate set BEFORE fusion; none alters the fusion weights or the
 * supersession ranking (docs/concepts/memory-model.mdx live-first stays the default). The tool
 * registers the FULL `.strict()` object (not its raw shape), so the SDK parses
 * inbound args strictly at the transport boundary and an UNKNOWN key is REJECTED
 * there — a passed filter the tool exposes is applied, anything else is a clear
 * validation error, never silently dropped (registering `.shape`
 * would wrap it non-strict and strip unknown keys before the handler ran).
 */
const searchTool: ToolDefinition = {
  name: 'search',
  requiredScope: MEMORY_READ_SCOPE,
  config: {
    title: 'Search',
    description:
      'Unified semantic + keyword retrieval over your memories, supersession-aware. Accepts a query and an optional result limit, plus optional filters that narrow the candidate set BEFORE fusion (no change to ranking weights): memoryType OR memoryTypes (a list of types, mutually exclusive with memoryType), scope, project, status, asOf (bi-temporal time travel with validAt/asKnownAt), and recordedAfter/recordedBefore (an inclusive recorded-at range over the live view — not time travel). Omit a filter to leave that axis unconstrained. Hit content is a bounded excerpt — when a hit reports truncated: true, call get_memories with its id to read the full content.',
    inputSchema: searchQueryV2Schema,
    outputSchema: searchToolOutputSchema,
  },
  async handler(args, ctx) {
    if (ctx.gateway === undefined) {
      return fail('embedding gateway not configured')
    }
    const input = searchQueryV2Schema.parse(args)
    const hits = await search(
      ctx.userId,
      input.query,
      { gateway: ctx.gateway },
      {
        limit: input.limit,
        // Candidate-narrowing filters: validated at the schema
        // boundary, threaded verbatim to core. defined() strips undefined axes so
        // an absent filter never narrows (exactOptional fit for SearchFilters).
        // V2 axes ride the same object: memoryTypes passes through as-is (the
        // schema already enforced non-empty + mutual exclusion with memoryType);
        // the recorded_at range bounds coerce ISO -> Date here like asOf.
        filters: defined({
          memoryType: input.memoryType,
          memoryTypes: input.memoryTypes,
          scope: input.scope,
          project: input.project,
          status: input.status,
          asOf: toAsOf(input.asOf),
          recordedAfter: toDate(input.recordedAfter),
          recordedBefore: toDate(input.recordedBefore),
        }),
        budget: ctx.budget,
        access: ctx.access,
      },
    )
    // `content` is core's bounded excerpt (read-path policy in
    // packages/core/src/read/excerpt.ts); contentLength/truncated let the
    // caller fetch the full memory by id when the excerpt was cut.
    const output = parseOutput('search', searchToolOutputSchema, {
      hits: hits.map((hit) => ({
        id: hit.id,
        memoryType: hit.memoryType,
        topic: hit.topic,
        content: hit.content,
        contentLength: hit.contentLength,
        truncated: hit.truncated,
        score: hit.score,
      })),
      count: hits.length,
    })
    return ok(output)
  },
}

/**
 * The search tool, spliced into the {@link TOOLS} registry by tools.ts at its
 * original position (after remember). A readonly array so the registry stays
 * the single auditable surface.
 */
export const SEARCH_TOOLS: readonly ToolDefinition[] = [searchTool]
