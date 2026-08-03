// SPDX-License-Identifier: Apache-2.0
// MCP tool registry — the THIN adapter layer (AGENTS.md hard rule 5: transports
// hold zero business logic). Each tool validates at the ONE boundary
// (packages/schema Zod), calls the COMPLETE core service, and shapes the
// structured result. Tenant scoping is the authenticated `userId` threaded into
// every core call (which runs withTenant internally) — a tool can only ever
// touch the caller's own rows (hard rule 3).
//
// TOOL-COUNT DISCIPLINE (docs/concepts/mcp-design.mdx, hard rule 8: <=12): the single {@link
// TOOLS} array is the auditable surface — its length IS the registered tool
// count. D0 ships exactly THREE (remember/search/get_facts); the other seven
// JTBD tools land in later slices.
//
// Observability (hard rule 6): no memory content, query text, subject/value, or
// credential enters a log. A tool error returns a typed isError result to the
// client; the message names the failure class, never the content.
import { log, mcpToolCalls, mcpToolErrors } from '@3ngram/config'
import {
  type AccessGate,
  type BudgetEnforcement,
  getFacts,
  type LimitsResolver,
  remember,
  resolveByMemoryId,
  revise,
} from '@3ngram/core'
import { MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, type MemoryScope } from '@3ngram/core/auth'
import type { Gateway } from '@3ngram/llm'
import {
  type AsOfInput,
  factsQueryInputSchema,
  factsToolOutputSchema,
  MAX_CONTENT_LENGTH,
  rememberToolInputSchema,
  rememberToolOutputSchema,
  resolveToolInputSchema,
  resolveToolOutputSchema,
  reviseToolInputSchema,
  reviseToolOutputSchema,
} from '@3ngram/schema'
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { ZodType } from 'zod'
import { parseOutput } from '../output-validation.js'
import { mapToolError } from './errors.js'
// Admin tools: configure_scope / describe_environment /
// review_proposals — defined in their own module (500-line discipline), appended
// to the registry below via the factory (append-only edit to TOOLS).
import { createAdminTools } from './tools-admin.js'
// --- orientation tools: briefing + handoff — appended ---
import { ORIENT_TOOLS } from './tools-orient.js'
// --- search tool: fused retrieval — spliced in at its original position ---
import { SEARCH_TOOLS } from './tools-search.js'

/** The SDK result a tool returns: a text content mirror plus structured output. */
type ToolResult = CallToolResult

/**
 * A registered tool. SDK v2 accepts full Standard Schema objects, so every
 * input/output uses the canonical Zod schema directly. Strict objects and
 * discriminated unions therefore retain their exact boundary semantics instead
 * of being widened to permissive raw shapes.
 */
/**
 * The registry-level scope floor a token must satisfy to reach a tool's handler
 * (per-tool scope mapping). Either:
 * - a SINGLE {@link MemoryScope}: the token MUST carry exactly that scope
 *   (single-action tools — reads → {@link MEMORY_READ_SCOPE}, writes →
 *   {@link MEMORY_WRITE_SCOPE});
 * - `{ anyOf: MemoryScope[] }`: the token must carry AT LEAST ONE of the listed
 *   scopes (per-action tools whose actions span read AND write — the handler
 *   then asserts the action-specific scope). Read is NOT a superset of write, so
 *   a write-only token must be admitted by the floor before its handler can gate
 *   a mutation. {@link runTool} enforces this BEFORE the handler runs, fail-closed
 *   (an empty token-scope set satisfies no floor).
 */
export type RequiredScope = MemoryScope | { anyOf: readonly MemoryScope[] }

export interface ToolDefinition {
  name: string
  /** The scope floor {@link runTool} enforces before the handler runs. */
  requiredScope: RequiredScope
  config: {
    title: string
    description: string
    inputSchema: ZodType
    outputSchema: ZodType
  }
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>
}

/** Per-request context the transport injects: the authenticated tenant, its granted scopes, + optional gateway. */
export interface ToolContext {
  userId: string
  /**
   * The OAuth scopes the verified Bearer token granted (parsed from its `scope`
   * claim by oauthBearerAuth). FAIL-CLOSED: an empty array (claim absent) grants
   * nothing, so the per-tool scope check rejects every write — and any read whose
   * scope is not present.
   */
  scopes: readonly string[]
  /** Embedding gateway, or undefined when not configured (env-gated at boot). */
  gateway: Gateway | undefined
  /** Budget enforcement — gates metered tools (remember/revise/
   * search). Undefined → no budget gate (test/back-compat). */
  budget?: BudgetEnforcement | undefined
  /** Access gate — asserts read/write access on every tool. Undefined → no access
   * guard (test/back-compat). */
  access?: AccessGate | undefined
  /** Billing-neutral resource-limit resolver. Omitted fields are unlimited. */
  limits?: LimitsResolver | undefined
}

/** Wrap a structured payload as a tool success result (text mirror + structured). */
function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  }
}

/** Drop keys whose value is undefined so an exactOptional core param type fits. */
function defined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

/** Wrap a typed failure as an isError result. The message names the class only. */
function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
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
 * remember — append a memory (docs/concepts/mcp-design.mdx JTBD "persist something worth
 * keeping"). Validates via the canonical write schema, calls core remember()
 * (which validates once more at its own boundary and embeds-on-write via the
 * injected gateway), returns the created memory + whether the embed landed.
 * Registers the FULL `.strict()` object (not its raw `.shape`) so the SDK parses
 * inbound args strictly at the transport boundary: a supplied `scope`/`project`
 * survives to the handler instead of being silently stripped, and an unknown key
 * is REJECTED (mirroring the search fix).
 */
const rememberTool: ToolDefinition = {
  name: 'remember',
  requiredScope: MEMORY_WRITE_SCOPE,
  config: {
    title: 'Remember',
    description: `Append a new memory (decision, fact, preference, blocker, commitment, ...). Never merges; append-only. Content is capped at ${MAX_CONTENT_LENGTH} characters. To surface a commitment or blocker in a PROJECT-scoped briefing, pass \`project\` — a memory written with a NULL project never matches a project filter (issue #244).`,
    inputSchema: rememberToolInputSchema,
    outputSchema: rememberToolOutputSchema,
  },
  async handler(args, ctx) {
    // core remember() is THE validation boundary; pass the args straight through.
    // It returns the new id only, so the structured output echoes the NORMALIZED
    // write input (scope default + null project applied here) for the rest.
    // Embedding is on iff a gateway is configured — best-effort, never blocks.
    const input = rememberToolInputSchema.parse(args)
    const gatewayOpts =
      ctx.gateway === undefined
        ? { access: ctx.access, limits: ctx.limits }
        : { gateway: ctx.gateway, budget: ctx.budget, access: ctx.access, limits: ctx.limits }
    const written = await remember(ctx.userId, input, 'user_mcp', gatewayOpts)
    // ACK-BEFORE-EMBED: the write is already durable here. We DO NOT await the
    // background embed — a gateway round-trip is up to 30s and blocking the MCP
    // response on it would re-couple the turn to the gateway and defeat core's
    // ack-before-embed. The settle handle is left unawaited but defended so a
    // background rejection can never surface as an unhandled rejection (core
    // already .catch-resolves it to false; this is belt-and-braces).
    void written.embed.settled.catch(() => false)
    // The tool can only ever report the embed as not-yet-resolved: `pending`
    // when a gateway is configured (background embed in flight), `off` when none.
    const embedded = ctx.gateway === undefined ? 'off' : 'pending'
    // A commitment-type memory auto-creates an 'open' commitment in the same
    // write tx; surface its id so the caller can `resolve`
    // it without a follow-up lookup. Undefined (omitted) for every other type.
    const output = parseOutput(
      'remember',
      rememberToolOutputSchema,
      defined({
        memory: {
          id: written.id,
          memoryType: input.memoryType,
          topic: input.topic,
          scope: input.scope,
          project: input.project ?? null,
        },
        embedded,
        commitmentId: written.commitmentId,
      }),
    )
    return ok(output)
  },
}

/**
 * get_facts — currently-valid facts for a subject, bi-temporally (docs/concepts/mcp-design.mdx
 * JTBD "what is currently true about X"). Calls core getFacts() with the
 * subject/predicate filters and the as_of coordinates (ISO strings coerced to
 * Date at this boundary).
 */
const getFactsTool: ToolDefinition = {
  name: 'get_facts',
  requiredScope: MEMORY_READ_SCOPE,
  config: {
    title: 'Get Facts',
    description:
      'Currently-valid facts for a subject, with optional bi-temporal time travel. List mode (no subject) returns the most recent facts, bounded by an optional limit (default 50, max 200).',
    inputSchema: factsQueryInputSchema,
    outputSchema: factsToolOutputSchema,
  },
  async handler(args, ctx) {
    const input = factsQueryInputSchema.parse(args)
    // ACCESS GUARD: get_facts is a READ, so read access is asserted BEFORE the db
    // op (self-host allowAllAccess allows all; back-compat when no gate is wired).
    // Mirrors search (which asserts this inside core) and the REST /api/v1/facts
    // guard.
    if (ctx.access) await ctx.access.assertRead(ctx.userId)
    const facts = await getFacts(
      ctx.userId,
      defined({
        subject: input.subject,
        predicate: input.predicate,
        asOf: toAsOf(input.asOf),
        // Always forward the bounded limit (schema default 50, max 200) so list
        // mode never returns every fact (no-firehose, docs/concepts/mcp-design.mdx).
        limit: input.limit,
      }),
    )
    const output = parseOutput('get_facts', factsToolOutputSchema, {
      facts: facts.map((fact) => ({
        id: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        value: fact.value,
        confidence: fact.confidence,
        validFrom: fact.validFrom.toISOString(),
        validTo: fact.validTo?.toISOString() ?? null,
      })),
      count: facts.length,
    })
    return ok(output)
  },
}

/**
 * revise — supersede a memory with a corrected successor (docs/concepts/mcp-design.mdx JTBD
 * "correct or update what I know"). Wraps core revise(): closes the
 * predecessor's validity and appends a typed-edge-linked successor in one
 * transaction. The edge intent is constrained to the supersession family
 * ('supersedes' | 'updates') by reviseToolInputSchema — NOT widened to the
 * additive 'extends'/'derives' edges. Embedding is non-blocking, same
 * ack-before-embed as remember (pending with a gateway, off without).
 *
 * COMMITMENT CARRY (revise -> commitment): the
 * obligation follows the live memory. Revising a commitment-type memory MOVES its
 * commitments FSM row to the successor; revising INTO a commitment AUTO-CREATES
 * one (mirrors remember). Either way the live successor is immediately
 * `resolve`-able. Only DEMOTING a commitment to a non-commitment type leaves the
 * row on the superseded predecessor (preserved, not destroyed) pending a product
 * decision. Full matrix in core revise() / packages/db carryCommitment.
 */
const reviseTool: ToolDefinition = {
  name: 'revise',
  requiredScope: MEMORY_WRITE_SCOPE,
  config: {
    title: 'Revise',
    description:
      'Supersede an existing memory with a corrected successor, linked by a typed edge (supersedes or updates). Never edits in place; append-and-supersede.',
    // FULL `.strict()` object (not `.shape`): the SDK parses strictly at the
    // boundary so a supplied `scope`/`project` reaches the handler and an unknown
    // key is rejected, never silently stripped.
    inputSchema: reviseToolInputSchema,
    outputSchema: reviseToolOutputSchema,
  },
  async handler(args, ctx) {
    // core revise() is THE validation boundary; pass args straight through. It
    // returns the successor id only, so the output echoes the NORMALIZED revise
    // input (scope default + null project applied here) for the rest. Embedding
    // is best-effort and never blocks (same ack-before-embed as remember).
    const input = reviseToolInputSchema.parse(args)
    const gatewayOpts =
      ctx.gateway === undefined
        ? { access: ctx.access, limits: ctx.limits }
        : { gateway: ctx.gateway, budget: ctx.budget, access: ctx.access, limits: ctx.limits }
    const written = await revise(ctx.userId, input, 'user_mcp', gatewayOpts)
    void written.embed.settled.catch(() => false)
    const embedded = ctx.gateway === undefined ? 'off' : 'pending'
    const output = parseOutput('revise', reviseToolOutputSchema, {
      memory: {
        id: written.id,
        memoryType: input.memoryType,
        topic: input.topic,
        scope: input.scope,
        project: input.project ?? null,
      },
      embedded,
    })
    return ok(output)
  },
}

/**
 * resolve — settle the obligation a memory carries (docs/concepts/mcp-design.mdx JTBD "resolve /
 * unresolve (flag)"). Wraps core resolveByMemoryId(): keys on the MEMORY id the
 * agent already holds and dispatches on what the memory IS. A COMMITMENT memory
 * maps to its commitment via the unique (user_id, memory_id) index and takes an
 * FSM-validated transition (the single `status` enum serves resolve AND unresolve
 * — resolved -> open is legal per COMMITMENT_TRANSITIONS; an illegal pair is a
 * typed invalid_transition result naming from/to only). A BLOCKER memory
 * (blockers are MEMORY-ONLY, no FSM) is ARCHIVED instead — status
 * active -> archived — dropping it from the briefing's active blockers; the
 * passed `status` is ignored for a blocker and the result reports 'archived'.
 */
const resolveTool: ToolDefinition = {
  name: 'resolve',
  requiredScope: MEMORY_WRITE_SCOPE,
  config: {
    title: 'Resolve',
    description:
      'Settle a memory by its id. A commitment transitions to a target status (open, waiting, resolved, expired) — serves resolve and unresolve (resolved -> open); illegal transitions are rejected. A blocker is archived (status active -> archived) and leaves the active-blocker briefing; the passed status is ignored for blockers and the result reports archived. Commitments AND blockers must be written WITH a project to be resolvable from a project-scoped briefing.',
    inputSchema: resolveToolInputSchema,
    outputSchema: resolveToolOutputSchema,
  },
  async handler(args, ctx) {
    const input = resolveToolInputSchema.parse(args)
    // ACCESS GUARD: resolve mutates a commitment/blocker, so write access is
    // asserted BEFORE the db op (self-host allowAllAccess allows all; back-compat
    // when no gate is wired). remember/revise assert this inside core; resolve's
    // core fn takes no access gate, so the transport asserts it here.
    if (ctx.access) await ctx.access.assertWrite(ctx.userId)
    const result = await resolveByMemoryId(ctx.userId, input.memoryId, input.status, 'user_mcp')
    const output = parseOutput('resolve', resolveToolOutputSchema, {
      commitmentId: result.id,
      status: result.status,
    })
    return ok(output)
  },
}

/**
 * THE registered tool surface. Length === registered count; the <=12 cap (hard
 * rule 8) is auditable from this one array. D0: 3; D1 adds revise + resolve -> 5;
 * D3 appends configure_scope + describe_environment + review_proposals -> 8 (the
 * sibling track's orient tools bring the union to the 10-tool v1 surface).
 *
 * The admin tools are created via a FACTORY given a thunk over {@link TOOLS}, so
 * describe_environment can report the FULL surface (itself included) without a
 * circular import: the thunk closes over TOOLS and is only invoked at REQUEST
 * time, long after this assignment completes.
 */
export const TOOLS: readonly ToolDefinition[] = [
  rememberTool,
  // search — defined in tools-search.ts (500-line discipline) and spliced in at
  // its original position so the advertised tool order is unchanged.
  ...SEARCH_TOOLS,
  getFactsTool,
  reviseTool,
  resolveTool,
  // D2 orientation tools (briefing, handoff) — appended from tools-orient.ts so
  // this registry stays the single auditable surface while the file stays thin.
  ...ORIENT_TOOLS,
  // D3 admin tools (configure_scope, describe_environment, review_proposals) —
  // appended via the factory thunk so describe_environment can report the FULL
  // surface (itself included) without a circular import.
  ...createAdminTools(() => TOOLS.map((t) => t.name)),
]

/** Hard ceiling per docs/concepts/mcp-design.mdx / hard rule 8. */
export const MAX_TOOLS = 12

/**
 * Run a tool handler with uniform metrics + typed-error mapping. A KNOWN typed
 * core error (bad input, missing embedding source) becomes an isError result
 * with a class-named message; an UNKNOWN error is logged (crash-safe, no
 * content) and surfaced as a generic failure. The handler itself never logs
 * content (hard rule 6).
 */
export async function runTool(
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  mcpToolCalls.add(1, { tool_name: tool.name })
  // SCOPE GATE (fail-closed): the token MUST satisfy the tool's
  // scope floor. A single scope demands an exact match; an `anyOf` floor passes
  // when the token carries ANY listed scope (per-action tools — the handler then
  // gates the action-specific scope). ctx.scopes is empty when the token had no
  // `scope` claim, so a scopeless token satisfies NO floor and reaches no tool.
  // The transport stays a thin RFC 6750 insufficient_scope analogue: a typed
  // isError naming the missing scope(s), never a 500 and never content. Counted
  // distinctly from invalid_input.
  const floor = tool.requiredScope
  const required = typeof floor === 'string' ? [floor] : floor.anyOf
  if (!required.some((scope) => ctx.scopes.includes(scope))) {
    mcpToolErrors.add(1, { tool_name: tool.name, reason_code: 'insufficient_scope' })
    log().warn(
      { tool_name: tool.name, required_scope: required.join(' | ') },
      'mcp: tool call rejected for insufficient scope',
    )
    return fail(`insufficient scope: ${required.join(' or ')} required`)
  }
  try {
    return await tool.handler(args, ctx)
  } catch (err) {
    // KNOWN typed core errors map to a class-named isError result (with the right
    // reason_code + log level, no content) via the extracted ladder. An UNKNOWN
    // error falls through to the generic internal-fault path below.
    const mapped = mapToolError(tool.name, err)
    if (mapped !== undefined) return mapped
    mcpToolErrors.add(1, { tool_name: tool.name, reason_code: 'internal_error' })
    log().error(
      { tool_name: tool.name, err: err instanceof Error ? err.name : 'unknown' },
      'mcp: tool handler failed',
    )
    return fail('internal error')
  }
}
