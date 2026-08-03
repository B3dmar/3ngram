// SPDX-License-Identifier: Apache-2.0
// MCP INSPECT tool: `get_memories` — the batched full-content follow-up read
// for ids a search/handoff surfaced with `truncated: true`. A SEPARATE module
// from the core read/write tools (tools.ts) so the registry file stays thin
// (500-line cap, tools-orient.ts / tools-admin.ts precedent) — tools.ts only
// IMPORTS this array and spreads it into TOOLS (append-only).
//
// Same THIN-ADAPTER contract as every tool: validate at the ONE boundary
// (packages/schema Zod), call the COMPLETE core service (which runs withTenant
// internally), shape the structured result. A read -> requiredScope
// memory:read; runTool enforces the scope BEFORE the handler runs.
//
// OUTPUT DISCIPLINE (docs/concepts/mcp-design.mdx): content is bounded
// PER ITEM at the caller-requested `maxContentChars` (default 10,000, ceiling
// 65,536 — import rows reach 262,144 chars and must never ride back verbatim),
// the batch is bounded at MAX_GET_MEMORIES_IDS, and the AGGREGATE at
// MAX_GET_TOTAL_CHARS (ids × maxContentChars ≤ one worst-case import row). A missing or cross-tenant
// id lands in `notFound` — DATA, never an error: one bad id must not fail the
// batch, and the collapse of not-found/not-owned (RLS + caller-bound
// predicate, resolved in core/db) means the result never leaks whether a
// foreign id exists.
//
// CONTENT IN OUTPUT vs LOGS: the OUTPUT carries memory content BY DESIGN (a
// bounded data export to the authenticated caller, the tool's JTBD). The
// handler logs nothing; rule 6 (no content in logs/traces/metrics) is upheld.
import { getMemoriesByIds } from '@3ngram/core'
import { MEMORY_READ_SCOPE } from '@3ngram/core/auth'
import {
  DEFAULT_GET_CONTENT_CHARS,
  getMemoriesInputSchema,
  getMemoriesOutputSchema,
  MAX_GET_CONTENT_CHARS,
  MAX_GET_MEMORIES_IDS,
  MAX_GET_TOTAL_CHARS,
} from '@3ngram/schema'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { parseOutput } from '../output-validation.js'
import type { ToolContext, ToolDefinition } from './tools.js'

/** Wrap a structured payload as a tool success result (text mirror + structured). */
function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  }
}

/**
 * get_memories — batched full-content read (docs/concepts/mcp-design.mdx JTBD
 * "read what I found"). Validates the bounded id batch + content cap, calls
 * core getMemoriesByIds() (ONE withTenant, ONE `id = ANY` query — never a
 * per-id loop), and returns `{ memories, count, notFound }`. Dates are ISO
 * strings at this boundary; `commitmentStatus` is included only when the row
 * carries one (the output schema marks it optional, mirroring the REST
 * detail).
 */
const getMemoriesTool: ToolDefinition = {
  name: 'get_memories',
  requiredScope: MEMORY_READ_SCOPE,
  config: {
    title: 'Get Memories',
    description: `Fetch the full content of memories by id — use this after search or handoff returns an item with truncated: true to read the complete body. Accepts up to ${MAX_GET_MEMORIES_IDS} ids plus an optional maxContentChars per-item bound (default ${DEFAULT_GET_CONTENT_CHARS}, max ${MAX_GET_CONTENT_CHARS}; ids × maxContentChars may not exceed ${MAX_GET_TOTAL_CHARS} per call); an item still truncated at the cap reports truncated: true with its full contentLength. Ids that do not resolve for you are listed in notFound — never an error.`,
    inputSchema: getMemoriesInputSchema,
    outputSchema: getMemoriesOutputSchema,
  },
  async handler(args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const input = getMemoriesInputSchema.parse(args)
    // ACCESS GUARD: get_memories EXPORTS memory content, so read access is
    // asserted BEFORE the db op (self-host allowAllAccess allows all;
    // back-compat when no gate is wired). Mirrors handoff/get_facts.
    if (ctx.access) await ctx.access.assertRead(ctx.userId)
    const result = await getMemoriesByIds(ctx.userId, input.ids, {
      maxContentChars: input.maxContentChars,
    })
    const output = parseOutput('get_memories', getMemoriesOutputSchema, {
      memories: result.memories.map((memory) => ({
        id: memory.id,
        memoryType: memory.memoryType,
        topic: memory.topic,
        content: memory.content,
        contentLength: memory.contentLength,
        truncated: memory.truncated,
        scope: memory.scope,
        project: memory.project,
        status: memory.status,
        // Optional in the output schema: present only for a commitment-type
        // memory (REST detail parity); a null LEFT-JOIN miss is omitted.
        ...(memory.commitmentStatus != null ? { commitmentStatus: memory.commitmentStatus } : {}),
        tags: memory.tags,
        validFrom: memory.validFrom.toISOString(),
        validTo: memory.validTo?.toISOString() ?? null,
        recordedAt: memory.recordedAt.toISOString(),
      })),
      count: result.memories.length,
      notFound: result.notFound,
    })
    return ok(output)
  },
}

/**
 * The inspect tools, appended to the {@link TOOLS} registry by tools.ts. A
 * readonly array so the registry stays the single auditable surface.
 */
export const INSPECT_TOOLS: readonly ToolDefinition[] = [getMemoriesTool]
