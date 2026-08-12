// SPDX-License-Identifier: Apache-2.0
// MCP tool CONTRACT tests (no DB, no network): every tool schema-validates its
// input (rejecting bad payloads) and produces schema-valid structured output.
// The tools call the COMPLETE core through a stubbed module so the contract is
// exercised without a database; the schema boundary (packages/schema/mcp.ts) is
// the assertion target, plus the tool-count discipline (hard rule 8).
//
// Mocking @3ngram/core lets us assert the THIN-ADAPTER contract: the tool passes
// the validated args to core, shapes the result against outputSchema, and maps
// typed errors to isError — all without a Postgres dependency.

import { runWithContext } from '@3ngram/config'
import { MEMORY_READ_SCOPE } from '@3ngram/core/auth'
import { fakeEmbedding } from '@3ngram/llm'
import {
  briefingToolOutputV2Schema,
  briefingToolOutputV3Schema,
  configureScopeOutputV2Schema,
  describeEnvironmentOutputV2Schema,
  factsToolOutputSchema,
  getMemoriesOutputSchema,
  handoffToolOutputV2Schema,
  handoffToolOutputV3Schema,
  rememberToolOutputSchema,
  rememberToolOutputV2Schema,
  resolveToolOutputSchema,
  reviewProposalsOutputV2Schema,
  reviseToolOutputSchema,
  searchQueryV3Schema,
  searchToolOutputV2Schema,
} from '@3ngram/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeCursor, encodeCursor, searchFingerprint } from '../src/cursor.js'
import { SERVER_VERSION } from '../src/version.js'

const remember = vi.fn()
const searchDashboardPage = vi.fn()
const searchChronological = vi.fn()
const getFacts = vi.fn()
const revise = vi.fn()
const resolveByMemoryId = vi.fn()
const briefing = vi.fn()
const handoff = vi.fn()
// Inspect tool core fn (get_memories).
const getMemoriesByIds = vi.fn()
// D3 admin-tool core fns (configure_scope / describe_environment / review_proposals).
const listScopes = vi.fn()
const createScope = vi.fn()
const renameScope = vi.fn()
const setScopeAliases = vi.fn()
const deleteScope = vi.fn()
const describeEnvironment = vi.fn()
const setRetrievalDefault = vi.fn()
const listProposals = vi.fn()
const rejectProposal = vi.fn()
const applyProposal = vi.fn()
const listAllProposals = vi.fn()
const rejectProposalAnyKind = vi.fn()
const acceptProposalAnyKind = vi.fn()

// Real typed error classes so the runTool instanceof mapping is exercised.
class InvalidEmbeddingError extends Error {}
// Mirrors the real @3ngram/db class: carries the colliding content_hash (a hash,
// never the content) so the conflict mapping can name it.
class DuplicateMemoryError extends Error {
  readonly contentHash: string
  constructor(contentHash: string) {
    super('memory with this content already exists for this tenant')
    this.name = 'DuplicateMemoryError'
    this.contentHash = contentHash
  }
}
// Revise/commitment typed errors — id/state fields only, never content (rule 6).
class PredecessorNotFoundError extends Error {
  readonly predecessorId: string
  constructor(predecessorId: string) {
    super('predecessor memory not found for this tenant')
    this.name = 'PredecessorNotFoundError'
    this.predecessorId = predecessorId
  }
}
class PredecessorAlreadySupersededError extends Error {
  readonly predecessorId: string
  constructor(predecessorId: string) {
    super('predecessor memory is already superseded')
    this.name = 'PredecessorAlreadySupersededError'
    this.predecessorId = predecessorId
  }
}
class EdgeConflictError extends Error {
  constructor() {
    super('edge already exists')
    this.name = 'EdgeConflictError'
  }
}
// Over-budget denial: carries the bounded operation key only.
class BudgetExceededError extends Error {
  readonly operation: string
  constructor(operation: string) {
    super(`operation '${operation}' would exceed the usage budget`)
    this.name = 'BudgetExceededError'
    this.operation = operation
  }
}
// Access denial: bounded access kind only.
class AccessDeniedError extends Error {
  constructor(readonly access: 'read' | 'write') {
    super(`${access} access is forbidden`)
    this.name = 'AccessDeniedError'
  }
}
class ResourceLimitExceededError extends Error {
  constructor(readonly resource: 'live_memories' | 'active_mcp_clients') {
    super('resource limit reached')
    this.name = 'ResourceLimitExceededError'
  }
}
class CommitmentNotFoundError extends Error {
  readonly commitmentId: string
  constructor(commitmentId: string) {
    super('commitment not found for this tenant')
    this.name = 'CommitmentNotFoundError'
    this.commitmentId = commitmentId
  }
}
class CommitmentExistsError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super('a commitment already exists for this memory')
    this.name = 'CommitmentExistsError'
    this.memoryId = memoryId
  }
}
class NotCommitmentMemoryError extends Error {
  readonly memoryId: string
  constructor(memoryId: string) {
    super('parent memory is not a live commitment-type memory')
    this.name = 'NotCommitmentMemoryError'
    this.memoryId = memoryId
  }
}
class InvalidCommitmentTransitionError extends Error {
  readonly from: string
  readonly to: string
  constructor(from: string, to: string) {
    super(`commitment transition not permitted: ${from} -> ${to}`)
    this.name = 'InvalidCommitmentTransitionError'
    this.from = from
    this.to = to
  }
}
class IllegalCommitmentTransitionError extends Error {
  readonly from: string
  readonly to: string
  constructor(from: string, to: string) {
    super(`illegal commitment transition: ${from} -> ${to}`)
    this.name = 'IllegalCommitmentTransitionError'
    this.from = from
    this.to = to
  }
}
// Orientation typed error — the no-firehose guard. Carries no fields.
class MissingSelectorError extends Error {
  constructor(message = 'a briefing requires an explicit selector (scope, project, or all)') {
    super(message)
    this.name = 'MissingSelectorError'
  }
}
function formatUnscopedRetrievalDetail(registeredScopes: readonly string[]): string {
  const prefix =
    "this account requires an explicit retrieval scope (retrieval-scope mode 'require') — "
  if (registeredScopes.length === 0) {
    return `${prefix}no scopes are registered yet — register one with configure_scope`
  }
  const shown = registeredScopes.slice(0, 8)
  const omitted = registeredScopes.length - shown.length
  return `${prefix}registered scopes: ${shown.join(', ')}${omitted > 0 ? `; +${omitted} more omitted` : ''}`
}
// Retrieval-scope policy typed error (issue #47) — mirrors @3ngram/core: the
// message names the REGISTERED SCOPES (bounded user labels, never content).
class UnscopedRetrievalError extends Error {
  readonly registeredScopes: readonly string[]
  constructor(registeredScopes: readonly string[]) {
    super(formatUnscopedRetrievalDetail(registeredScopes))
    this.name = 'UnscopedRetrievalError'
    this.registeredScopes = registeredScopes
  }
}
function applyPolicyToScopeFilter(
  policy: { mode: string; defaultScope?: string; registeredScopes?: readonly string[] } | undefined,
  requestedScope: string | undefined,
) {
  if (requestedScope !== undefined) return { scope: requestedScope, appliedScope: null }
  if (policy?.mode === 'default') {
    return { scope: policy.defaultScope, appliedScope: policy.defaultScope ?? null }
  }
  if (policy?.mode === 'require') throw new UnscopedRetrievalError(policy.registeredScopes ?? [])
  return { scope: undefined, appliedScope: null }
}
// D3 admin typed errors — mirror @3ngram/core (id/name fields only, never content).
class ScopeNameConflictError extends Error {
  readonly scopeName: string
  constructor(scopeName: string) {
    super(`a scope named "${scopeName}" already exists for this tenant`)
    this.name = 'ScopeNameConflictError'
    this.scopeName = scopeName
  }
}
class ScopeNotFoundError extends Error {
  readonly scopeName: string
  constructor(scopeName: string) {
    super(`no scope named "${scopeName}" for this tenant`)
    this.name = 'ScopeNotFoundError'
    this.scopeName = scopeName
  }
}
class ProposalNotFoundError extends Error {
  readonly proposalId: string
  constructor(proposalId: string) {
    super(`no open proposal ${proposalId} for this tenant`)
    this.name = 'ProposalNotFoundError'
    this.proposalId = proposalId
  }
}
class EpisodicSupersessionError extends Error {
  readonly proposalId: string
  readonly memoryType: string
  constructor(proposalId: string, memoryType: string) {
    super(
      'event-type memories cannot be superseded/updated via a proposal (docs/concepts/memory-model.mdx "Consolidation is advisory")',
    )
    this.name = 'EpisodicSupersessionError'
    this.proposalId = proposalId
    this.memoryType = memoryType
  }
}
class SuccessorNotLiveError extends Error {
  readonly proposalId: string
  readonly fromId: string
  constructor(proposalId: string, fromId: string) {
    super('proposed successor is no longer live; re-propose against the live successor chain')
    this.name = 'SuccessorNotLiveError'
    this.proposalId = proposalId
    this.fromId = fromId
  }
}
vi.mock('@3ngram/core', () => ({
  applyPolicyToScopeFilter,
  remember,
  searchDashboardPage,
  searchChronological,
  getFacts,
  revise,
  resolveByMemoryId,
  briefing,
  handoff,
  getMemoriesByIds,
  BudgetExceededError,
  AccessDeniedError,
  ResourceLimitExceededError,
  DuplicateMemoryError,
  InvalidEmbeddingError,
  PredecessorNotFoundError,
  PredecessorAlreadySupersededError,
  EdgeConflictError,
  CommitmentNotFoundError,
  CommitmentExistsError,
  NotCommitmentMemoryError,
  InvalidCommitmentTransitionError,
  IllegalCommitmentTransitionError,
  MissingSelectorError,
  formatUnscopedRetrievalDetail,
  UnscopedRetrievalError,
  // D3 admin tools
  listScopes,
  setRetrievalDefault,
  createScope,
  renameScope,
  setScopeAliases,
  deleteScope,
  describeEnvironment,
  listProposals,
  rejectProposal,
  applyProposal,
  listAllProposals,
  rejectProposalAnyKind,
  acceptProposalAnyKind,
  ScopeNameConflictError,
  ScopeNotFoundError,
  ProposalNotFoundError,
  EpisodicSupersessionError,
  SuccessorNotLiveError,
}))

const { TOOLS, MAX_TOOLS, runTool } = await import('../src/mcp/tools.js')
type ToolContext = import('../src/mcp/tools.js').ToolContext

const UID = crypto.randomUUID()
const MEMO_ID = crypto.randomUUID()

function toolByName(name: string) {
  const tool = TOOLS.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`tool ${name} not registered`)
  return tool
}

const fakeGateway = {
  embed: (texts: readonly string[]) => Promise.resolve(texts.map((t) => fakeEmbedding(t))),
  complete: () => Promise.reject(new Error('not implemented')),
}

// Default test ctx carries BOTH scopes so existing tool tests exercise the happy
// path; scope-gate tests override `scopes` explicitly.
function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: UID,
    scopes: ['memory:read', 'memory:write'],
    gateway: fakeGateway,
    ...overrides,
  }
}

async function call(name: string, args: unknown, context: ToolContext) {
  return runWithContext({ requestId: 'test', surface: 'mcp' }, () =>
    runTool(toolByName(name), args, context),
  )
}

beforeEach(() => vi.clearAllMocks())

describe('MCP tool registry discipline', () => {
  it('registers exactly 11 tools (D1 5 + D2 orient 2 + inspect 1 + D3 admin 3), under the cap', () => {
    // MERGED truth: the 5 existing tools (remember, search, get_facts, revise,
    // resolve) + D2 orientation (briefing, handoff) + the inspect follow-up read
    // (get_memories) + D3 admin (configure_scope, describe_environment,
    // review_proposals) -> the 11-tool surface. The cap (<=12,
    // docs/concepts/mcp-design.mdx / hard rule 8) stays the ceiling; the last
    // slot is UNRESERVED — it goes to whichever tool next earns it.
    expect(TOOLS).toHaveLength(11)
    expect(TOOLS.map((t) => t.name)).toEqual([
      'remember',
      'search',
      'get_facts',
      'revise',
      'resolve',
      'briefing',
      'handoff',
      'get_memories',
      'configure_scope',
      'describe_environment',
      'review_proposals',
    ])
    expect(TOOLS.length).toBeLessThanOrEqual(MAX_TOOLS)
  })

  it('every tool declares input + output schema shapes (input may be empty for a no-arg tool)', () => {
    // A tool's input shape MAY be empty (a parameterless tool like
    // describe_environment, whose strict empty-object input takes no args); its
    // OUTPUT shape must always carry fields. The shapes are still real Zod raw
    // shapes the SDK registers and validates against.
    const NO_ARG_TOOLS = new Set(['describe_environment'])
    for (const tool of TOOLS) {
      if (!NO_ARG_TOOLS.has(tool.name)) {
        expect(Object.keys(tool.config.inputSchema).length).toBeGreaterThan(0)
      }
      expect(Object.keys(tool.config.outputSchema).length).toBeGreaterThan(0)
    }
  })

  // Annotations (issue #102). A registry-wide invariant is worth more than
  // per-tool assertions: the failure it prevents is a NEW tool shipping with no
  // hints, which no per-tool test would ever catch.
  it('every tool declares annotations, and none claims an open world', () => {
    for (const tool of TOOLS) {
      expect(tool.config.annotations, `${tool.name} declares no annotations`).toBeDefined()
      expect(typeof tool.config.annotations.readOnlyHint).toBe('boolean')
      // Every tool operates on the tenant's own corpus, never an open external
      // world. If a future tool needs `true`, that is a design conversation.
      expect(tool.config.annotations.openWorldHint, `${tool.name} openWorldHint`).toBe(false)
    }
  })

  it('marks exactly the read-scoped tools readOnlyHint: true', () => {
    // requiredScope is the ground truth for the read/write split, so the two
    // must agree. Annotations are NOT derived from it (the per-action tools
    // carry `anyOf` and span both), which is precisely why the agreement needs
    // asserting rather than assuming.
    const readOnly = TOOLS.filter((t) => t.config.annotations.readOnlyHint === true).map(
      (t) => t.name,
    )
    expect(readOnly.sort()).toEqual(
      ['briefing', 'describe_environment', 'get_facts', 'get_memories', 'handoff', 'search'].sort(),
    )
    for (const tool of TOOLS) {
      const isReadScoped = tool.requiredScope === MEMORY_READ_SCOPE
      expect(tool.config.annotations.readOnlyHint, `${tool.name}`).toBe(isReadScoped)
    }
  })

  it('never claims a write path is destructive to memory data (hard rule 1)', () => {
    // AGENTS.md hard rule 1: no write path destroys memory data — supersession
    // is append-only. destructiveHint: false on the memory writers is therefore
    // ACCURATE, and saying so to clients is a genuine product claim.
    // configure_scope is the one exception: `delete` removes a scope REGISTRY
    // entry (memories keep their scope string), so it is honestly destructive.
    for (const tool of TOOLS) {
      if (tool.config.annotations.readOnlyHint === true) continue
      const expected = tool.name === 'configure_scope'
      expect(tool.config.annotations.destructiveHint, `${tool.name}`).toBe(expected)
    }
  })
})

describe('remember tool', () => {
  it('ACKs without awaiting the embed: reports `pending`, never blocks on settle', async () => {
    // A settle handle that NEVER resolves: if the handler awaited it the call
    // would hang. It returns immediately because ack-before-embed does not await.
    remember.mockResolvedValue({
      id: MEMO_ID,
      embed: { settled: new Promise<boolean>(() => undefined) },
    })
    const result = await Promise.race([
      call(
        'remember',
        { memoryType: 'decision', topic: 'pin sdk', content: 'pin mcp sdk at 1.29.0' },
        ctx(),
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('handler blocked on embed')), 50),
      ),
    ])
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(remember).toHaveBeenCalledOnce()
    const parsed = rememberToolOutputSchema.parse(
      (result as { structuredContent: unknown }).structuredContent,
    )
    expect(parsed.memory.id).toBe(MEMO_ID)
    expect(parsed.memory.scope).toBe('personal') // default applied
    expect(parsed.embedded).toBe('pending') // gateway configured: embed in flight
  })

  it('reports `off` when no embedding gateway is configured', async () => {
    remember.mockResolvedValue({ id: MEMO_ID, embed: { settled: Promise.resolve(false) } })
    const result = await call(
      'remember',
      { memoryType: 'decision', topic: 'pin sdk', content: 'pin mcp sdk at 1.29.0' },
      ctx({ gateway: undefined }),
    )
    expect(result.isError).toBeFalsy()
    const parsed = rememberToolOutputSchema.parse(result.structuredContent)
    expect(parsed.embedded).toBe('off')
  })

  it('surfaces the auto-created commitmentId for a commitment-type memory', async () => {
    const commitmentId = crypto.randomUUID()
    remember.mockResolvedValue({
      id: MEMO_ID,
      commitmentId,
      embed: { settled: Promise.resolve(false) },
    })
    const result = await call(
      'remember',
      { memoryType: 'commitment', topic: 'ship d1', content: 'open the d1 PR by friday' },
      ctx({ gateway: undefined }),
    )
    expect(result.isError).toBeFalsy()
    const parsed = rememberToolOutputSchema.parse(result.structuredContent)
    expect(parsed.commitmentId).toBe(commitmentId)
  })

  it('omits commitmentId for a non-commitment memory', async () => {
    remember.mockResolvedValue({ id: MEMO_ID, embed: { settled: Promise.resolve(false) } })
    const result = await call(
      'remember',
      { memoryType: 'note', topic: 'x', content: 'y' },
      ctx({ gateway: undefined }),
    )
    const parsed = rememberToolOutputSchema.parse(result.structuredContent)
    expect(parsed.commitmentId).toBeUndefined()
  })

  it('rejects a bad input (missing required content) without calling core', async () => {
    const result = await call('remember', { memoryType: 'decision', topic: 'x' }, ctx())
    expect(result.isError).toBe(true)
    expect(remember).not.toHaveBeenCalled()
  })

  it('threads facts to core and echoes the written factIds', async () => {
    const factIds = [crypto.randomUUID(), crypto.randomUUID()]
    remember.mockResolvedValue({ id: MEMO_ID, factIds, embed: { settled: Promise.resolve(false) } })
    const facts = [
      { subject: 'lift.back_squat', predicate: 'top_set.weight_kg', value: '98' },
      { subject: 'lift.back_squat', predicate: 'top_set.reps', value: '3' },
    ]
    const result = await call(
      'remember',
      { memoryType: 'fact', topic: 'training', content: 'squat session', facts },
      ctx({ gateway: undefined }),
    )

    expect(result.isError).toBeFalsy()
    // The tool registers the strict V2 schema, so `facts` survives to the
    // handler instead of being stripped, and reaches core unchanged.
    const coreInput = remember.mock.calls[0]?.[1] as { facts?: unknown }
    expect(coreInput.facts).toEqual(facts)
    const parsed = rememberToolOutputV2Schema.parse(result.structuredContent)
    expect(parsed.factIds).toEqual(factIds)
  })

  it('accepts an ISO validFrom on a fact (JSON carries no date type)', async () => {
    remember.mockResolvedValue({
      id: MEMO_ID,
      factIds: [crypto.randomUUID()],
      embed: { settled: Promise.resolve(false) },
    })
    const result = await call(
      'remember',
      {
        memoryType: 'fact',
        topic: 'training',
        content: 'squat session',
        facts: [
          {
            subject: 'lift.back_squat',
            predicate: 'top_set.weight_kg',
            value: '98',
            validFrom: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      ctx({ gateway: undefined }),
    )
    expect(result.isError).toBeFalsy()
    const coreInput = remember.mock.calls[0]?.[1] as { facts: { validFrom: string }[] }
    expect(coreInput.facts[0]?.validFrom).toBe('2026-01-01T00:00:00.000Z')
  })

  it('omits factIds entirely when no facts were written (V1 response unchanged)', async () => {
    remember.mockResolvedValue({ id: MEMO_ID, embed: { settled: Promise.resolve(false) } })
    const result = await call(
      'remember',
      { memoryType: 'note', topic: 'x', content: 'y' },
      ctx({ gateway: undefined }),
    )

    const structured = result.structuredContent as Record<string, unknown>
    expect('factIds' in structured).toBe(false)
    // Byte-identical to the shipped surface: the V1 schema still parses it.
    expect(rememberToolOutputSchema.parse(structured)).toEqual(structured)
  })

  it('rejects a malformed fact at the tool boundary without calling core', async () => {
    // Empty value, a Date instead of an ISO string, an unknown key, and a
    // validTo with no validFrom must each fail before core is reached.
    for (const bad of [
      { subject: 's', predicate: 'p', value: '' },
      { subject: 's', predicate: 'p', value: 'v', validFrom: new Date() },
      { subject: 's', predicate: 'p', value: 'v', memoryId: MEMO_ID },
      { subject: 's', predicate: 'p', value: 'v', validTo: '2026-01-01T00:00:00.000Z' },
    ]) {
      const result = await call(
        'remember',
        { memoryType: 'fact', topic: 't', content: 'c', facts: [bad] },
        ctx({ gateway: undefined }),
      )
      expect(result.isError, JSON.stringify(bad)).toBe(true)
    }
    expect(remember).not.toHaveBeenCalled()
  })

  it('round-trips an explicit scope + project to core AND echoes them (#284)', async () => {
    // The tool registers the FULL `.strict()` schema, so the SDK no longer wraps
    // it non-strict and strips supplied keys before the handler runs: an explicit
    // scope:'work'/project:'3ngram' reaches core and is echoed in the structured
    // output — NOT the scope:'personal'/project:null defaults of an omitted axis.
    remember.mockResolvedValue({ id: MEMO_ID, embed: { settled: Promise.resolve(false) } })
    const result = await call(
      'remember',
      {
        memoryType: 'decision',
        topic: 'pin sdk',
        content: 'pin mcp sdk at 1.29.0',
        scope: 'work',
        project: '3ngram',
      },
      ctx({ gateway: undefined }),
    )
    expect(result.isError).toBeFalsy()
    expect(remember).toHaveBeenCalledOnce()
    const coreInput = remember.mock.calls[0]?.[1] as { scope: string; project: string }
    expect(coreInput.scope).toBe('work')
    expect(coreInput.project).toBe('3ngram')
    const parsed = rememberToolOutputSchema.parse(result.structuredContent)
    expect(parsed.memory.scope).toBe('work')
    expect(parsed.memory.project).toBe('3ngram')
  })

  it('still rejects an UNKNOWN key rather than silently dropping it (strict, #284)', async () => {
    // Mirrors the search strict-reject test: the `.strict()` schema rejects
    // an unrecognised key at the boundary, never strips it before core runs.
    const result = await call(
      'remember',
      { memoryType: 'note', topic: 'x', content: 'y', bogusKey: 'oops' },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect(remember).not.toHaveBeenCalled()
  })

  it('maps a re-submitted duplicate to a conflict result, not internal_error', async () => {
    // Core throws the documented DuplicateMemoryError when live content with the
    // same hash already exists for the tenant. The tool must surface a typed
    // conflict naming ONLY the content_hash — never the content, never a 500.
    const contentHash = 'a'.repeat(64)
    remember.mockRejectedValue(new DuplicateMemoryError(contentHash))
    const result = await call(
      'remember',
      { memoryType: 'decision', topic: 'pin sdk', content: 'pin mcp sdk at 1.29.0' },
      ctx(),
    )
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('duplicate_memory')
    expect(text).toContain(contentHash)
    // Observability hard rule 6: the original content must never leak into the result.
    expect(text).not.toContain('pin mcp sdk at 1.29.0')
    expect(remember).toHaveBeenCalledOnce()
  })

  it('maps a live-memory cap denial to resource_limit_exceeded', async () => {
    remember.mockRejectedValue(new ResourceLimitExceededError('live_memories'))
    const result = await call(
      'remember',
      { memoryType: 'note', topic: 'cap', content: 'one over' },
      ctx(),
    )

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toBe(
      'resource_limit_exceeded: live_memories limit reached',
    )
  })
})

describe('search tool', () => {
  /** Wrap hits as the core DashboardSearchPage shape (frozen ordering + offset). */
  function pageOf(
    hits: Array<{ id: string; score: number }>,
    overrides: Record<string, unknown> = {},
  ) {
    const policyScope = typeof overrides.appliedScope === 'string' ? overrides.appliedScope : null
    return {
      hits,
      frozen: {
        ids: hits.map((h) => h.id),
        scores: hits.map((h) => h.score),
        policyScope,
      },
      nextOffset: hits.length,
      hasMore: false,
      ...overrides,
    }
  }

  const HIT = {
    id: MEMO_ID,
    memoryType: 'decision',
    topic: 'pin',
    content: 'pinned',
    contentLength: 'pinned'.length,
    truncated: false,
    score: 0.9,
    superseded: false,
  }

  it('validates input, calls core, returns a bounded schema-valid hit list', async () => {
    searchDashboardPage.mockResolvedValue(pageOf([HIT]))
    const result = await call('search', { query: 'sdk pin' }, ctx())
    expect(result.isError).toBeFalsy()
    const parsed = searchToolOutputV2Schema.parse(result.structuredContent)
    expect(parsed.count).toBe(1)
    expect(parsed.hits[0]?.id).toBe(MEMO_ID)
    // The excerpt metadata rides every FULL-projection (default) hit.
    expect(parsed.hits[0]).toMatchObject({ contentLength: 'pinned'.length, truncated: false })
    // Final page: hasMore false and NO dangling cursor (schema-enforced pair).
    expect(parsed.hasMore).toBe(false)
    expect(parsed.nextCursor).toBeUndefined()
  })

  it('surfaces a demoted predecessor as superseded: true on the full-projection hit', async () => {
    searchDashboardPage.mockResolvedValue(pageOf([{ ...HIT, superseded: true }]))
    const result = await call('search', { query: 'sdk pin' }, ctx())
    expect(result.isError).toBeFalsy()
    const parsed = searchToolOutputV2Schema.parse(result.structuredContent)
    expect(parsed.hits[0]).toMatchObject({ superseded: true })
  })

  it('compact projection omits the excerpt triple per hit (#49)', async () => {
    searchDashboardPage.mockResolvedValue(pageOf([HIT]))
    const result = await call('search', { query: 'sdk pin', projection: 'compact' }, ctx())
    expect(result.isError).toBeFalsy()
    const parsed = searchToolOutputV2Schema.parse(result.structuredContent)
    expect(parsed.hits[0]).toEqual({
      id: MEMO_ID,
      memoryType: 'decision',
      topic: 'pin',
      score: 0.9,
      superseded: false,
    })
  })

  it('emits a decodable nextCursor exactly when core reports a further page (#49)', async () => {
    searchDashboardPage.mockResolvedValue(pageOf([HIT], { nextOffset: 1, hasMore: true }))
    const result = await call('search', { query: 'sdk pin', limit: 1 }, ctx())
    expect(result.isError).toBeFalsy()
    const parsed = searchToolOutputV2Schema.parse(result.structuredContent)
    expect(parsed.hasMore).toBe(true)
    // The token is the SAME v2 frozen-ordering cursor the dashboard mints,
    // fingerprint-BOUND to the issuing query+filters.
    expect(decodeCursor(parsed.nextCursor as string)).toEqual({
      v: 2,
      ids: [MEMO_ID],
      scores: [0.9],
      off: 1,
      fp: searchFingerprint('sdk pin', {}),
      policyScope: null,
    })
  })

  it('binds continuation cursors to the effective policy scope', async () => {
    searchDashboardPage.mockResolvedValue(
      pageOf([HIT], { nextOffset: 1, hasMore: true, appliedScope: 'work' }),
    )
    const issued = await call(
      'search',
      { query: 'sdk pin', limit: 1 },
      ctx({ retrievalPolicy: vi.fn(async () => ({ mode: 'default', defaultScope: 'work' })) }),
    )
    const cursor = (issued.structuredContent as { nextCursor: string }).nextCursor
    expect(decodeCursor(cursor)).toMatchObject({
      fp: searchFingerprint('sdk pin', {}, 'work', true),
      policyScope: 'work',
    })

    vi.clearAllMocks()
    const samePolicy = await call(
      'search',
      { query: 'sdk pin', cursor },
      ctx({ retrievalPolicy: vi.fn(async () => ({ mode: 'default', defaultScope: 'work' })) }),
    )
    expect(samePolicy.isError).toBeFalsy()
    expect(searchDashboardPage.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        frozen: expect.objectContaining({ off: 1, policyScope: 'work' }),
      }),
    )

    vi.clearAllMocks()
    for (const policy of [
      { mode: 'default', defaultScope: 'personal' },
      { mode: 'off' },
    ] as const) {
      const replay = await call(
        'search',
        { query: 'sdk pin', cursor },
        ctx({ retrievalPolicy: vi.fn(async () => policy) }),
      )
      expect(replay.isError).toBe(true)
    }
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('rejects policy-default and explicit-scope cursor provenance changes', async () => {
    searchDashboardPage.mockResolvedValue(
      pageOf([HIT], { nextOffset: 1, hasMore: true, appliedScope: 'work' }),
    )
    const policyCtx = ctx({
      retrievalPolicy: vi.fn(async () => ({ mode: 'default', defaultScope: 'work' })),
    })
    const issuedByPolicy = await call('search', { query: 'sdk pin', limit: 1 }, policyCtx)
    const policyCursor = (issuedByPolicy.structuredContent as { nextCursor: string }).nextCursor

    vi.clearAllMocks()
    const explicitReplay = await call(
      'search',
      { query: 'sdk pin', scope: 'work', cursor: policyCursor },
      policyCtx,
    )
    expect(explicitReplay.isError).toBe(true)
    expect(searchDashboardPage).not.toHaveBeenCalled()

    const explicitCursor = encodeCursor({
      v: 2,
      ids: [MEMO_ID],
      scores: [0.9],
      off: 1,
      fp: searchFingerprint('sdk pin', { scope: 'work' }, 'work'),
      policyScope: null,
    })
    const policyReplay = await call(
      'search',
      { query: 'sdk pin', cursor: explicitCursor },
      policyCtx,
    )
    expect(policyReplay.isError).toBe(true)
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('decodes a fingerprint-less legacy cursor and threads the frozen ordering to core (#49)', async () => {
    // verify-when-present compatibility: a v2 cursor minted BEFORE the
    // query-binding carries no fp and must keep paging, not 400 mid-session.
    searchDashboardPage.mockResolvedValue(pageOf([]))
    const cursor = encodeCursor({ v: 2, ids: [MEMO_ID], scores: [0.9], off: 1 })
    const result = await call('search', { query: 'sdk pin', cursor }, ctx())
    expect(result.isError).toBeFalsy()
    const [, , , options] = searchDashboardPage.mock.calls[0] as [
      string,
      string,
      unknown,
      { frozen?: { ids: string[]; scores: number[]; off: number } },
    ]
    expect(options.frozen).toEqual({ ids: [MEMO_ID], scores: [0.9], off: 1 })
  })

  it('continues a bound cursor under the SAME query+filters', async () => {
    searchDashboardPage.mockResolvedValue(pageOf([]))
    const fp = searchFingerprint('sdk pin', { scope: 'work' })
    const cursor = encodeCursor({ v: 2, ids: [MEMO_ID], scores: [0.9], off: 1, fp })
    const result = await call('search', { query: 'sdk pin', scope: 'work', cursor }, ctx())
    expect(result.isError).toBeFalsy()
    expect(searchDashboardPage).toHaveBeenCalledOnce()
  })

  it('rejects a cursor replayed under a CHANGED query/filters as typed invalid input', async () => {
    const fp = searchFingerprint('sdk pin', {})
    const cursor = encodeCursor({ v: 2, ids: [MEMO_ID], scores: [0.9], off: 1, fp })
    // Changed query text.
    const changedQuery = await call('search', { query: 'something else', cursor }, ctx())
    expect(changedQuery.isError).toBe(true)
    expect((changedQuery.content[0] as { text: string }).text).toBe(
      'invalid input: cursor was issued for a different query — omit the cursor to start a new search',
    )
    // Same query, changed filter set.
    const changedFilters = await call('search', { query: 'sdk pin', scope: 'work', cursor }, ctx())
    expect(changedFilters.isError).toBe(true)
    // Never a silent re-page of the old frozen ordering.
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('rejects a garbled cursor as CLIENT input without reaching core (#49)', async () => {
    const result = await call('search', { query: 'sdk pin', cursor: '!!!garbled!!!' }, ctx())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('invalid input')
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('labels an over-cap hit as invalid_output (a SERVER fault), never invalid_input (#238)', async () => {
    // Force core to break its own contract (an unexcerpted long row). The tool
    // must label the failure as an OUTPUT fault — blaming the caller's input
    // for a server-side shape bug is the dishonest label this fix removes.
    searchDashboardPage.mockResolvedValue(
      pageOf([
        {
          id: MEMO_ID,
          memoryType: 'note',
          topic: 't',
          content: 'z'.repeat(5000),
          contentLength: 5000,
          truncated: false,
          score: 0.5,
        },
      ]),
    )
    const result = await call('search', { query: 'epic' }, ctx())
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('invalid_output')
    expect(text).not.toContain('invalid input')
    // Hard rule 6: the label carries NO memory content.
    expect(text).not.toContain('zzz')
  })

  it('returns a typed error when no embedding gateway is configured', async () => {
    const result = await call('search', { query: 'sdk pin' }, ctx({ gateway: undefined }))
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'embedding gateway not configured' })
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('rejects an empty query without calling core', async () => {
    const result = await call('search', { query: '   ' }, ctx())
    expect(result.isError).toBe(true)
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('caps the limit at the no-firehose ceiling', () => {
    expect(searchQueryV3Schema.safeParse({ query: 'x', limit: 999 }).success).toBe(false)
  })

  it('accepts a supported filter and threads it into the core options (#166)', async () => {
    // The MCP search tool EXPOSES the candidate-narrowing filters: a `scope`
    // filter validates and reaches core as DashboardPageOptions.filters, never dropped.
    expect(searchQueryV3Schema.safeParse({ query: 'x', scope: 'work' }).success).toBe(true)
    searchDashboardPage.mockResolvedValue(pageOf([]))
    const result = await call('search', { query: 'sdk pin', scope: 'work' }, ctx())
    expect(result.isError).toBeFalsy()
    expect(searchDashboardPage).toHaveBeenCalledOnce()
    const [, query, , options] = searchDashboardPage.mock.calls[0] as [
      string,
      string,
      unknown,
      { limit: number; filters: Record<string, unknown> },
    ]
    expect(query).toBe('sdk pin')
    expect(options.filters).toMatchObject({ scope: 'work' })
    // An absent axis is stripped (defined()): only the supplied filter rides.
    expect(Object.keys(options.filters)).toEqual(['scope'])
  })

  it('threads memoryType, project, status and asOf filters together (#166)', async () => {
    searchDashboardPage.mockResolvedValue(pageOf([]))
    await call(
      'search',
      {
        query: 'q',
        memoryType: 'decision',
        project: '3ngram',
        status: 'active',
        asOf: { validAt: '2026-01-01T00:00:00.000Z' },
      },
      ctx(),
    )
    const [, , , options] = searchDashboardPage.mock.calls[0] as [
      string,
      string,
      unknown,
      { filters: { memoryType?: string; project?: string; status?: string; asOf?: unknown } },
    ]
    expect(options.filters.memoryType).toBe('decision')
    expect(options.filters.project).toBe('3ngram')
    expect(options.filters.status).toBe('active')
    // ISO strings are coerced to Date at the transport boundary for the core query.
    expect(options.filters.asOf).toEqual({ validAt: new Date('2026-01-01T00:00:00.000Z') })
  })

  it('threads the V2 axes: memoryTypes[] + recordedAfter/recordedBefore as Dates (#48)', async () => {
    searchDashboardPage.mockResolvedValue(pageOf([]))
    await call(
      'search',
      {
        query: 'q',
        memoryTypes: ['decision', 'fact'],
        recordedAfter: '2026-01-01T00:00:00.000Z',
        recordedBefore: '2026-02-01T00:00:00.000Z',
      },
      ctx(),
    )
    const [, , , options] = searchDashboardPage.mock.calls[0] as [
      string,
      string,
      unknown,
      { filters: { memoryTypes?: string[]; recordedAfter?: Date; recordedBefore?: Date } },
    ]
    expect(options.filters.memoryTypes).toEqual(['decision', 'fact'])
    // The range bounds coerce ISO -> Date at the transport boundary like asOf.
    expect(options.filters.recordedAfter).toEqual(new Date('2026-01-01T00:00:00.000Z'))
    expect(options.filters.recordedBefore).toEqual(new Date('2026-02-01T00:00:00.000Z'))
    expect(Object.keys(options.filters).sort()).toEqual([
      'memoryTypes',
      'recordedAfter',
      'recordedBefore',
    ])
  })

  it('REJECTS memoryTypes together with memoryType at the boundary (mutually exclusive, #48)', async () => {
    expect(
      searchQueryV3Schema.safeParse({ query: 'q', memoryType: 'decision', memoryTypes: ['fact'] })
        .success,
    ).toBe(false)
    const result = await call(
      'search',
      { query: 'q', memoryType: 'decision', memoryTypes: ['fact'] },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('rejects an out-of-contract memoryTypes list (empty / over-cap / bad enum)', async () => {
    for (const memoryTypes of [
      [],
      Array.from({ length: 9 }, () => 'note'),
      ['not-a-memory-type'],
    ]) {
      const result = await call('search', { query: 'q', memoryTypes }, ctx())
      expect(result.isError).toBe(true)
    }
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  it('still rejects an UNKNOWN filter key rather than silently dropping it (strict)', async () => {
    // The schema stays `.strict()`: an unrecognised key is a clear validation
    // error, never silently ignored (a silent drop on a filter reads as a leak).
    expect(searchQueryV3Schema.safeParse({ query: 'x', bogusFilter: 'oops' }).success).toBe(false)
    const result = await call('search', { query: 'sdk pin', bogusFilter: 'oops' }, ctx())
    expect(result.isError).toBe(true)
    expect(searchDashboardPage).not.toHaveBeenCalled()
  })

  describe('order: chronological (list mode, issue #134)', () => {
    /** Wrap hits as core's ListPage shape (keyset cursor, no frozen pool). */
    function listPageOf(
      hits: Array<{ id: string; score: number }>,
      overrides: Record<string, unknown> = {},
    ) {
      const last = hits[hits.length - 1]
      return {
        hits,
        hasMore: false,
        nextCursor:
          last === undefined
            ? undefined
            : { recordedAt: '2026-01-01T00:00:00.000000Z', id: last.id },
        appliedScope: null,
        ...overrides,
      }
    }

    it('runs WITHOUT a configured gateway — no query, filter present', async () => {
      searchChronological.mockResolvedValue(listPageOf([HIT]))
      const result = await call(
        'search',
        { order: 'chronological', scope: 'work' },
        ctx({ gateway: undefined }),
      )
      expect(result.isError).toBeFalsy()
      expect(searchChronological).toHaveBeenCalledTimes(1)
      expect(searchDashboardPage).not.toHaveBeenCalled()
      const parsed = searchToolOutputV2Schema.parse(result.structuredContent)
      expect(parsed.hits[0]?.id).toBe(MEMO_ID)
    })

    it('rejects a chronological call with no query AND no filter — nothing bounds the scan', async () => {
      const result = await call('search', { order: 'chronological' }, ctx({ gateway: undefined }))
      expect(result.isError).toBe(true)
      expect(searchChronological).not.toHaveBeenCalled()
    })

    // The chronological core path takes no query argument at all, so a query
    // that reached it was silently discarded and the caller got the whole live
    // corpus back. It must never reach core.
    it('rejects a chronological call carrying a query, even with a filter', async () => {
      const result = await call(
        'search',
        { order: 'chronological', scope: 'work', query: 'find it' },
        ctx({ gateway: undefined }),
      )
      expect(result.isError).toBe(true)
      expect(searchChronological).not.toHaveBeenCalled()
    })

    it('rejects a chronological call with a query and no filter', async () => {
      const result = await call(
        'search',
        { order: 'chronological', query: 'find it' },
        ctx({ gateway: undefined }),
      )
      expect(result.isError).toBe(true)
      expect(searchChronological).not.toHaveBeenCalled()
    })

    it('mints a v3 keyset cursor, decodable, distinct in shape from the v2 frozen cursor, at full microsecond precision', async () => {
      // A non-zero microsecond remainder (.654321, not .000000) proves the
      // cursor carries the value through VERBATIM — a `new Date()` round-trip
      // anywhere in the path would floor this to .654 and fail the assertion.
      searchChronological.mockResolvedValue(
        listPageOf([HIT], {
          hasMore: true,
          nextCursor: { recordedAt: '2026-03-01T00:00:00.654321Z', id: MEMO_ID },
        }),
      )
      const result = await call('search', { order: 'chronological', scope: 'work' }, ctx())
      const cursor = (result.structuredContent as { nextCursor: string }).nextCursor
      expect(cursor).toBeDefined()
      const decoded = decodeCursor(cursor) as { v: number; recordedAt?: string; id?: string }
      expect(decoded.v).toBe(3)
      expect(decoded.id).toBe(MEMO_ID)
      expect(decoded.recordedAt).toBe('2026-03-01T00:00:00.654321Z')
    })

    it('rejects a v2 (relevance) cursor replayed under chronological order as invalid input', async () => {
      // A cursor minted by relevance order carries `fp` bound to a DIFFERENT
      // fingerprint formula (no `order` folded in, different query/filters) —
      // decodeSearchCursor's fingerprint check fires before any shape
      // inspection, so the mismatch is a typed invalid_input, never a crash
      // or a silent misread of the wrong shape.
      searchDashboardPage.mockResolvedValue(pageOf([HIT], { hasMore: true }))
      const relevanceResult = await call('search', { query: 'sdk pin' }, ctx())
      const v2Cursor = (relevanceResult.structuredContent as { nextCursor: string }).nextCursor

      const result = await call(
        'search',
        { order: 'chronological', scope: 'work', cursor: v2Cursor },
        ctx({ gateway: undefined }),
      )
      expect(result.isError).toBe(true)
      expect(searchChronological).not.toHaveBeenCalled()
    })

    it('rejects a hand-crafted fingerprint-less v3 cursor as invalid input (fp is required on v3)', async () => {
      // `fp` is REQUIRED on cursorPayloadV3Schema — v3 is introduced in this
      // same change, so no legacy fp-less v3 token has ever legitimately
      // existed (unlike v2's optional `fp`, a backward-compatibility carve-out
      // for tokens minted before that field existed). Bypass encodeCursor's
      // typed CursorPayload param (which now REJECTS this shape at compile
      // time) to simulate a hand-stripped/malicious token: it must not decode
      // as a v3 shape at all — a fp-less v3 payload is rejected as malformed
      // input, the same as a garbled token, never silently accepted via the
      // shape-guard fallback.
      const malformedV3Cursor = Buffer.from(
        JSON.stringify({ v: 3, recordedAt: '2026-01-01T00:00:00.000000Z', id: MEMO_ID }),
        'utf8',
      ).toString('base64url')
      const result = await call(
        'search',
        { order: 'chronological', scope: 'work', cursor: malformedV3Cursor },
        ctx({ gateway: undefined }),
      )
      expect(result.isError).toBe(true)
      expect(searchChronological).not.toHaveBeenCalled()
    })

    it('binds the cursor fingerprint to order, so a chronological cursor is rejected under relevance order', async () => {
      searchChronological.mockResolvedValue(
        listPageOf([HIT], {
          hasMore: true,
          nextCursor: { recordedAt: '2026-01-01T00:00:00.000000Z', id: MEMO_ID },
        }),
      )
      const chronoResult = await call(
        'search',
        { order: 'chronological', scope: 'work' },
        ctx({ gateway: undefined }),
      )
      const v3Cursor = (chronoResult.structuredContent as { nextCursor: string }).nextCursor

      searchDashboardPage.mockResolvedValue(pageOf([HIT]))
      // SAME scope filter, but order defaults to relevance and a query is now
      // required — the mismatched shape restarts the walk (no crash), and
      // relevance order still needs query, which is absent here, so this is
      // rejected as invalid input rather than silently misreading the cursor.
      const result = await call('search', { scope: 'work', cursor: v3Cursor }, ctx())
      expect(result.isError).toBe(true)
    })
  })
})

describe('get_facts tool', () => {
  it('validates input, calls core, returns schema-valid facts', async () => {
    getFacts.mockResolvedValue([
      {
        id: MEMO_ID,
        memoryId: MEMO_ID,
        subject: 'sdk',
        predicate: 'version',
        value: '1.29.0',
        confidence: null,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: null,
        recordedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])
    const result = await call('get_facts', { subject: 'sdk' }, ctx())
    expect(result.isError).toBeFalsy()
    const parsed = factsToolOutputSchema.parse(result.structuredContent)
    expect(parsed.count).toBe(1)
    expect(parsed.facts[0]?.value).toBe('1.29.0')
  })

  it('rejects a blank subject filter without calling core', async () => {
    const result = await call('get_facts', { subject: '  ' }, ctx())
    expect(result.isError).toBe(true)
    expect(getFacts).not.toHaveBeenCalled()
  })

  it('forwards the default limit on a bare list-mode call (no-firehose)', async () => {
    getFacts.mockResolvedValue([])
    await call('get_facts', {}, ctx())
    expect(getFacts).toHaveBeenCalledOnce()
    // The strict schema applies DEFAULT_FACTS_LIMIT (50); the tool forwards it so
    // list mode never returns the whole table.
    expect(getFacts.mock.calls[0]?.[1]).toMatchObject({ limit: 50 })
  })

  it('honors a caller-supplied limit and rejects one over the ceiling', async () => {
    getFacts.mockResolvedValue([])
    await call('get_facts', { limit: 10 }, ctx())
    expect(getFacts.mock.calls[0]?.[1]).toMatchObject({ limit: 10 })

    const overCap = await call('get_facts', { limit: 999 }, ctx())
    expect(overCap.isError).toBe(true)
    expect(getFacts).toHaveBeenCalledOnce() // the over-cap call never reached core
  })

  // get_facts range read: a chronological time-series read over a valid-time window.
  it('forwards a range window to core and returns recordedAt on every fact', async () => {
    getFacts.mockResolvedValue([
      {
        id: MEMO_ID,
        memoryId: MEMO_ID,
        subject: 'sdk',
        predicate: 'version',
        value: '1.28.0',
        confidence: null,
        validFrom: new Date('2025-01-01T00:00:00.000Z'),
        validTo: new Date('2026-01-01T00:00:00.000Z'),
        recordedAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    ])
    const result = await call(
      'get_facts',
      { range: { from: '2025-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' } },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    expect(getFacts).toHaveBeenCalledWith(
      UID,
      expect.objectContaining({
        range: {
          from: new Date('2025-01-01T00:00:00.000Z'),
          to: new Date('2026-06-01T00:00:00.000Z'),
        },
      }),
    )
    const parsed = factsToolOutputSchema.parse(result.structuredContent)
    expect(parsed.facts[0]?.recordedAt).toBe('2025-01-01T00:00:00.000Z')
  })

  it('rejects an empty range object without calling core (mirrors asOf)', async () => {
    const result = await call('get_facts', { range: {} }, ctx())
    expect(result.isError).toBe(true)
    expect(getFacts).not.toHaveBeenCalled()
  })

  it('rejects range together with asOf (mutually exclusive time-travel modes)', async () => {
    const result = await call(
      'get_facts',
      {
        range: { from: '2025-01-01T00:00:00.000Z' },
        asOf: { validAt: '2025-06-01T00:00:00.000Z' },
      },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect(getFacts).not.toHaveBeenCalled()
  })

  it('rejects an inverted range (from later than to) — issue #58 precedent: reject, not clamp', async () => {
    const result = await call(
      'get_facts',
      { range: { from: '2026-01-01T00:00:00.000Z', to: '2025-01-01T00:00:00.000Z' } },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect(getFacts).not.toHaveBeenCalled()
  })

  // ACCESS GATE ENFORCEMENT: get_facts is a READ, so the handler asserts
  // ctx.access.assertRead BEFORE the core op. A denying gate must reject (isError
  // access_denied) AND getFacts must NEVER be reached. The other get_facts tests
  // run with no access gate (ctx() omits it), the back-compat / allow-all proof.
  it('denies get_facts under a denying access gate BEFORE core runs (#429)', async () => {
    const denyingAccess = {
      assertRead: async () => {
        throw new AccessDeniedError('read')
      },
      assertWrite: async () => {
        throw new AccessDeniedError('write')
      },
    }
    const result = await call(
      'get_facts',
      { subject: 'sdk' },
      ctx({ access: denyingAccess as unknown as ToolContext['access'] }),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('access_denied')
    // The gate blocked BEFORE the db op — core was never invoked.
    expect(getFacts).not.toHaveBeenCalled()
  })
})

describe('revise tool', () => {
  const validReviseArgs = () => ({
    memoryType: 'decision',
    topic: 'sdk pin',
    content: 'pin mcp sdk at 1.30.0',
    predecessorId: MEMO_ID,
    edgeIntent: 'supersedes',
  })

  it('ACKs without awaiting the embed: reports `pending`, returns the successor id', async () => {
    const successorId = crypto.randomUUID()
    revise.mockResolvedValue({
      id: successorId,
      embed: { settled: new Promise<boolean>(() => undefined) },
    })
    const result = await Promise.race([
      call('revise', validReviseArgs(), ctx()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('handler blocked on embed')), 50),
      ),
    ])
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    const parsed = reviseToolOutputSchema.parse(
      (result as { structuredContent: unknown }).structuredContent,
    )
    expect(parsed.memory.id).toBe(successorId)
    expect(parsed.memory.scope).toBe('personal') // default applied at the boundary
    expect(parsed.embedded).toBe('pending')
  })

  it('reports `off` when no gateway is configured', async () => {
    revise.mockResolvedValue({
      id: crypto.randomUUID(),
      embed: { settled: Promise.resolve(false) },
    })
    const result = await call('revise', validReviseArgs(), ctx({ gateway: undefined }))
    const parsed = reviseToolOutputSchema.parse(result.structuredContent)
    expect(parsed.embedded).toBe('off')
  })

  it('rejects a missing predecessorId without calling core', async () => {
    const { predecessorId: _drop, ...noPred } = validReviseArgs()
    const result = await call('revise', noPred, ctx())
    expect(result.isError).toBe(true)
    expect(revise).not.toHaveBeenCalled()
  })

  it('round-trips an explicit scope + project to core AND echoes them (#284)', async () => {
    // FULL `.strict()` registration: a supplied scope:'work'/project:'3ngram'
    // survives to the handler and is echoed, not stripped to personal/null.
    revise.mockResolvedValue({ id: MEMO_ID, embed: { settled: Promise.resolve(false) } })
    const result = await call(
      'revise',
      { ...validReviseArgs(), scope: 'work', project: '3ngram' },
      ctx({ gateway: undefined }),
    )
    expect(result.isError).toBeFalsy()
    expect(revise).toHaveBeenCalledOnce()
    const coreInput = revise.mock.calls[0]?.[1] as { scope: string; project: string }
    expect(coreInput.scope).toBe('work')
    expect(coreInput.project).toBe('3ngram')
    const parsed = reviseToolOutputSchema.parse(result.structuredContent)
    expect(parsed.memory.scope).toBe('work')
    expect(parsed.memory.project).toBe('3ngram')
  })

  it('still rejects an UNKNOWN key rather than silently dropping it (strict, #284)', async () => {
    const result = await call('revise', { ...validReviseArgs(), bogusKey: 'oops' }, ctx())
    expect(result.isError).toBe(true)
    expect(revise).not.toHaveBeenCalled()
  })

  it('rejects an out-of-family edge intent (extends) without calling core', async () => {
    const result = await call('revise', { ...validReviseArgs(), edgeIntent: 'extends' }, ctx())
    expect(result.isError).toBe(true)
    expect(revise).not.toHaveBeenCalled()
  })

  it('maps PredecessorNotFoundError to not_found, naming the id only', async () => {
    revise.mockRejectedValue(new PredecessorNotFoundError(MEMO_ID))
    const result = await call('revise', validReviseArgs(), ctx())
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('not_found')
    expect(text).toContain(MEMO_ID)
    expect(text).not.toContain('pin mcp sdk at 1.30.0')
  })

  it('maps PredecessorAlreadySupersededError to a conflict', async () => {
    revise.mockRejectedValue(new PredecessorAlreadySupersededError(MEMO_ID))
    const result = await call('revise', validReviseArgs(), ctx())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('conflict')
  })

  it('maps DuplicateMemoryError to duplicate_memory, naming the hash only', async () => {
    const contentHash = 'b'.repeat(64)
    revise.mockRejectedValue(new DuplicateMemoryError(contentHash))
    const result = await call('revise', validReviseArgs(), ctx())
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('duplicate_memory')
    expect(text).toContain(contentHash)
    expect(text).not.toContain('pin mcp sdk at 1.30.0')
  })

  it('maps EdgeConflictError to a conflict', async () => {
    revise.mockRejectedValue(new EdgeConflictError())
    const result = await call('revise', validReviseArgs(), ctx())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('conflict')
  })
})

describe('resolve tool', () => {
  it('validates input, calls core, returns the new commitment status', async () => {
    const commitmentId = crypto.randomUUID()
    resolveByMemoryId.mockResolvedValue({ id: commitmentId, status: 'resolved' })
    const result = await call('resolve', { memoryId: MEMO_ID, status: 'resolved' }, ctx())
    expect(result.isError).toBeFalsy()
    const parsed = resolveToolOutputSchema.parse(result.structuredContent)
    expect(parsed.commitmentId).toBe(commitmentId)
    expect(parsed.status).toBe('resolved')
    // Keys on the MEMORY id the agent holds, not a commitment id.
    expect(resolveByMemoryId.mock.calls[0]?.[1]).toBe(MEMO_ID)
    expect(resolveByMemoryId.mock.calls[0]?.[2]).toBe('resolved')
  })

  it('serves unresolve: resolved -> open is a legal target the tool forwards', async () => {
    resolveByMemoryId.mockResolvedValue({ id: crypto.randomUUID(), status: 'open' })
    const result = await call('resolve', { memoryId: MEMO_ID, status: 'open' }, ctx())
    expect(result.isError).toBeFalsy()
    expect(resolveToolOutputSchema.parse(result.structuredContent).status).toBe('open')
  })

  it('rejects an unknown status enum without calling core', async () => {
    const result = await call('resolve', { memoryId: MEMO_ID, status: 'done' }, ctx())
    expect(result.isError).toBe(true)
    expect(resolveByMemoryId).not.toHaveBeenCalled()
  })

  it('rejects a non-uuid memoryId without calling core', async () => {
    const result = await call('resolve', { memoryId: 'not-a-uuid', status: 'resolved' }, ctx())
    expect(result.isError).toBe(true)
    expect(resolveByMemoryId).not.toHaveBeenCalled()
  })

  it('maps CommitmentNotFoundError to not_found, naming the id only', async () => {
    resolveByMemoryId.mockRejectedValue(new CommitmentNotFoundError(MEMO_ID))
    const result = await call('resolve', { memoryId: MEMO_ID, status: 'resolved' }, ctx())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('not_found')
  })

  it('maps InvalidCommitmentTransitionError to invalid_transition (from/to only)', async () => {
    resolveByMemoryId.mockRejectedValue(new InvalidCommitmentTransitionError('resolved', 'expired'))
    const result = await call('resolve', { memoryId: MEMO_ID, status: 'expired' }, ctx())
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('invalid_transition')
    expect(text).toContain('resolved -> expired')
  })

  it('maps the DB backstop IllegalCommitmentTransitionError to invalid_transition too', async () => {
    resolveByMemoryId.mockRejectedValue(new IllegalCommitmentTransitionError('open', 'open'))
    const result = await call('resolve', { memoryId: MEMO_ID, status: 'open' }, ctx())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('invalid_transition')
  })

  // ACCESS GATE ENFORCEMENT: resolve mutates a commitment/blocker, so the handler
  // asserts ctx.access.assertWrite BEFORE the core op. A denying gate must reject
  // (isError access_denied) AND resolveByMemoryId must NEVER be reached — proving
  // the gate blocks BEFORE the db op. The other resolve tests run with no access
  // gate (ctx() omits it), which is the back-compat / allow-all proof.
  it('denies resolve under a denying access gate BEFORE core runs (#429)', async () => {
    const denyingAccess = {
      assertRead: async () => {
        throw new AccessDeniedError('write')
      },
      assertWrite: async () => {
        throw new AccessDeniedError('write')
      },
    }
    const result = await call(
      'resolve',
      { memoryId: MEMO_ID, status: 'resolved' },
      ctx({ access: denyingAccess as unknown as ToolContext['access'] }),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('access_denied')
    // The gate blocked BEFORE the db op — core was never invoked.
    expect(resolveByMemoryId).not.toHaveBeenCalled()
  })
})

describe('briefing tool (D2 orientation)', () => {
  const briefSection = () => ({ count: 0, items: [], hasMore: false })
  const fakeBriefing = (overrides: Record<string, unknown> = {}) => ({
    selector: { kind: 'all' },
    mode: 'brief',
    generatedAt: '2026-06-06T00:00:00.000Z',
    commitments: briefSection(),
    overdue: briefSection(),
    blockers: briefSection(),
    staleCandidates: briefSection(),
    recentDecisions: briefSection(),
    preferences: briefSection(),
    ...overrides,
  })

  it('requires a selector: a missing selector is a schema rejection, never core', async () => {
    const result = await call('briefing', {}, ctx())
    expect(result.isError).toBe(true)
    expect(briefing).not.toHaveBeenCalled()
  })

  it('validates the selector + mode, calls core, returns a schema-valid briefing', async () => {
    briefing.mockResolvedValue(fakeBriefing({ selector: { kind: 'scope', scope: 'work' } }))
    const result = await call(
      'briefing',
      { selector: { kind: 'scope', scope: 'work' }, mode: 'brief' },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    const parsed = briefingToolOutputV2Schema.parse(result.structuredContent)
    expect(parsed.mode).toBe('brief')
    // The tool forwards the selector to core (no-firehose discipline).
    expect(briefing.mock.calls[0]?.[1]).toMatchObject({
      selector: { kind: 'scope', scope: 'work' },
    })
  })

  it('forwards sections + sectionLimit to core and omits them when absent (bounds V2)', async () => {
    briefing.mockResolvedValue(fakeBriefing())
    await call(
      'briefing',
      { selector: { kind: 'all' }, sections: ['overdue'], sectionLimit: 50 },
      ctx(),
    )
    expect(briefing.mock.calls[0]?.[1]).toMatchObject({ sections: ['overdue'], sectionLimit: 50 })
    briefing.mockClear()
    briefing.mockResolvedValue(fakeBriefing())
    await call('briefing', { selector: { kind: 'all' } }, ctx())
    const arg = briefing.mock.calls[0]?.[1] as Record<string, unknown>
    expect('sections' in arg).toBe(false)
    expect('sectionLimit' in arg).toBe(false)
  })

  it('accepts a subset briefing from core (skipped sections omitted) and keeps hasMore', async () => {
    briefing.mockResolvedValue({
      selector: { kind: 'all' },
      mode: 'full',
      generatedAt: '2026-06-06T00:00:00.000Z',
      overdue: { count: 9, items: [], hasMore: true },
    })
    const result = await call(
      'briefing',
      { selector: { kind: 'all' }, mode: 'full', sections: ['overdue'] },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    const parsed = briefingToolOutputV2Schema.parse(result.structuredContent)
    expect(parsed.overdue?.hasMore).toBe(true)
    expect(parsed.commitments).toBeUndefined()
  })

  it('rejects an out-of-ceiling sectionLimit and a duplicate sections list at the boundary', async () => {
    expect(
      (await call('briefing', { selector: { kind: 'all' }, sectionLimit: 101 }, ctx())).isError,
    ).toBe(true)
    expect(
      (await call('briefing', { selector: { kind: 'all' }, sectionLimit: 0 }, ctx())).isError,
    ).toBe(true)
    expect(
      (
        await call(
          'briefing',
          { selector: { kind: 'all' }, sections: ['overdue', 'overdue'] },
          ctx(),
        )
      ).isError,
    ).toBe(true)
    expect(briefing).not.toHaveBeenCalled()
  })

  it('defaults mode to brief and injects a now Date at the transport edge', async () => {
    briefing.mockResolvedValue(fakeBriefing())
    await call('briefing', { selector: { kind: 'all' } }, ctx())
    const arg = briefing.mock.calls[0]?.[1] as { mode: string; now: Date }
    expect(arg.mode).toBe('brief')
    expect(arg.now).toBeInstanceOf(Date)
  })

  it('rejects an unknown mode and a scope selector missing its value', async () => {
    expect(
      (await call('briefing', { selector: { kind: 'all' }, mode: 'verbose' }, ctx())).isError,
    ).toBe(true)
    expect((await call('briefing', { selector: { kind: 'scope' } }, ctx())).isError).toBe(true)
    expect(briefing).not.toHaveBeenCalled()
  })

  it('maps a core MissingSelectorError to an invalid input result', async () => {
    briefing.mockRejectedValue(new MissingSelectorError())
    // The schema would normally catch this; force the core path to prove the map.
    const result = await call('briefing', { selector: { kind: 'all' } }, ctx())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('invalid input')
  })

  it('accepts a scope_project selector, defaulting includeUnscoped false (issue #46)', async () => {
    const selector = {
      kind: 'scope_project',
      scope: 'work',
      project: '3ngram',
      includeUnscoped: false,
    }
    briefing.mockResolvedValue(fakeBriefing({ selector }))
    const result = await call(
      'briefing',
      { selector: { kind: 'scope_project', scope: 'work', project: '3ngram' } },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    // The schema default rides into core: past the boundary includeUnscoped is
    // ALWAYS explicit, and the echoed selector round-trips the V3 output parse.
    expect(briefing.mock.calls[0]?.[1]).toMatchObject({ selector })
    const parsed = briefingToolOutputV3Schema.parse(result.structuredContent)
    expect(parsed.selector).toEqual(selector)
  })

  it('rejects a malformed scope_project selector and any bare-variant widening', async () => {
    // Missing project: the intersection needs both halves.
    expect(
      (await call('briefing', { selector: { kind: 'scope_project', scope: 'work' } }, ctx()))
        .isError,
    ).toBe(true)
    // The shipped bare project variant is NOT widened — includeUnscoped only
    // rides the scope_project kind (strict variants reject the smuggle).
    expect(
      (
        await call(
          'briefing',
          { selector: { kind: 'project', project: '3ngram', includeUnscoped: true } },
          ctx(),
        )
      ).isError,
    ).toBe(true)
    expect(briefing).not.toHaveBeenCalled()
  })
})

describe('handoff tool (D2 orientation)', () => {
  const fakeHandoff = (overrides: Record<string, unknown> = {}) => ({
    selector: { kind: 'all' },
    generatedFor: null,
    generatedAt: '2026-06-06T00:00:00.000Z',
    decisions: [],
    commitments: [],
    preferences: [],
    notes: [],
    counts: { decisions: 0, commitments: 0, preferences: 0 },
    truncated: { decisions: false, commitments: false, preferences: false },
    ...overrides,
  })

  it('requires a selector', async () => {
    const result = await call('handoff', {}, ctx())
    expect(result.isError).toBe(true)
    expect(handoff).not.toHaveBeenCalled()
  })

  it('validates input, calls core, returns a schema-valid handoff (content included)', async () => {
    handoff.mockResolvedValue(
      fakeHandoff({
        decisions: [
          {
            id: MEMO_ID,
            memoryType: 'decision',
            topic: 'sdk pin',
            content: 'pin mcp sdk at 1.29.0',
            contentLength: 'pin mcp sdk at 1.29.0'.length,
            truncated: false,
            scope: 'work',
            project: null,
          },
        ],
        counts: { decisions: 40, commitments: 0, preferences: 0 },
        truncated: { decisions: true, commitments: false, preferences: false },
      }),
    )
    const result = await call(
      'handoff',
      { selector: { kind: 'all' }, generatedFor: 'agent-b' },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    const parsed = handoffToolOutputV2Schema.parse(result.structuredContent)
    // Content IS included by design (a handoff transports context).
    expect(parsed.decisions[0]?.content).toBe('pin mcp sdk at 1.29.0')
    // The exact per-section totals + truncation flags ride the envelope (V2).
    expect(parsed.counts.decisions).toBe(40)
    expect(parsed.truncated.decisions).toBe(true)
    expect(handoff.mock.calls[0]?.[1]).toMatchObject({
      selector: { kind: 'all' },
      generatedFor: 'agent-b',
    })
  })

  it('omits generatedFor from the core call when not supplied', async () => {
    handoff.mockResolvedValue(fakeHandoff())
    await call('handoff', { selector: { kind: 'all' } }, ctx())
    const arg = handoff.mock.calls[0]?.[1] as Record<string, unknown>
    expect('generatedFor' in arg).toBe(false)
    expect(arg.now).toBeInstanceOf(Date)
  })

  it('accepts a scope_project selector via the shared union (issue #46)', async () => {
    const selector = {
      kind: 'scope_project',
      scope: 'work',
      project: '3ngram',
      includeUnscoped: true,
    }
    handoff.mockResolvedValue(fakeHandoff({ selector }))
    const result = await call('handoff', { selector }, ctx())
    expect(result.isError).toBeFalsy()
    expect(handoff.mock.calls[0]?.[1]).toMatchObject({ selector })
    const parsed = handoffToolOutputV3Schema.parse(result.structuredContent)
    expect(parsed.selector).toEqual(selector)
  })

  it('forwards sectionLimit to core and omits it when absent (bounds V2)', async () => {
    handoff.mockResolvedValue(fakeHandoff())
    await call('handoff', { selector: { kind: 'all' }, sectionLimit: 80 }, ctx())
    expect(handoff.mock.calls[0]?.[1]).toMatchObject({ sectionLimit: 80 })
    handoff.mockClear()
    handoff.mockResolvedValue(fakeHandoff())
    await call('handoff', { selector: { kind: 'all' } }, ctx())
    const arg = handoff.mock.calls[0]?.[1] as Record<string, unknown>
    expect('sectionLimit' in arg).toBe(false)
  })

  it('rejects an out-of-ceiling sectionLimit at the boundary (never reaches core)', async () => {
    expect(
      (await call('handoff', { selector: { kind: 'all' }, sectionLimit: 101 }, ctx())).isError,
    ).toBe(true)
    expect(
      (await call('handoff', { selector: { kind: 'all' }, sectionLimit: 0 }, ctx())).isError,
    ).toBe(true)
    expect(handoff).not.toHaveBeenCalled()
  })
})

describe('per-tool OAuth scope enforcement (fail-closed)', () => {
  it('every registered tool declares a valid scope floor (single scope or anyOf)', () => {
    const valid = ['memory:read', 'memory:write']
    for (const tool of TOOLS) {
      const floor = tool.requiredScope
      if (typeof floor === 'string') {
        expect(valid).toContain(floor)
      } else {
        expect(floor.anyOf.length).toBeGreaterThan(0)
        for (const scope of floor.anyOf) expect(valid).toContain(scope)
      }
    }
  })

  it('a read-only token can search but remember returns the scope error', async () => {
    const readOnly = ctx({ scopes: ['memory:read'] })
    searchDashboardPage.mockResolvedValue({
      hits: [],
      frozen: { ids: [], scores: [] },
      nextOffset: 0,
      hasMore: false,
    })
    const searched = await call('search', { query: 'x' }, readOnly)
    expect(searched.isError).toBeFalsy()

    const written = await call(
      'remember',
      { memoryType: 'note', topic: 'x', content: 'y' },
      readOnly,
    )
    expect(written.isError).toBe(true)
    expect(written.content[0]).toMatchObject({
      text: expect.stringContaining('insufficient scope'),
    })
    expect(remember).not.toHaveBeenCalled()
  })

  it('a read-only token is rejected on revise (write-scoped) before core', async () => {
    const readOnly = ctx({ scopes: ['memory:read'] })
    const result = await call(
      'revise',
      {
        memoryType: 'note',
        topic: 'x',
        content: 'y',
        predecessorId: MEMO_ID,
        edgeIntent: 'supersedes',
      },
      readOnly,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('insufficient scope') })
    expect(revise).not.toHaveBeenCalled()
  })

  it('a read-only token is rejected on resolve (write-scoped) before core', async () => {
    const readOnly = ctx({ scopes: ['memory:read'] })
    const result = await call('resolve', { memoryId: MEMO_ID, status: 'resolved' }, readOnly)
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('insufficient scope') })
    expect(resolveByMemoryId).not.toHaveBeenCalled()
  })

  it('every write tool declares the write scope', () => {
    for (const name of ['remember', 'revise', 'resolve']) {
      expect(toolByName(name).requiredScope).toBe('memory:write')
    }
  })

  it('briefing, handoff, and get_memories are read-scoped: a read-only token can call them', async () => {
    for (const name of ['briefing', 'handoff', 'get_memories']) {
      expect(toolByName(name).requiredScope).toBe('memory:read')
    }
    const readOnly = ctx({ scopes: ['memory:read'] })
    briefing.mockResolvedValue({
      selector: { kind: 'all' },
      mode: 'brief',
      generatedAt: '2026-06-06T00:00:00.000Z',
      commitments: { count: 0, items: [], hasMore: false },
      overdue: { count: 0, items: [], hasMore: false },
      blockers: { count: 0, items: [], hasMore: false },
      staleCandidates: { count: 0, items: [], hasMore: false },
      recentDecisions: { count: 0, items: [], hasMore: false },
      preferences: { count: 0, items: [], hasMore: false },
    })
    const result = await call('briefing', { selector: { kind: 'all' } }, readOnly)
    expect(result.isError).toBeFalsy()
  })

  it('a write-scoped token can do both', async () => {
    const full = ctx({ scopes: ['memory:read', 'memory:write'] })
    remember.mockResolvedValue({ id: MEMO_ID, embed: { settled: Promise.resolve(false) } })
    searchDashboardPage.mockResolvedValue({
      hits: [],
      frozen: { ids: [], scores: [] },
      nextOffset: 0,
      hasMore: false,
    })
    expect(
      (await call('remember', { memoryType: 'note', topic: 'x', content: 'y' }, full)).isError,
    ).toBeFalsy()
    expect((await call('search', { query: 'x' }, full)).isError).toBeFalsy()
  })

  it('FAILS CLOSED: a scopeless token reaches no tool', async () => {
    const none = ctx({ scopes: [] })
    const searched = await call('search', { query: 'x' }, none)
    expect(searched.isError).toBe(true)
    expect(searched.content[0]).toMatchObject({
      text: expect.stringContaining('insufficient scope'),
    })
    expect(searchDashboardPage).not.toHaveBeenCalled()

    const written = await call('remember', { memoryType: 'note', topic: 'x', content: 'y' }, none)
    expect(written.isError).toBe(true)
    expect(remember).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// D3 admin tools: configure_scope, describe_environment, review_proposals.
// ===========================================================================

const SCOPE_ID = crypto.randomUUID()
function scopeRecord(name: string, aliases: string[] = []) {
  return { id: SCOPE_ID, name, aliases, createdAt: new Date('2026-01-01T00:00:00.000Z') }
}
const PROPOSAL_ID = crypto.randomUUID()
const FACT_PROPOSAL_ID = '019fecaa-0000-7000-8000-0000000000f1'

function proposalRecord(status = 'proposed') {
  return {
    id: PROPOSAL_ID,
    fromId: crypto.randomUUID(),
    toId: crypto.randomUUID(),
    edgeType: 'supersedes',
    memoryType: 'fact',
    similarity: 0.91,
    rationale: null,
    status,
    decidedAt:
      status === 'rejected' || status === 'applied' ? new Date('2026-02-01T00:00:00.000Z') : null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
}

/** A core fact-proposal record (Dates, as the db layer returns them). */
function factProposalRecord(status = 'proposed') {
  return {
    id: FACT_PROPOSAL_ID,
    memoryId: MEMO_ID,
    subject: 'lift.back_squat',
    predicate: 'top_set.weight_kg',
    value: '98',
    memoryType: 'fact',
    confidence: 0.82,
    validFrom: null,
    validTo: null,
    rationale: null,
    status,
    decidedAt:
      status === 'rejected' || status === 'applied' ? new Date('2026-02-01T00:00:00.000Z') : null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
}

describe('configure_scope tool', () => {
  it('list: read-only token validates, calls core, returns schema-valid records', async () => {
    listScopes.mockResolvedValue([scopeRecord('work', ['job'])])
    const result = await call(
      'configure_scope',
      { action: 'list' },
      ctx({ scopes: ['memory:read'] }),
    )
    expect(result.isError).toBeFalsy()
    const parsed = configureScopeOutputV2Schema.parse(result.structuredContent)
    expect(parsed.action).toBe('list')
    if (parsed.action === 'list') {
      expect(parsed.count).toBe(1)
      expect(parsed.scopes[0]?.name).toBe('work')
    }
    expect(listScopes).toHaveBeenCalledWith(UID)
  })

  it('create: write token round-trips, echoes the upserted record', async () => {
    createScope.mockResolvedValue(scopeRecord('research', ['r']))
    const result = await call(
      'configure_scope',
      { action: 'create', name: 'research', aliases: ['r'] },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    const parsed = configureScopeOutputV2Schema.parse(result.structuredContent)
    expect(parsed.action).toBe('upserted')
    if (parsed.action === 'upserted') expect(parsed.scope.name).toBe('research')
    expect(createScope).toHaveBeenCalledWith(UID, 'research', ['r'])
  })

  it('rename / set_aliases / delete dispatch to the right core fn', async () => {
    renameScope.mockResolvedValue(scopeRecord('renamed'))
    setScopeAliases.mockResolvedValue(scopeRecord('work', ['alias']))
    deleteScope.mockResolvedValue(undefined)

    await call('configure_scope', { action: 'rename', name: 'work', newName: 'renamed' }, ctx())
    expect(renameScope).toHaveBeenCalledWith(UID, 'work', 'renamed')

    await call(
      'configure_scope',
      { action: 'set_aliases', name: 'work', aliases: ['alias'] },
      ctx(),
    )
    expect(setScopeAliases).toHaveBeenCalledWith(UID, 'work', ['alias'])

    const deleted = await call('configure_scope', { action: 'delete', name: 'work' }, ctx())
    expect(deleteScope).toHaveBeenCalledWith(UID, 'work')
    const parsed = configureScopeOutputV2Schema.parse(deleted.structuredContent)
    expect(parsed.action).toBe('deleted')
    if (parsed.action === 'deleted') expect(parsed.name).toBe('work')
  })

  it('TWO-LAYER SCOPE: a read-only token may list but NOT mutate (handler write-gate)', async () => {
    // Layer 1 (registry floor): read passes, so the handler runs. Layer 2 (handler
    // write-gate): a mutating action with only memory:read is rejected BEFORE core.
    const readOnly = ctx({ scopes: ['memory:read'] })
    for (const args of [
      { action: 'create', name: 'x' },
      { action: 'rename', name: 'x', newName: 'y' },
      { action: 'set_aliases', name: 'x', aliases: ['a'] },
      { action: 'delete', name: 'x' },
    ]) {
      const result = await call('configure_scope', args, readOnly)
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('insufficient scope')
    }
    expect(createScope).not.toHaveBeenCalled()
    expect(renameScope).not.toHaveBeenCalled()
    expect(setScopeAliases).not.toHaveBeenCalled()
    expect(deleteScope).not.toHaveBeenCalled()
  })

  it('anyOf FLOOR: a WRITE-ONLY token passes the floor and CAN mutate', async () => {
    // Regression: with a single memory:read floor, runTool rejected a write-only
    // token BEFORE the handler's write-gate could admit the mutation. The anyOf
    // floor admits read OR write, so the handler runs and the write succeeds.
    createScope.mockResolvedValue(scopeRecord('research', ['r']))
    const writeOnly = ctx({ scopes: ['memory:write'] })
    const result = await call(
      'configure_scope',
      { action: 'create', name: 'research', aliases: ['r'] },
      writeOnly,
    )
    expect(result.isError).toBeFalsy()
    expect(createScope).toHaveBeenCalledWith(UID, 'research', ['r'])
  })

  it('list: an edge-only tenant gets NO factProposals key (byte-stable V1 response)', async () => {
    listAllProposals.mockResolvedValue({ proposals: [proposalRecord()], factProposals: [] })
    const result = await call(
      'review_proposals',
      { action: 'list' },
      ctx({ scopes: ['memory:read'] }),
    )

    // KEY ABSENCE, not `undefined`: a tenant with no fact proposals must see
    // the response it always saw, with no new field appearing at all.
    const structured = result.structuredContent as Record<string, unknown>
    expect('factProposals' in structured).toBe(false)
    expect(Object.keys(structured).sort()).toEqual(['action', 'count', 'proposals'])
  })

  it('list: surfaces fact proposals alongside edge ones, count stays the edge count', async () => {
    listAllProposals.mockResolvedValue({
      proposals: [proposalRecord()],
      factProposals: [factProposalRecord()],
    })
    const result = await call(
      'review_proposals',
      { action: 'list' },
      ctx({ scopes: ['memory:read'] }),
    )

    expect(result.isError).toBeFalsy()
    const parsed = reviewProposalsOutputV2Schema.parse(result.structuredContent)
    expect(parsed.action).toBe('list')
    if (parsed.action === 'list') {
      expect(parsed.factProposals?.[0]?.subject).toBe('lift.back_squat')
      // `count` is the shipped edge count, unchanged by the new list.
      expect(parsed.count).toBe(1)
      // Dates cross the transport as ISO strings.
      expect(parsed.factProposals?.[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z')
      expect(parsed.factProposals?.[0]?.validFrom).toBeNull()
    }
  })

  it('reject: a fact proposal returns the rejected_fact variant', async () => {
    rejectProposalAnyKind.mockResolvedValue({
      kind: 'fact',
      proposal: factProposalRecord('rejected'),
    })
    const result = await call(
      'review_proposals',
      { action: 'reject', proposalId: FACT_PROPOSAL_ID },
      ctx(),
    )

    expect(result.isError).toBeFalsy()
    const parsed = reviewProposalsOutputV2Schema.parse(result.structuredContent)
    // A DISTINCT literal: a client matching on `rejected` keeps getting the
    // edge payload it was written against.
    expect(parsed.action).toBe('rejected_fact')
    if (parsed.action === 'rejected_fact') {
      expect(parsed.proposal.status).toBe('rejected')
      expect(parsed.proposal.decidedAt).toBe('2026-02-01T00:00:00.000Z')
    }
  })

  it('accept: a fact proposal returns applied_fact with the materialized factId', async () => {
    const factId = crypto.randomUUID()
    acceptProposalAnyKind.mockResolvedValue({
      kind: 'fact_applied',
      proposal: factProposalRecord('applied'),
      factId,
    })
    const result = await call(
      'review_proposals',
      { action: 'accept', proposalId: FACT_PROPOSAL_ID },
      ctx(),
    )

    expect(result.isError).toBeFalsy()
    const parsed = reviewProposalsOutputV2Schema.parse(result.structuredContent)
    expect(parsed.action).toBe('applied_fact')
    if (parsed.action === 'applied_fact') {
      // The reviewer learns what was written without a second call.
      expect(parsed.factId).toBe(factId)
      expect(parsed.proposal.status).toBe('applied')
    }
    expect(acceptProposalAnyKind).toHaveBeenCalledWith(UID, FACT_PROPOSAL_ID, 'user_mcp')
  })

  it('the input contract is unchanged: accept/reject still take a bare proposalId', async () => {
    // Ids are uuidv7 and disjoint across both tables, so the id alone says
    // which kind it is — naming the kind must stay unnecessary AND rejected.
    const result = await call(
      'review_proposals',
      { action: 'accept', proposalId: FACT_PROPOSAL_ID, kind: 'fact' },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect(acceptProposalAnyKind).not.toHaveBeenCalled()
  })

  it('anyOf FLOOR: a WRITE-ONLY token CANNOT list (handler read-gate)', async () => {
    // The floor admits the write-only token, but list needs the EXACT read scope,
    // so the handler rejects it before core.
    const writeOnly = ctx({ scopes: ['memory:write'] })
    const result = await call('configure_scope', { action: 'list' }, writeOnly)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('insufficient scope')
    expect(listScopes).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED: a scopeless token is rejected at the registry floor (layer 1)', async () => {
    const none = ctx({ scopes: [] })
    const result = await call('configure_scope', { action: 'list' }, none)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('insufficient scope')
    expect(listScopes).not.toHaveBeenCalled()
    // A mutating action is likewise rejected at the floor (no listed scope held).
    const mutate = await call('configure_scope', { action: 'create', name: 'x' }, none)
    expect(mutate.isError).toBe(true)
    expect(createScope).not.toHaveBeenCalled()
  })

  it('rejects an unknown action without calling core', async () => {
    const result = await call('configure_scope', { action: 'nuke', name: 'x' }, ctx())
    expect(result.isError).toBe(true)
    expect(deleteScope).not.toHaveBeenCalled()
  })

  it('rejects a malformed scope name (not kebab-case) without calling core', async () => {
    const result = await call('configure_scope', { action: 'create', name: 'Bad Name' }, ctx())
    expect(result.isError).toBe(true)
    expect(createScope).not.toHaveBeenCalled()
  })

  it('maps a name conflict to a typed conflict naming the scope only', async () => {
    createScope.mockRejectedValue(new ScopeNameConflictError('work'))
    const result = await call('configure_scope', { action: 'create', name: 'work' }, ctx())
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('conflict')
    expect(text).toContain('work')
  })

  it('maps a missing scope to not_found', async () => {
    renameScope.mockRejectedValue(new ScopeNotFoundError('ghost'))
    const result = await call(
      'configure_scope',
      { action: 'rename', name: 'ghost', newName: 'x' },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('not_found')
  })
})

describe('describe_environment tool', () => {
  it('reports capabilities (tool names/count), scopes, and bounded stats', async () => {
    describeEnvironment.mockResolvedValue({
      scopes: [scopeRecord('work')],
      retrievalScopePolicy: { mode: 'off', scope: null },
      stats: {
        memoriesByType: { decision: 3, fact: 5 },
        activeMemories: 8,
        supersededMemories: 2,
        archivedMemories: 1,
        commitmentsByStatus: { open: 1, resolved: 4 },
      },
    })
    const result = await call('describe_environment', {}, ctx({ scopes: ['memory:read'] }))
    expect(result.isError).toBeFalsy()
    const parsed = describeEnvironmentOutputV2Schema.parse(result.structuredContent)
    // Capabilities reflect the FULL registry (merged surface: 11 tools, names included).
    expect(parsed.capabilities.toolCount).toBe(11)
    expect(parsed.capabilities.tools).toContain('describe_environment')
    expect(parsed.capabilities.tools.length).toBe(parsed.capabilities.toolCount)
    // Derives from apps/server/package.json (see src/version.ts), so this
    // tracks the package version automatically and never asserts a stale literal.
    expect(parsed.capabilities.version).toBe(SERVER_VERSION)
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(parsed.scopes[0]?.name).toBe('work')
    expect(parsed.stats.activeMemories).toBe(8)
    expect(parsed.stats.supersededMemories).toBe(2)
    expect(parsed.stats.archivedMemories).toBe(1)
    expect(parsed.stats.commitmentsByStatus.resolved).toBe(4)
  })

  it('REDACTION: the response never carries a configured secret (sentinel)', async () => {
    // A sentinel secret placed in the environment must NOT appear anywhere in the
    // describe_environment response (hard rule 6). The tool reports counts/names
    // only — it reads no env/DSN/key — so the secret is structurally absent.
    const SENTINEL = `super-secret-${crypto.randomUUID()}`
    process.env.DATABASE_URL = `postgres://user:${SENTINEL}@host/db`
    process.env.OAUTH_PRIVATE_KEYS = SENTINEL
    try {
      describeEnvironment.mockResolvedValue({
        scopes: [scopeRecord('work')],
        retrievalScopePolicy: { mode: 'off', scope: null },
        stats: {
          memoriesByType: {},
          activeMemories: 0,
          supersededMemories: 0,
          archivedMemories: 0,
          commitmentsByStatus: {},
        },
      })
      const result = await call('describe_environment', {}, ctx({ scopes: ['memory:read'] }))
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(SENTINEL)
    } finally {
      delete process.env.DATABASE_URL
      delete process.env.OAUTH_PRIVATE_KEYS
    }
  })

  it('rejects a request carrying any parameter (strict empty input)', async () => {
    const result = await call('describe_environment', { verbose: true }, ctx())
    expect(result.isError).toBe(true)
    expect(describeEnvironment).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED: a scopeless token reaches no environment report', async () => {
    const result = await call('describe_environment', {}, ctx({ scopes: [] }))
    expect(result.isError).toBe(true)
    expect(describeEnvironment).not.toHaveBeenCalled()
  })
})

describe('review_proposals tool', () => {
  it('list: read-only token returns bounded schema-valid records', async () => {
    listAllProposals.mockResolvedValue({ proposals: [proposalRecord()], factProposals: [] })
    const result = await call(
      'review_proposals',
      { action: 'list' },
      ctx({ scopes: ['memory:read'] }),
    )
    expect(result.isError).toBeFalsy()
    const parsed = reviewProposalsOutputV2Schema.parse(result.structuredContent)
    expect(parsed.action).toBe('list')
    if (parsed.action === 'list') {
      expect(parsed.count).toBe(1)
      expect(parsed.proposals[0]?.status).toBe('proposed')
    }
    // The schema default limit is forwarded (no-firehose).
    expect(listAllProposals.mock.calls[0]?.[1]).toMatchObject({ limit: 25 })
  })

  it('list: forwards a status filter and a caller limit', async () => {
    listAllProposals.mockResolvedValue({ proposals: [], factProposals: [] })
    await call(
      'review_proposals',
      { action: 'list', status: 'rejected', limit: 10 },
      ctx({ scopes: ['memory:read'] }),
    )
    expect(listAllProposals.mock.calls[0]?.[1]).toMatchObject({ status: 'rejected', limit: 10 })
  })

  it('reject: write token transitions and echoes the updated record', async () => {
    rejectProposalAnyKind.mockResolvedValue({ kind: 'edge', proposal: proposalRecord('rejected') })
    const result = await call(
      'review_proposals',
      { action: 'reject', proposalId: PROPOSAL_ID },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    const parsed = reviewProposalsOutputV2Schema.parse(result.structuredContent)
    expect(parsed.action).toBe('rejected')
    if (parsed.action === 'rejected') expect(parsed.proposal.status).toBe('rejected')
    expect(rejectProposalAnyKind).toHaveBeenCalledWith(UID, PROPOSAL_ID)
  })

  it('accept: write token applies the proposal and echoes the applied record', async () => {
    acceptProposalAnyKind.mockResolvedValue({
      kind: 'edge_applied',
      proposal: proposalRecord('applied'),
    })
    const result = await call(
      'review_proposals',
      { action: 'accept', proposalId: PROPOSAL_ID },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    const parsed = reviewProposalsOutputV2Schema.parse(result.structuredContent)
    expect(parsed.action).toBe('applied')
    if (parsed.action === 'applied') expect(parsed.proposal.status).toBe('applied')
    // The MCP transport stamps its actor class on the apply.
    expect(acceptProposalAnyKind).toHaveBeenCalledWith(UID, PROPOSAL_ID, 'user_mcp')
  })

  it('accept: maps a missing/already-decided proposal to not_found', async () => {
    acceptProposalAnyKind.mockRejectedValue(new ProposalNotFoundError(PROPOSAL_ID))
    const result = await call(
      'review_proposals',
      { action: 'accept', proposalId: PROPOSAL_ID },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('not_found')
  })

  it('accept: maps an event-type supersession refusal to conflict (docs/concepts/memory-model.mdx "Consolidation is advisory")', async () => {
    acceptProposalAnyKind.mockRejectedValue(new EpisodicSupersessionError(PROPOSAL_ID, 'event'))
    const result = await call(
      'review_proposals',
      { action: 'accept', proposalId: PROPOSAL_ID },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('conflict')
  })

  it('accept: maps a stale (no-longer-live) successor refusal to conflict', async () => {
    acceptProposalAnyKind.mockRejectedValue(new SuccessorNotLiveError(PROPOSAL_ID, MEMO_ID))
    const result = await call(
      'review_proposals',
      { action: 'accept', proposalId: PROPOSAL_ID },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('conflict')
  })

  it('anyOf FLOOR: a WRITE-ONLY token passes the floor and CAN reject', async () => {
    rejectProposalAnyKind.mockResolvedValue({ kind: 'edge', proposal: proposalRecord('rejected') })
    const writeOnly = ctx({ scopes: ['memory:write'] })
    const result = await call(
      'review_proposals',
      { action: 'reject', proposalId: PROPOSAL_ID },
      writeOnly,
    )
    expect(result.isError).toBeFalsy()
    expect(rejectProposalAnyKind).toHaveBeenCalledWith(UID, PROPOSAL_ID)
  })

  it('anyOf FLOOR: a WRITE-ONLY token CANNOT list (handler read-gate)', async () => {
    const writeOnly = ctx({ scopes: ['memory:write'] })
    const result = await call('review_proposals', { action: 'list' }, writeOnly)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('insufficient scope')
    expect(listAllProposals).not.toHaveBeenCalled()
  })

  it('TWO-LAYER SCOPE: a read-only token may list but NOT reject/accept', async () => {
    const readOnly = ctx({ scopes: ['memory:read'] })
    const rejected = await call(
      'review_proposals',
      { action: 'reject', proposalId: PROPOSAL_ID },
      readOnly,
    )
    expect(rejected.isError).toBe(true)
    expect((rejected.content[0] as { text: string }).text).toContain('insufficient scope')
    const accepted = await call(
      'review_proposals',
      { action: 'accept', proposalId: PROPOSAL_ID },
      readOnly,
    )
    expect(accepted.isError).toBe(true)
    expect((accepted.content[0] as { text: string }).text).toContain('insufficient scope')
    expect(rejectProposalAnyKind).not.toHaveBeenCalled()
    expect(acceptProposalAnyKind).not.toHaveBeenCalled()
  })

  it('maps a missing/already-decided proposal to not_found', async () => {
    rejectProposalAnyKind.mockRejectedValue(new ProposalNotFoundError(PROPOSAL_ID))
    const result = await call(
      'review_proposals',
      { action: 'reject', proposalId: PROPOSAL_ID },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('not_found')
  })

  it('rejects a non-uuid proposalId without calling core', async () => {
    const result = await call('review_proposals', { action: 'reject', proposalId: 'nope' }, ctx())
    expect(result.isError).toBe(true)
    expect(rejectProposalAnyKind).not.toHaveBeenCalled()
  })
})

describe('D3 admin tools: registry scope declarations', () => {
  it('the per-action tools declare an anyOf read|write floor (write-only is admitted)', () => {
    for (const name of ['configure_scope', 'review_proposals']) {
      expect(toolByName(name).requiredScope).toEqual({
        anyOf: ['memory:read', 'memory:write'],
      })
    }
  })

  it('describe_environment is read-only: a single memory:read floor', () => {
    expect(toolByName('describe_environment').requiredScope).toBe('memory:read')
  })
})

describe('get_memories tool (batched full-content follow-up read)', () => {
  const rowId = crypto.randomUUID()
  const coreRow = (over: Record<string, unknown> = {}) => ({
    id: rowId,
    memoryType: 'decision',
    topic: 'release cadence',
    content: 'full decision body',
    contentLength: 18,
    truncated: false,
    scope: 'work',
    project: null,
    status: 'active',
    commitmentStatus: null,
    tags: ['ops'],
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: null,
    recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    ...over,
  })

  it('passes validated ids + maxContentChars to core and shapes schema-valid output', async () => {
    getMemoriesByIds.mockResolvedValue({ memories: [coreRow()], notFound: [MEMO_ID] })
    const result = await call(
      'get_memories',
      { ids: [rowId, MEMO_ID], maxContentChars: 4096 },
      ctx({ scopes: ['memory:read'] }),
    )
    expect(result.isError).toBeFalsy()
    expect(getMemoriesByIds).toHaveBeenCalledWith(UID, [rowId, MEMO_ID], {
      maxContentChars: 4096,
    })
    const parsed = getMemoriesOutputSchema.parse(result.structuredContent)
    expect(parsed.count).toBe(1)
    expect(parsed.memories[0]?.id).toBe(rowId)
    expect(parsed.memories[0]?.validFrom).toBe('2026-01-01T00:00:00.000Z')
    // A null LEFT-JOIN commitment status is OMITTED (schema optional), never null.
    expect(parsed.memories[0]).not.toHaveProperty('commitmentStatus')
    // notFound is DATA: the miss rides in the envelope, the call still succeeds.
    expect(parsed.notFound).toEqual([MEMO_ID])
  })

  it('carries commitmentStatus for a commitment-type row', async () => {
    getMemoriesByIds.mockResolvedValue({
      memories: [coreRow({ memoryType: 'commitment', commitmentStatus: 'open' })],
      notFound: [],
    })
    const result = await call('get_memories', { ids: [rowId] }, ctx())
    const parsed = getMemoriesOutputSchema.parse(result.structuredContent)
    expect(parsed.memories[0]?.commitmentStatus).toBe('open')
  })

  it('applies the schema default maxContentChars when omitted', async () => {
    getMemoriesByIds.mockResolvedValue({ memories: [], notFound: [rowId] })
    await call('get_memories', { ids: [rowId] }, ctx())
    expect(getMemoriesByIds).toHaveBeenCalledWith(UID, [rowId], { maxContentChars: 10000 })
  })

  it('rejects bad batches at the boundary: empty ids, >20 ids, out-of-range cap, unknown key', async () => {
    for (const args of [
      { ids: [] },
      { ids: Array.from({ length: 21 }, () => crypto.randomUUID()) },
      { ids: [rowId], maxContentChars: 199 },
      { ids: [rowId], maxContentChars: 65537 },
      { ids: [rowId], scope: 'work' },
      { ids: ['not-a-uuid'] },
    ]) {
      expect((await call('get_memories', args, ctx())).isError).toBe(true)
    }
    expect(getMemoriesByIds).not.toHaveBeenCalled()
  })
})

// ACCESS GATE ENFORCEMENT: the orientation + admin tools that read or mutate
// tenant-memory data now assert ctx.access AFTER the scope check but BEFORE the
// core op. A denying gate must reject (isError access_denied) AND the core fn must
// NEVER be reached. ctx() carries both scopes, so the scope floor passes and the
// gate is what rejects. A true no-op under allow-all (the other tool tests wire no
// access gate, the back-compat proof).
describe('access gate enforcement: orientation + admin tools (#429)', () => {
  // Denies BOTH read and write.
  const denyingAccess = {
    assertRead: async () => {
      throw new AccessDeniedError('read')
    },
    assertWrite: async () => {
      throw new AccessDeniedError('write')
    },
  }
  const denyingCtx = () => ctx({ access: denyingAccess as unknown as ToolContext['access'] })

  // [tool, args, access, core spy] — every memory read (assertRead) and
  // write (assertWrite) on the orientation + admin surface.
  const GATED: Array<[string, unknown, 'read' | 'write', ReturnType<typeof vi.fn>]> = [
    ['briefing', { selector: { kind: 'all' } }, 'read', briefing],
    ['handoff', { selector: { kind: 'all' } }, 'read', handoff],
    ['get_memories', { ids: [MEMO_ID] }, 'read', getMemoriesByIds],
    ['describe_environment', {}, 'read', describeEnvironment],
    ['configure_scope', { action: 'list' }, 'read', listScopes],
    ['configure_scope', { action: 'create', name: 'work' }, 'write', createScope],
    ['review_proposals', { action: 'list' }, 'read', listProposals],
    ['review_proposals', { action: 'reject', proposalId: MEMO_ID }, 'write', rejectProposal],
  ]

  it.each(
    GATED,
  )('denies %s (%o) as a %s and never reaches core', async (tool, args, _access, coreSpy) => {
    const result = await call(tool, args, denyingCtx())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('access_denied')
    // The gate blocked BEFORE the db op — core was never invoked.
    expect(coreSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Retrieval-scope policy wiring (issue #47, layer 3)
// ---------------------------------------------------------------------------

describe('retrieval-scope policy wiring', () => {
  const DEFAULT_WORK = { mode: 'default', defaultScope: 'work' } as const
  /** A request-scoped resolver thunk mirroring routes/mcp.ts lazyRetrievalPolicy. */
  const policyThunk = (policy: unknown) => vi.fn(() => Promise.resolve(policy))
  const emptySection = { count: 0, items: [], hasMore: false }

  it('configure_scope set_retrieval_default stores the policy and echoes it', async () => {
    setRetrievalDefault.mockResolvedValue({ mode: 'default', scope: 'work' })
    const result = await call(
      'configure_scope',
      { action: 'set_retrieval_default', scope: 'work', mode: 'default' },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    const parsed = configureScopeOutputV2Schema.parse(result.structuredContent)
    expect(parsed).toEqual({
      action: 'retrieval_default_set',
      policy: { mode: 'default', scope: 'work' },
    })
    expect(setRetrievalDefault).toHaveBeenCalledWith(UID, { mode: 'default', scope: 'work' })
  })

  it('set_retrieval_default is a WRITE action: a read-only token is rejected', async () => {
    const result = await call(
      'configure_scope',
      { action: 'set_retrieval_default', scope: null, mode: 'require' },
      ctx({ scopes: ['memory:read'] }),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('memory:write')
    expect(setRetrievalDefault).not.toHaveBeenCalled()
  })

  it('rejects a drifting mode/scope pair at the boundary — core never runs', async () => {
    for (const args of [
      { action: 'set_retrieval_default', scope: null, mode: 'default' },
      { action: 'set_retrieval_default', scope: 'work', mode: 'off' },
      { action: 'set_retrieval_default', mode: 'require' },
    ]) {
      const result = await call('configure_scope', args, ctx())
      expect(result.isError).toBe(true)
    }
    expect(setRetrievalDefault).not.toHaveBeenCalled()
  })

  it('an UNREGISTERED default scope maps to the typed not_found', async () => {
    setRetrievalDefault.mockRejectedValue(new ScopeNotFoundError('nope'))
    const result = await call(
      'configure_scope',
      { action: 'set_retrieval_default', scope: 'nope', mode: 'default' },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('not_found')
  })

  it('describe_environment reports the active policy', async () => {
    describeEnvironment.mockResolvedValue({
      scopes: [scopeRecord('work')],
      retrievalScopePolicy: { mode: 'default', scope: 'work' },
      stats: {
        memoriesByType: {},
        activeMemories: 0,
        supersededMemories: 0,
        archivedMemories: 0,
        commitmentsByStatus: {},
      },
    })
    const result = await call('describe_environment', {}, ctx({ scopes: ['memory:read'] }))
    expect(result.isError).toBeFalsy()
    const parsed = describeEnvironmentOutputV2Schema.parse(result.structuredContent)
    expect(parsed.retrievalScopePolicy).toEqual({ mode: 'default', scope: 'work' })
  })

  it('search: resolves the policy AT MOST ONCE, injects it, and echoes appliedScope', async () => {
    const thunk = policyThunk(DEFAULT_WORK)
    searchDashboardPage.mockResolvedValue({
      hits: [],
      frozen: { ids: [], scores: [] },
      nextOffset: 0,
      hasMore: false,
      appliedScope: 'work',
    })
    const result = await call('search', { query: 'q' }, ctx({ retrievalPolicy: thunk }))
    expect(result.isError).toBeFalsy()
    expect(thunk).toHaveBeenCalledTimes(1)
    expect(searchDashboardPage.mock.calls[0]?.[3]).toMatchObject({ retrievalPolicy: DEFAULT_WORK })
    expect((result.structuredContent as { appliedScope?: string }).appliedScope).toBe('work')
  })

  it('search: asserts read access before resolving policy', async () => {
    const order: string[] = []
    const access = {
      assertRead: vi.fn(async () => {
        order.push('access')
      }),
      assertWrite: vi.fn(),
    }
    const thunk = vi.fn(async () => {
      order.push('policy')
      return DEFAULT_WORK
    })
    searchDashboardPage.mockImplementation(async () => {
      order.push('search')
      return {
        hits: [],
        frozen: { ids: [], scores: [] },
        nextOffset: 0,
        hasMore: false,
        appliedScope: 'work',
      }
    })

    await call(
      'search',
      { query: 'q' },
      ctx({ access: access as unknown as ToolContext['access'], retrievalPolicy: thunk }),
    )

    expect(order).toEqual(['access', 'policy', 'search'])
    expect(searchDashboardPage.mock.calls[0]?.[3]).not.toHaveProperty('access')
  })

  it('search: no policy narrowing -> NO appliedScope key (byte-identical legacy)', async () => {
    searchDashboardPage.mockResolvedValue({
      hits: [],
      frozen: { ids: [], scores: [] },
      nextOffset: 0,
      hasMore: false,
      appliedScope: null,
    })
    const result = await call(
      'search',
      { query: 'q' },
      ctx({ retrievalPolicy: policyThunk({ mode: 'off' }) }),
    )
    expect(result.isError).toBeFalsy()
    expect('appliedScope' in (result.structuredContent as object)).toBe(false)
  })

  it('search: an UnscopedRetrievalError surfaces typed, naming the registered scopes', async () => {
    searchDashboardPage.mockRejectedValue(new UnscopedRetrievalError(['personal', 'work']))
    const result = await call(
      'search',
      { query: 'q' },
      ctx({
        retrievalPolicy: policyThunk({ mode: 'require', registeredScopes: ['personal', 'work'] }),
      }),
    )
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('invalid input')
    expect(text).toContain('personal, work')
  })

  it('search: bounds the registered-scope recovery payload', async () => {
    const registeredScopes = Array.from({ length: 100 }, (_, index) => `scope-${index}`)
    searchDashboardPage.mockRejectedValue(new UnscopedRetrievalError(registeredScopes))

    const result = await call(
      'search',
      { query: 'q' },
      ctx({ retrievalPolicy: policyThunk({ mode: 'require', registeredScopes }) }),
    )

    const text = (result.content[0] as { text: string }).text
    expect(text.length).toBeLessThanOrEqual(527)
    expect(text).toContain('+92 more omitted')
  })

  it('briefing and handoff: the policy is injected and appliedScope rides the output', async () => {
    const thunk = policyThunk(DEFAULT_WORK)
    briefing.mockResolvedValue({
      selector: { kind: 'scope', scope: 'work' },
      mode: 'brief',
      generatedAt: '2026-08-04T00:00:00.000Z',
      appliedScope: 'work',
      commitments: emptySection,
      overdue: emptySection,
      blockers: emptySection,
      staleCandidates: emptySection,
      recentDecisions: emptySection,
      preferences: emptySection,
    })
    const briefed = await call(
      'briefing',
      { selector: { kind: 'all' } },
      ctx({ retrievalPolicy: thunk }),
    )
    expect(briefed.isError).toBeFalsy()
    expect(briefing.mock.calls[0]?.[1]).toMatchObject({ retrievalPolicy: DEFAULT_WORK })
    expect((briefed.structuredContent as { appliedScope?: string }).appliedScope).toBe('work')

    handoff.mockResolvedValue({
      selector: { kind: 'scope', scope: 'work' },
      generatedFor: null,
      generatedAt: '2026-08-04T00:00:00.000Z',
      appliedScope: 'work',
      decisions: [],
      commitments: [],
      preferences: [],
      notes: [],
      counts: { decisions: 0, commitments: 0, preferences: 0 },
      truncated: { decisions: false, commitments: false, preferences: false },
    })
    const handed = await call(
      'handoff',
      { selector: { kind: 'all' } },
      ctx({ retrievalPolicy: policyThunk(DEFAULT_WORK) }),
    )
    expect(handed.isError).toBeFalsy()
    expect(handoff.mock.calls[0]?.[1]).toMatchObject({ retrievalPolicy: DEFAULT_WORK })
    expect((handed.structuredContent as { appliedScope?: string }).appliedScope).toBe('work')
  })
})
