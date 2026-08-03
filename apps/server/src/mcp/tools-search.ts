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
import { type SearchHit, searchDashboardPage } from '@3ngram/core'
import { MEMORY_READ_SCOPE } from '@3ngram/core/auth'
import {
  type AsOfInput,
  type SearchProjection,
  type SearchQueryV3Input,
  searchQueryV3Schema,
  searchToolOutputV2Schema,
} from '@3ngram/schema'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { decodeCursor, encodeCursor } from '../cursor.js'
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
 * Candidate-narrowing filters: validated at the schema boundary, threaded
 * verbatim to core. defined() strips undefined axes so an absent filter never
 * narrows (exactOptional fit for SearchFilters). V2 axes ride the same object:
 * memoryTypes passes through as-is (the schema already enforced non-empty +
 * mutual exclusion with memoryType); the recorded_at range bounds coerce
 * ISO -> Date here like asOf.
 */
function toFilters(input: SearchQueryV3Input) {
  return defined({
    memoryType: input.memoryType,
    memoryTypes: input.memoryTypes,
    scope: input.scope,
    project: input.project,
    status: input.status,
    asOf: toAsOf(input.asOf),
    recordedAfter: toDate(input.recordedAfter),
    recordedBefore: toDate(input.recordedBefore),
  })
}

/**
 * Shape one core hit for the wire. `full` (default) keeps the shipped excerpt
 * triple (`content` is core's bounded excerpt — read-path policy in
 * packages/core/src/read/excerpt.ts; contentLength/truncated let the caller
 * fetch the full memory by id when the excerpt was cut). `compact` omits the
 * triple (~5x fewer tokens per hit) for broad scans — the caller batch-fetches
 * the interesting ids with get_memories.
 */
function projectHit(hit: SearchHit, projection: SearchProjection): Record<string, unknown> {
  const compact = { id: hit.id, memoryType: hit.memoryType, topic: hit.topic, score: hit.score }
  if (projection === 'compact') return compact
  return {
    ...compact,
    content: hit.content,
    contentLength: hit.contentLength,
    truncated: hit.truncated,
  }
}

/**
 * search — unified fused retrieval (docs/concepts/mcp-design.mdx JTBD "find what I know").
 * Requires a configured embedding gateway: core embeds the query and THROWS
 * without an embedding source, so absent a gateway the tool returns a clear
 * typed error rather than a 500. The input contract is the V3 composition
 * ({@link searchQueryV3Schema}, hard rule 2): query + limit, the candidate-
 * narrowing filters (V1 memoryType/scope/project/status/asOf + V2
 * memoryTypes[]/recordedAfter/recordedBefore), and the continuation pair —
 * `cursor` (opaque frozen-ordering token) + `projection` (full/compact). Each
 * filter NARROWS the candidate set BEFORE fusion; none alters the fusion
 * weights or the supersession ranking (docs/concepts/memory-model.mdx
 * live-first stays the default). The tool registers the FULL `.strict()`
 * object (not its raw shape), so the SDK parses inbound args strictly at the
 * transport boundary and an UNKNOWN key is REJECTED there — never silently
 * dropped.
 *
 * PAGINATION routes through the SAME frozen-ordering machinery the dashboard
 * uses (core searchDashboardPage + the shared ../cursor.js codec): page 1 ranks
 * the bounded candidate pool once and freezes the ordering into `nextCursor`;
 * a continuation pages BY POSITION within it (fetchHitsByIds), immune to
 * duplicate/skip under mid-walk corpus drift. Page-1 ranking is identical to
 * the pre-cursor path (returnFullPool ranks the same pool), so the eval floors
 * are untouched. A garbled cursor throws a ZodError -> runTool's ladder labels
 * it invalid input (never a 500); a stale pre-v2 cursor decodes to undefined
 * and restarts at page 1.
 */
const searchTool: ToolDefinition = {
  name: 'search',
  requiredScope: MEMORY_READ_SCOPE,
  config: {
    title: 'Search',
    description:
      'Unified semantic + keyword retrieval over your memories, supersession-aware. Accepts a query and an optional result limit, plus optional filters that narrow the candidate set BEFORE fusion (no change to ranking weights): memoryType OR memoryTypes (a list of types, mutually exclusive with memoryType), scope, project, status, asOf (bi-temporal time travel with validAt/asKnownAt), and recordedAfter/recordedBefore (an inclusive recorded-at range over the live view — not time travel). Omit a filter to leave that axis unconstrained. Hit content is a bounded excerpt — when a hit reports truncated: true, call get_memories with its id to read the full content. To page: pass nextCursor back as cursor with the SAME query and filters; pages come from the ordering frozen on the first page, so a mid-walk write or archive can never duplicate or skip a hit. The cursor token is a real context cost (~4-6 KB — it carries the frozen ids+scores of the candidate pool), so page only when you actually need more hits. Paging stops at the frozen pool: hasMore: false means the pool is exhausted — refine the query (better filters, more specific terms) instead of paging harder. For broad scans set projection: "compact" to omit content/contentLength/truncated per hit (~5x fewer tokens), then batch-fetch the interesting ids with get_memories.',
    inputSchema: searchQueryV3Schema,
    outputSchema: searchToolOutputV2Schema,
  },
  async handler(args, ctx) {
    if (ctx.gateway === undefined) {
      return fail('embedding gateway not configured')
    }
    const input = searchQueryV3Schema.parse(args)
    // Frozen-ordering continuation: a malformed token throws here (client
    // input, mapped by runTool); a legacy token restarts at page 1.
    const decoded = input.cursor === undefined ? undefined : decodeCursor(input.cursor)
    const frozen =
      decoded === undefined
        ? undefined
        : { ids: decoded.ids, scores: decoded.scores, off: decoded.off }
    const page = await searchDashboardPage(
      ctx.userId,
      input.query,
      { gateway: ctx.gateway },
      defined({
        limit: input.limit,
        filters: toFilters(input),
        frozen,
        budget: ctx.budget,
        access: ctx.access,
      }),
    )
    // Emit a cursor ONLY when a further page exists (searchToolOutputV2Schema
    // ENFORCES nextCursor <-> hasMore, so a drifting pair can never ship).
    const nextCursor = page.hasMore
      ? encodeCursor({
          v: 2,
          ids: page.frozen.ids,
          scores: page.frozen.scores,
          off: page.nextOffset,
        })
      : undefined
    const output = parseOutput(
      'search',
      searchToolOutputV2Schema,
      defined({
        hits: page.hits.map((hit) => projectHit(hit, input.projection)),
        count: page.hits.length,
        hasMore: page.hasMore,
        nextCursor,
      }),
    )
    return ok(output)
  },
}

/**
 * The search tool, spliced into the {@link TOOLS} registry by tools.ts at its
 * original position (after remember). A readonly array so the registry stays
 * the single auditable surface.
 */
export const SEARCH_TOOLS: readonly ToolDefinition[] = [searchTool]
