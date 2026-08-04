// SPDX-License-Identifier: Apache-2.0
// MCP ADMIN tools: configure_scope, describe_environment,
// review_proposals — completing the 10-tool v1 surface. THIN
// adapters: each validates at the ONE schema boundary
// (packages/schema), calls the COMPLETE core service, shapes the structured
// result, and holds zero business logic.
//
// TWO-LAYER SCOPE MODEL (orchestrator decision). The registry-level
// requiredScope is the PRE-handler floor (runTool checks it before the handler
// runs). configure_scope and review_proposals span BOTH a read action (list) and
// write actions, so they declare an `anyOf: [memory:read, memory:write]` floor:
// runTool admits a token carrying EITHER scope. read is NOT a superset of write,
// so a single memory:read floor would wrongly lock a WRITE-ONLY token out of its
// mutations before the handler could run — anyOf fixes that while staying
// fail-closed (an empty token-scope set satisfies no floor). The HANDLER then
// asserts the action-specific scope from ctx.scopes: list needs memory:read,
// every MUTATING action (create/rename/set_aliases/delete; reject/accept) needs
// memory:write, returning the SAME insufficient_scope error shape runTool uses.
// The split is exercised at BOTH layers in the contract tests.
//
// REDACTION: describe_environment carries capabilities (tool
// NAMES + count + version), the scope registry, and bounded COUNTS only — never
// an env value, DSN, key, or base URL. The output schema has no field for one and
// no handler here reads process.env or a secret.
//
// REGISTRATION SCHEMAS: SDK v2 accepts Standard Schema objects directly, so the
// action-discriminated unions are registered without a permissive raw-shape
// bridge. The exact per-action contract is enforced at the transport boundary.
import { log, mcpToolErrors } from '@3ngram/config'
import {
  applyProposal,
  createScope,
  deleteScope,
  describeEnvironment,
  listProposals,
  listScopes,
  type ProposalRecord,
  rejectProposal,
  renameScope,
  type ScopeRecord,
  setRetrievalDefault,
  setScopeAliases,
} from '@3ngram/core'
import { MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, type MemoryScope } from '@3ngram/core/auth'
import {
  type ConfigureScopeInputV2,
  configureScopeInputV2Schema,
  configureScopeOutputV2Schema,
  describeEnvironmentInputSchema,
  describeEnvironmentOutputV2Schema,
  type ReviewProposalsInput,
  reviewProposalsInputSchema,
  reviewProposalsOutputSchema,
} from '@3ngram/schema'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { parseOutput } from '../output-validation.js'
import { SERVER_VERSION } from '../version.js'
import type { ToolContext, ToolDefinition } from './tools.js'

type ToolResult = CallToolResult

/** Wrap a structured payload as a tool success result (text mirror + structured). */
function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  }
}

/** Wrap a typed failure as an isError result. The message names the class only. */
function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * Per-action scope gate (layer 2 of the two-layer model). The registry `anyOf`
 * floor (layer 1, runTool) admits a token carrying EITHER read or write; the
 * action then needs its EXACT scope — list → memory:read, mutations →
 * memory:write. Returns an isError matching runTool's insufficient_scope shape
 * (and counts the same metric) when the token lacks the action scope; undefined
 * to proceed. Fail-closed: an empty ctx.scopes carries no scope.
 */
function requireScope(
  toolName: string,
  ctx: ToolContext,
  scope: MemoryScope,
): ToolResult | undefined {
  if (ctx.scopes.includes(scope)) return undefined
  mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'insufficient_scope' })
  log().warn(
    { tool_name: toolName, required_scope: scope },
    'mcp: action rejected for insufficient scope',
  )
  return fail(`insufficient scope: ${scope} required`)
}

/** Shape a core scope record for the structured output (Date -> ISO string). */
function toScopeOutput(s: ScopeRecord) {
  return { id: s.id, name: s.name, aliases: s.aliases, createdAt: s.createdAt.toISOString() }
}

/** Shape a core proposal record for the structured output (Dates -> ISO strings). */
function toProposalOutput(p: ProposalRecord) {
  return {
    id: p.id,
    fromId: p.fromId,
    toId: p.toId,
    edgeType: p.edgeType,
    memoryType: p.memoryType,
    similarity: p.similarity,
    rationale: p.rationale,
    status: p.status,
    decidedAt: p.decidedAt === null ? null : p.decidedAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
  }
}

/**
 * Dispatch a configure_scope ACTION to the right core call. The `anyOf` registry
 * floor admits read OR write; this handler gates the EXACT action scope (layer 2)
 * before any core call: list → memory:read, mutations → memory:write.
 */
async function runConfigureScope(
  input: ConfigureScopeInputV2,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (input.action === 'list') {
    const denied = requireScope('configure_scope', ctx, MEMORY_READ_SCOPE)
    if (denied !== undefined) return denied
    // ACCESS GUARD: listing the tenant scope registry is a READ of user data — read
    // access is asserted BEFORE the db op (self-host allowAllAccess allows all).
    if (ctx.access) await ctx.access.assertRead(ctx.userId)
    const scopes = await listScopes(ctx.userId)
    return ok(
      parseOutput('configure_scope', configureScopeOutputV2Schema, {
        action: 'list',
        scopes: scopes.map(toScopeOutput),
        count: scopes.length,
      }),
    )
  }
  const denied = requireScope('configure_scope', ctx, MEMORY_WRITE_SCOPE)
  if (denied !== undefined) return denied
  // ACCESS GUARD: every mutating scope action (create/rename/set_aliases/delete/
  // set_retrieval_default) is a WRITE — write access is asserted BEFORE the db op
  // (self-host allowAllAccess allows all).
  if (ctx.access) await ctx.access.assertWrite(ctx.userId)

  switch (input.action) {
    case 'create': {
      const scope = await createScope(ctx.userId, input.name, input.aliases)
      return upserted(scope)
    }
    case 'rename': {
      const scope = await renameScope(ctx.userId, input.name, input.newName)
      return upserted(scope)
    }
    case 'set_aliases': {
      const scope = await setScopeAliases(ctx.userId, input.name, input.aliases)
      return upserted(scope)
    }
    case 'delete': {
      await deleteScope(ctx.userId, input.name)
      return ok(
        parseOutput('configure_scope', configureScopeOutputV2Schema, {
          action: 'deleted',
          name: input.name,
        }),
      )
    }
    case 'set_retrieval_default': {
      // Shape consistency (mode↔scope pairing) was enforced by the schema
      // boundary; core asserts the SEMANTIC invariant (a default scope must be
      // REGISTERED -> typed ScopeNotFoundError, mapped by errors.ts) and
      // returns the stored setting, echoed as the policy record.
      const policy = await setRetrievalDefault(ctx.userId, {
        mode: input.mode,
        scope: input.scope,
      })
      return ok(
        parseOutput('configure_scope', configureScopeOutputV2Schema, {
          action: 'retrieval_default_set',
          policy,
        }),
      )
    }
    default:
      // Exhaustiveness guard: every mutating action is handled above. The strict
      // union makes this unreachable; it pins the compiler to flag a NEW action.
      return input satisfies never
  }
}

function upserted(scope: ScopeRecord): ToolResult {
  return ok(
    parseOutput('configure_scope', configureScopeOutputV2Schema, {
      action: 'upserted',
      scope: toScopeOutput(scope),
    }),
  )
}

/**
 * Dispatch a review_proposals ACTION. The `anyOf` registry floor admits read OR
 * write; this handler gates the EXACT action scope (layer 2): list →
 * memory:read, reject/accept → memory:write. accept calls core applyProposal,
 * which materializes the proposed edge and (for supersedes/updates) closes the
 * predecessor, returning the `applied` result variant.
 */
async function runReviewProposals(
  input: ReviewProposalsInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (input.action === 'list') {
    const denied = requireScope('review_proposals', ctx, MEMORY_READ_SCOPE)
    if (denied !== undefined) return denied
    // ACCESS GUARD: proposals are memory-derived, so listing them is a READ — read
    // access is asserted BEFORE the db op (self-host allowAllAccess allows all).
    if (ctx.access) await ctx.access.assertRead(ctx.userId)
    const proposals = await listProposals(ctx.userId, { status: input.status, limit: input.limit })
    return ok(
      parseOutput('review_proposals', reviewProposalsOutputSchema, {
        action: 'list',
        proposals: proposals.map(toProposalOutput),
        count: proposals.length,
      }),
    )
  }
  const denied = requireScope('review_proposals', ctx, MEMORY_WRITE_SCOPE)
  if (denied !== undefined) return denied
  // ACCESS GUARD: accept/reject materialize or close edges over the tenant's
  // memories — a WRITE. Write access is asserted BEFORE the db op (self-host
  // allowAllAccess allows all).
  if (ctx.access) await ctx.access.assertWrite(ctx.userId)

  if (input.action === 'accept') {
    const proposal = await applyProposal(ctx.userId, input.proposalId, 'user_mcp')
    return ok(
      parseOutput('review_proposals', reviewProposalsOutputSchema, {
        action: 'applied',
        proposal: toProposalOutput(proposal),
      }),
    )
  }
  const proposal = await rejectProposal(ctx.userId, input.proposalId)
  return ok(
    parseOutput('review_proposals', reviewProposalsOutputSchema, {
      action: 'rejected',
      proposal: toProposalOutput(proposal),
    }),
  )
}

/**
 * Build the three admin tool definitions. `toolNames` is injected by the
 * registry (tools.ts) so describe_environment can report the FULL surface
 * (including itself) without a circular import — tools.ts owns TOOLS; this module
 * is imported BY it, so it cannot read the final array at module load.
 */
export function createAdminTools(toolNames: () => readonly string[]): ToolDefinition[] {
  const configureScopeTool: ToolDefinition = {
    name: 'configure_scope',
    // Layer-1 floor: anyOf read|write, so a read-only token can `list` AND a
    // write-only token can mutate. The handler gates the exact action scope.
    requiredScope: { anyOf: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE] },
    config: {
      title: 'Configure Scope',
      description:
        'Manage your memory scopes: list, create, rename, set aliases, or delete (registry only — existing memories keep their scope). set_retrieval_default binds your READS to a scope: mode "default" narrows unscoped search/briefing/handoff calls to the given scope (results report appliedScope), "require" rejects unscoped reads until a scope is passed, "off" restores unrestricted reads (scope must be null for require/off). Mutating actions require the write scope.',
      inputSchema: configureScopeInputV2Schema,
      outputSchema: configureScopeOutputV2Schema,
    },
    async handler(args, ctx) {
      const input = configureScopeInputV2Schema.parse(args)
      return runConfigureScope(input, ctx)
    },
  }

  const describeEnvironmentTool: ToolDefinition = {
    name: 'describe_environment',
    requiredScope: MEMORY_READ_SCOPE,
    config: {
      title: 'Describe Environment',
      description:
        'Report server capabilities (tool names, count, version), your registered scopes, your active retrieval-scope policy (retrievalScopePolicy), and bounded memory/commitment counts. Exposes no secrets or configuration values.',
      inputSchema: describeEnvironmentInputSchema,
      outputSchema: describeEnvironmentOutputV2Schema,
    },
    async handler(args, ctx) {
      describeEnvironmentInputSchema.parse(args)
      // ACCESS GUARD: the report exposes the tenant's scope registry + per-tenant
      // memory/commitment COUNTS (memory-derived), so read access is asserted BEFORE
      // the db op (self-host allowAllAccess allows all). The static capabilities half
      // is not reached on a denial — the whole tool is a tenant-data read.
      if (ctx.access) await ctx.access.assertRead(ctx.userId)
      const report = await describeEnvironment(ctx.userId)
      const names = toolNames()
      const output = parseOutput('describe_environment', describeEnvironmentOutputV2Schema, {
        capabilities: { tools: [...names], toolCount: names.length, version: SERVER_VERSION },
        scopes: report.scopes.map(toScopeOutput),
        // The active retrieval-scope policy (issue #47): a bounded mode enum +
        // a registered scope NAME — the redaction posture is unchanged.
        retrievalScopePolicy: report.retrievalScopePolicy,
        stats: {
          memoriesByType: report.stats.memoriesByType,
          activeMemories: report.stats.activeMemories,
          supersededMemories: report.stats.supersededMemories,
          archivedMemories: report.stats.archivedMemories,
          commitmentsByStatus: report.stats.commitmentsByStatus,
        },
      })
      return ok(output)
    },
  }

  const reviewProposalsTool: ToolDefinition = {
    name: 'review_proposals',
    // Layer-1 floor: anyOf read|write (list is read, reject/accept are write).
    requiredScope: { anyOf: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE] },
    config: {
      title: 'Review Proposals',
      description:
        'List consolidation proposals (optionally by status), reject one, or accept one (materializes the proposed edge; a supersedes/updates edge also closes the predecessor). Reject and accept require the write scope.',
      inputSchema: reviewProposalsInputSchema,
      outputSchema: reviewProposalsOutputSchema,
    },
    async handler(args, ctx) {
      const input = reviewProposalsInputSchema.parse(args)
      return runReviewProposals(input, ctx)
    },
  }

  return [configureScopeTool, describeEnvironmentTool, reviewProposalsTool]
}
