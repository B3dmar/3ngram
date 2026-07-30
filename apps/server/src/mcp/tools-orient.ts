// SPDX-License-Identifier: Apache-2.0
// MCP ORIENTATION tools: `briefing` and
// `handoff`. A SEPARATE module from the core read/write tools (tools.ts) so the
// registry file stays thin (500-line cap) — tools.ts only IMPORTS
// this array and spreads it into TOOLS (append-only).
//
// Same THIN-ADAPTER contract as every tool: validate at the ONE boundary
// (packages/schema Zod), call the COMPLETE core service (which runs withTenant
// internally), shape the structured result. Both are reads -> requiredScope
// memory:read; runTool enforces the scope BEFORE the handler runs.
//
// SELECTOR DISCIPLINE (no-firehose, docs/concepts/mcp-design.mdx centerpiece): both tools REQUIRE
// an explicit selector. The schema makes it required; core re-checks the semantic
// invariant and throws MissingSelectorError, mapped to a typed isError by
// errors.ts. A briefing/handoff can NEVER be the unfiltered firehose the old
// system regretted.
//
// INJECTED TIME: `now` is read HERE (the transport composition root) and passed
// into core, so core/db stay deterministic (no wall-clock read in business
// logic). The overdue split and stale window derive from this instant.
//
// CONTENT IN OUTPUT vs LOGS: `handoff`'s OUTPUT carries memory
// content BY DESIGN (its purpose is transporting context) — this is a data export
// to the authenticated caller, NOT a log. Neither handler logs the payload; rule 6
// (no content in logs/traces/metrics) is upheld. `briefing` carries no content.
import { briefing, handoff } from '@3ngram/core'
import { MEMORY_READ_SCOPE } from '@3ngram/core/auth'
import {
  briefingToolInputSchema,
  briefingToolOutputSchema,
  handoffToolInputSchema,
  handoffToolOutputSchema,
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
 * briefing — structured session orientation (docs/concepts/mcp-design.mdx JTBD "start my session
 * oriented"). Validates the REQUIRED selector + optional mode, calls core
 * briefing() with the injected `now` (overdue split + stale window derive from
 * it), returns the size-disciplined sections. brief mode (default) = counts + a
 * small top slice per section; full = bounded lists. No section carries content.
 */
const briefingTool: ToolDefinition = {
  name: 'briefing',
  requiredScope: MEMORY_READ_SCOPE,
  config: {
    title: 'Briefing',
    description:
      'Structured session orientation: open/overdue commitments, blockers, stale candidates, recent decisions, preferences. Requires an explicit selector (scope, project, or all) — no unfiltered default. A PROJECT selector only matches commitments/blockers written WITH that project; a NULL-project memory never appears in a project briefing (issue #244). Active blockers leave this set when resolved (resolve archives the blocker memory). brief mode (default) returns counts plus top items; full returns the bounded lists.',
    inputSchema: briefingToolInputSchema,
    outputSchema: briefingToolOutputSchema,
  },
  async handler(args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const input = briefingToolInputSchema.parse(args)
    // ACCESS GUARD: the briefing is memory-derived, so read access is asserted
    // BEFORE the db op (self-host allowAllAccess allows all; back-compat when no
    // gate is wired).
    if (ctx.access) await ctx.access.assertRead(ctx.userId)
    // `now` is read at the transport edge (composition root), not in core/db.
    const result = await briefing(ctx.userId, {
      selector: input.selector,
      mode: input.mode,
      now: new Date(),
    })
    return ok(parseOutput('briefing', briefingToolOutputSchema, result))
  },
}

/**
 * handoff — export structured context for another agent/provider (docs/concepts/mcp-design.mdx
 * JTBD "carry context to another tool/agent"). Same REQUIRED-selector discipline
 * as briefing. Reuses the briefing aggregation in core (no duplicated SQL); the
 * OUTPUT carries memory CONTENT by design (decisions/preferences) because a
 * handoff transports context — bounded, and never logged (module header).
 */
const handoffTool: ToolDefinition = {
  name: 'handoff',
  requiredScope: MEMORY_READ_SCOPE,
  config: {
    title: 'Handoff',
    description:
      'Export structured context (decisions, open commitments, preferences — with content) for another agent or provider to pick up the thread. Requires an explicit selector (scope, project, or all); the payload is bounded.',
    inputSchema: handoffToolInputSchema,
    outputSchema: handoffToolOutputSchema,
  },
  async handler(args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const input = handoffToolInputSchema.parse(args)
    // ACCESS GUARD: handoff EXPORTS memory content, so read access is asserted
    // BEFORE the db op (self-host allowAllAccess allows all; back-compat when no
    // gate is wired).
    if (ctx.access) await ctx.access.assertRead(ctx.userId)
    // `generatedFor` is optional under exactOptionalPropertyTypes: only include
    // the key when present so it is `string`, never `string | undefined`.
    const result = await handoff(ctx.userId, {
      selector: input.selector,
      now: new Date(),
      ...(input.generatedFor !== undefined ? { generatedFor: input.generatedFor } : {}),
    })
    // Decision/preference lines carry core's bounded content EXCERPT —
    // long imported rows can exceed any write-time cap, so core bounds
    // them before this output parse ever sees the payload.
    return ok(parseOutput('handoff', handoffToolOutputSchema, result))
  },
}

/**
 * The orientation tools, appended to the {@link TOOLS} registry by tools.ts. A
 * readonly array so the registry stays the single auditable surface.
 */
export const ORIENT_TOOLS: readonly ToolDefinition[] = [briefingTool, handoffTool]
