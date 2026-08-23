// SPDX-License-Identifier: Apache-2.0
// REST typed-error mapping (docs/concepts/architecture.mdx thin transport). The
// REST mirror of the core memory tools translates a KNOWN typed core error into
// an HTTP status + a stable reason_code body, REUSING the MCP reason_code
// TAXONOMY (apps/server/src/mcp/errors.ts) but mapping to HTTP codes rather than
// MCP isError results — the two transports share the taxonomy, NOT the function
// (the MCP mapper emits CallToolResult; REST emits status + JSON).
//
// REASON_CODE -> HTTP (the contract this slice ships):
//   invalid_input        -> 400  (ZodError / typed core validation / not-commitment)
//   not_found            -> 404  (predecessor / commitment / scope / proposal absent)
//   conflict             -> 409  (already superseded, edge conflict, commitment exists)
//   duplicate_memory     -> 409  (content already live for the tenant)
//   resource_limit_exceeded -> 409 (injected resource capacity reached)
//   invalid_transition   -> 409  (illegal FSM transition)
//   invalid_output       -> 500  (a RESULT failed its output schema — server fault)
// auth statuses (401 unauthorized, 403 insufficient_scope, 503 resolver-or-DB)
// are emitted UPSTREAM (apiKeyAuth / scope.ts), so the mapper covers the core
// domain errors a route handler can throw. An UNKNOWN error returns undefined so
// the route surfaces a generic 500.
//
// Observability (hard rule 6): no memory content, query text, subject/value, or
// credential enters a log or a response body — only the error class name and the
// bounded ids/hashes the typed error already carries (a uuid, a content hash, an
// FSM state — never content).
import { log } from '@3ngram/config'
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
  MemoryNotFoundError,
  MissingSelectorError,
  NotCommitmentMemoryError,
  PredecessorAlreadySupersededError,
  PredecessorNotFoundError,
  ProposalNotFoundError,
  ResourceLimitExceededError,
  ScopeNameConflictError,
  ScopeNotFoundError,
  SuccessorNotLiveError,
  UnknownSessionRunError,
  UnscopedRetrievalError,
} from '@3ngram/core'
import { ZodError } from 'zod'
import { CursorQueryMismatchError } from '../cursor.js'
import { OutputValidationError } from '../output-validation.js'

/** A mapped HTTP failure: the status code and the stable reason_code body. */
export interface RestError {
  status: number
  /** The reason_code (MCP taxonomy) — the stable machine-readable error tag. */
  reason: string
  /**
   * Optional bounded, human-readable recovery detail — surfaced in the body
   * alongside the reason_code. Only ever carries bounded enum states or user
   * labels (e.g. registered scope names), NEVER memory content (hard rule 6).
   */
  detail?: string
}

/**
 * Map a thrown error to an HTTP status + reason_code, or undefined when the error
 * is NOT a known typed core error (the caller then surfaces a generic 500). This
 * mirrors the MCP catch ladder (apps/server/src/mcp/errors.ts) branch-for-branch
 * — the SAME reason_code taxonomy — but emits an HTTP contract: each branch logs
 * at the matching level (no content) and returns the status/reason pair.
 */
export function mapRestError(route: string, err: unknown): RestError | undefined {
  // A result that failed an OUTPUT schema is a 500-class SERVER
  // fault, never the caller's input. REST routes currently do not output-parse
  // (core's read-path excerpting bounds the shapes — see the search route), so
  // this branch mirrors the MCP ladder for any future output guard: same honest
  // taxonomy on both transports. Bounded metadata only.
  if (err instanceof OutputValidationError) {
    log().error(
      { route, err: err.name, issue_count: err.issueCount, paths: err.issuePaths },
      'rest: result failed output validation',
    )
    return { status: 500, reason: 'invalid_output' }
  }
  // An unscoped read rejected by the caller's own retrieval-scope policy
  // (mode 'require', issue #47) — the MissingSelectorError sibling: 400,
  // invalid_input, with bounded recovery DETAIL naming a prefix of the
  // registered scopes (user labels, never content — hard rule 6). Mirrors MCP.
  if (err instanceof UnscopedRetrievalError) {
    log().warn({ route, err: err.name }, 'rest: unscoped read rejected by policy')
    return {
      status: 400,
      reason: 'invalid_input',
      detail: formatUnscopedRetrievalDetail(err.registeredScopes),
    }
  }
  // Malformed CLIENT input — a ZodError from a boundary INPUT .parse() or a
  // typed core validation error — is a 400, not a server fault: only the error
  // class name is logged.
  if (
    err instanceof ZodError ||
    err instanceof InvalidEmbeddingError ||
    err instanceof MissingSelectorError ||
    err instanceof NotCommitmentMemoryError ||
    err instanceof UnknownSessionRunError ||
    // A continuation cursor replayed against a different query/filter set —
    // the caller's mistake, named honestly (never a silent re-page of the old
    // search's frozen ordering). No query text is logged, only the class name.
    err instanceof CursorQueryMismatchError
  ) {
    log().warn({ route, err: err instanceof Error ? err.name : 'unknown' }, 'rest: input rejected')
    return { status: 400, reason: 'invalid_input' }
  }
  // Over the per-user budget cap. 402 Payment Required is the
  // honest status for a spend-cap denial. The reason_code is stable and carries
  // NO cost internals (no cap, no consumption) — only the bounded op name is
  // logged.
  if (err instanceof BudgetExceededError) {
    log().warn({ route, operation: err.operation }, 'rest: over budget cap')
    return { status: 402, reason: 'budget_exceeded' }
  }
  // Access policy forbids the operation. 403 Forbidden is the honest status — the
  // request is authenticated but the access policy denies it. The reason_code
  // carries ONLY the bounded access kind the error holds, never any policy
  // internals.
  if (err instanceof AccessDeniedError) {
    log().warn({ route, access: err.access }, 'rest: access denied')
    return { status: 403, reason: 'access_denied' }
  }
  if (err instanceof ResourceLimitExceededError) {
    log().warn({ route, resource: err.resource }, 'rest: resource limit reached')
    return { status: 409, reason: 'resource_limit_exceeded' }
  }
  // Re-submitting content already live for the tenant is a documented domain
  // CONFLICT (409), not a server fault. Only the content_hash is logged.
  if (err instanceof DuplicateMemoryError) {
    log().warn({ route, content_hash: err.contentHash }, 'rest: duplicate memory rejected')
    return { status: 409, reason: 'duplicate_memory' }
  }
  // The referenced entity does not exist for the tenant (RLS hides cross-tenant
  // rows, so not-found and not-owned are one 404 mapping).
  if (err instanceof PredecessorNotFoundError) {
    log().warn({ route, err: err.name }, 'rest: predecessor not found')
    return { status: 404, reason: 'not_found' }
  }
  if (err instanceof CommitmentNotFoundError) {
    log().warn({ route, err: err.name }, 'rest: commitment not found')
    return { status: 404, reason: 'not_found' }
  }
  if (err instanceof ScopeNotFoundError) {
    log().warn({ route, err: err.name }, 'rest: scope not found')
    return { status: 404, reason: 'not_found' }
  }
  if (err instanceof ProposalNotFoundError) {
    log().warn({ route, err: err.name }, 'rest: proposal not found')
    return { status: 404, reason: 'not_found' }
  }
  if (err instanceof MemoryNotFoundError) {
    log().warn({ route, err: err.name }, 'rest: memory not found')
    return { status: 404, reason: 'not_found' }
  }
  // Documented domain CONFLICTS (409): already superseded, edge conflict, a
  // commitment already rides the memory, an illegal FSM transition, a scope-name
  // collision. Names the class / a bounded id or enum state only, never content.
  if (
    err instanceof PredecessorAlreadySupersededError ||
    err instanceof EdgeConflictError ||
    err instanceof CommitmentExistsError ||
    err instanceof ScopeNameConflictError ||
    err instanceof EpisodicSupersessionError ||
    err instanceof SuccessorNotLiveError
  ) {
    log().warn({ route, err: err.name }, 'rest: conflict')
    return { status: 409, reason: 'conflict' }
  }
  if (
    err instanceof InvalidCommitmentTransitionError ||
    err instanceof IllegalCommitmentTransitionError
  ) {
    log().warn(
      { route, err: err.name, from: err.from, to: err.to },
      'rest: illegal commitment transition',
    )
    return { status: 409, reason: 'invalid_transition' }
  }
  return undefined
}
