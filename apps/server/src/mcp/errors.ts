// SPDX-License-Identifier: Apache-2.0
// MCP typed-error mapping — the runTool catch ladder extracted from tools.ts (a
// mechanical split ahead of the 500-line cap; NO behaviour change). Translates a
// KNOWN typed core error into a class-named isError tool result, counts it under
// the right reason_code, and logs at the right level — all WITHOUT ever emitting
// memory content, query text, subject/value, or a credential (observability hard
// rule 6: only the error class name + bounded ids/hashes/enum states).
import { log, mcpToolErrors } from '@3ngram/config'
import {
  AccessDeniedError,
  BudgetExceededError,
  CommitmentExistsError,
  CommitmentNotFoundError,
  DuplicateMemoryError,
  EdgeConflictError,
  EpisodicSupersessionError,
  formatUnscopedRetrievalDetail,
  IllegalCommitmentTransitionError,
  InvalidCommitmentTransitionError,
  InvalidEmbeddingError,
  MissingSelectorError,
  NotCommitmentMemoryError,
  PredecessorAlreadySupersededError,
  PredecessorNotFoundError,
  // Admin tools: scope registry + proposal review typed errors —
  // appended block. ProposalNotFoundError now also covers the accept path's
  // not-open / not-owned guard.
  ProposalNotFoundError,
  ResourceLimitExceededError,
  ScopeNameConflictError,
  ScopeNotFoundError,
  SuccessorNotLiveError,
  UnknownSessionRunError,
  UnscopedRetrievalError,
} from '@3ngram/core'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { ZodError } from 'zod'
import { CursorQueryMismatchError } from '../cursor.js'
import { OutputValidationError } from '../output-validation.js'

/** The SDK result a tool returns: a text content mirror plus structured output. */
type ToolResult = CallToolResult

/** Wrap a typed failure as an isError result. The message names the class only. */
function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * Map a thrown error to a typed isError tool result, or return undefined when the
 * error is NOT a known typed core error (the caller then treats it as an internal
 * fault). This is the verbatim catch ladder from {@link runTool}: each branch
 * counts a metric under its reason_code, logs at the matching level (no content),
 * and returns a class-named failure. Keeping it a pure mapper (error -> result |
 * undefined) lets runTool own the metrics-call/log-call sequencing only for the
 * unknown-error fallthrough.
 */
export function mapToolError(toolName: string, err: unknown): ToolResult | undefined {
  // A result that failed its OUTPUT schema is a SERVER fault —
  // never invalid_input, which would blame the caller for our bug. Handlers
  // parse outputs via parseOutput(), which wraps the ZodError so this branch
  // can label it honestly. Logged at error (it is our defect) with bounded
  // metadata only: issue count + schema field paths, never values (rule 6).
  if (err instanceof OutputValidationError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'invalid_output' })
    log().error(
      { tool_name: toolName, err: err.name, issue_count: err.issueCount, paths: err.issuePaths },
      'mcp: tool result failed output validation',
    )
    return fail(
      `invalid_output: the server produced a ${toolName} result that failed output validation (${err.issueCount} issue(s)) — a server-side fault, not a problem with your input`,
    )
  }
  // Malformed CLIENT input — a ZodError from the boundary INPUT .parse() or a
  // typed core validation error — is a 400-class caller mistake, not a server
  // fault: count it as invalid_input and log at warn (no content; only the
  // error class name is recorded, hard rule 6). Output parses never throw a
  // bare ZodError (they are wrapped above), so this branch is input-only.
  if (
    err instanceof ZodError ||
    err instanceof InvalidEmbeddingError ||
    // A missing/empty orientation selector is the no-firehose guard (docs/concepts/mcp-design.mdx):
    // a 400-class caller mistake, not a server fault. Counted as invalid_input.
    err instanceof MissingSelectorError ||
    err instanceof UnknownSessionRunError
  ) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'invalid_input' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: tool input rejected')
    return fail(`invalid input: ${err.name}`)
  }
  // An unscoped read rejected by the caller's own retrieval-scope policy
  // (mode 'require', issue #47) — a MissingSelectorError sibling: a 400-class
  // caller mistake, counted as invalid_input. The bounded recovery names a
  // prefix of the REGISTERED SCOPES (user labels, never memory content — hard
  // rule 6) and reports how many additional names were omitted.
  if (err instanceof UnscopedRetrievalError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'invalid_input' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: unscoped read rejected by policy')
    return fail(`invalid input: ${formatUnscopedRetrievalDetail(err.registeredScopes)}`)
  }
  // A continuation cursor replayed against a DIFFERENT query/filter set than
  // the one that issued it — the caller's mistake, named honestly with the
  // recovery (never a silent re-page of the old search's frozen ordering, and
  // no query text in the log or the result — hard rule 6).
  if (err instanceof CursorQueryMismatchError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'invalid_input' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: cursor query mismatch')
    return fail(
      'invalid input: cursor was issued for a different query — omit the cursor to start a new search',
    )
  }
  // Over the per-user budget cap. A documented domain denial,
  // not a server fault: a class-named isError result counted under budget_exceeded.
  // Names ONLY the bounded operation key — never the cap/consumption or any
  // cost internals.
  if (err instanceof BudgetExceededError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'budget_exceeded' })
    log().warn({ tool_name: toolName, operation: err.operation }, 'mcp: over budget cap')
    return fail(`budget_exceeded: ${toolName} would exceed your usage budget`)
  }
  // Access policy forbids the operation. A documented domain denial, not a server
  // fault: a class-named isError result counted under access_denied. Names ONLY the
  // bounded access kind — never any policy internals.
  if (err instanceof AccessDeniedError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'access_denied' })
    log().warn({ tool_name: toolName, access: err.access }, 'mcp: access denied')
    return fail(`access_denied: ${err.access} access is forbidden`)
  }
  if (err instanceof ResourceLimitExceededError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'resource_limit_exceeded' })
    log().warn({ tool_name: toolName, resource: err.resource }, 'mcp: resource limit reached')
    return fail(`resource_limit_exceeded: ${err.resource} limit reached`)
  }
  // Re-submitting content already live for the tenant is a documented domain
  // CONFLICT, not a server fault: surface a class-named conflict result and
  // count it distinctly. The message names ONLY the content_hash the error
  // carries (a hash, never the content — observability hard rule 6).
  if (err instanceof DuplicateMemoryError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'duplicate_memory' })
    log().warn(
      { tool_name: toolName, content_hash: err.contentHash },
      'mcp: duplicate memory rejected',
    )
    return fail(`duplicate_memory: content already exists (contentHash ${err.contentHash})`)
  }
  // The parent memory a commitment would ride is not a live commitment-type
  // memory — a 400-class caller mistake (a fixture/edge defensive map per the
  // orchestrator decision), counted as invalid_input. Names the id only.
  if (err instanceof NotCommitmentMemoryError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'invalid_input' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: not a commitment memory')
    return fail(`invalid input: ${err.name}`)
  }
  // The referenced entity does not exist for the tenant (RLS hides cross-tenant
  // rows, so not-found and not-owned are one mapping). Names the missing id
  // only — a uuid, never content.
  if (err instanceof PredecessorNotFoundError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'not_found' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: predecessor not found')
    return fail(`not_found: predecessor ${err.predecessorId}`)
  }
  if (err instanceof CommitmentNotFoundError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'not_found' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: commitment not found')
    // keyedBy distinguishes the id the error carries: the memory-keyed resolve
    // path looks up by memory id, so a miss must read "memory <id>", never
    // mislabel it a commitment id. Default ('commitment') covers id-keyed misses
    // and any legacy instance lacking the discriminator.
    return fail(
      err.keyedBy === 'memory'
        ? `not_found: no commitment for memory ${err.commitmentId}`
        : `not_found: commitment ${err.commitmentId}`,
    )
  }
  // A documented domain CONFLICT (already superseded, edge already exists, a
  // commitment already rides the memory) — not a server fault. Names the class
  // and an id/hash only, never content.
  if (err instanceof PredecessorAlreadySupersededError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'conflict' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: predecessor already superseded')
    return fail(`conflict: predecessor already superseded (${err.predecessorId})`)
  }
  if (err instanceof EdgeConflictError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'conflict' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: edge conflict')
    return fail(`conflict: ${err.name}`)
  }
  if (err instanceof CommitmentExistsError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'conflict' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: commitment already exists')
    return fail(`conflict: commitment already exists (${err.memoryId})`)
  }
  // An illegal FSM transition (core's primary guard or the DB backstop). Names
  // the from/to states only — both are bounded enum values, never content.
  if (
    err instanceof InvalidCommitmentTransitionError ||
    err instanceof IllegalCommitmentTransitionError
  ) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'invalid_transition' })
    log().warn(
      { tool_name: toolName, err: err.name, from: err.from, to: err.to },
      'mcp: illegal commitment transition',
    )
    return fail(`invalid_transition: ${err.from} -> ${err.to}`)
  }
  // --- Admin tools: scope registry + proposal review — appended ---
  // A scope NAME collision (create/rename) is a documented domain CONFLICT, not a
  // server fault. Names the colliding scope NAME (a bounded user label, not memory
  // content) only.
  if (err instanceof ScopeNameConflictError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'conflict' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: scope name conflict')
    return fail(`conflict: scope "${err.scopeName}" already exists`)
  }
  // The referenced scope / proposal does not exist for the tenant (RLS hides
  // cross-tenant rows, so not-found and not-owned are one mapping). Names the
  // missing scope NAME / proposal id only.
  if (err instanceof ScopeNotFoundError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'not_found' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: scope not found')
    return fail(`not_found: scope "${err.scopeName}"`)
  }
  if (err instanceof ProposalNotFoundError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'not_found' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: proposal not open / not found')
    return fail(`not_found: open proposal ${err.proposalId}`)
  }
  // Accepting an event-type supersedes/updates proposal is refused (docs/concepts/memory-model.mdx "Consolidation is advisory"
  // episodic exclusion): a documented domain CONFLICT, not a server fault. Names
  // the proposal id + memory_type (a bounded enum) only, never content.
  if (err instanceof EpisodicSupersessionError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'conflict' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: episodic supersession refused')
    return fail(
      `conflict: event-type proposal ${err.proposalId} cannot supersede (docs/concepts/memory-model.mdx)`,
    )
  }
  // A fresh apply whose proposed SUCCESSOR (from_id) is no longer live — the
  // proposal went stale while queued (a later revise superseded from_id), so
  // applying would leave neither side of the knowledge live. A documented
  // domain CONFLICT, not a server fault; the proposal stays open for the
  // existing reject path. Names the proposal + memory ids only, never content.
  if (err instanceof SuccessorNotLiveError) {
    mcpToolErrors.add(1, { tool_name: toolName, reason_code: 'conflict' })
    log().warn({ tool_name: toolName, err: err.name }, 'mcp: proposal successor no longer live')
    return fail(
      `conflict: proposal ${err.proposalId} successor ${err.fromId} is no longer live; re-propose against the live successor or reject this proposal`,
    )
  }
  return undefined
}
