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
import {
  applyPolicyToScopeFilter,
  type RetrievalPolicy,
  type SearchHit,
  searchChronological,
  searchDashboardPage,
} from '@3ngram/core'
import { MEMORY_READ_SCOPE } from '@3ngram/core/auth'
import {
  type AsOfInput,
  type SearchProjection,
  type SearchQueryV3Input,
  type SearchQueryV4ChronologicalInput,
  type SearchQueryV4Input,
  searchQueryV4Schema,
  searchToolOutputV3Schema,
} from '@3ngram/schema'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { decodeSearchCursor, encodeCursor, searchFingerprint } from '../cursor.js'
import { parseOutput } from '../output-validation.js'
import { READ_ONLY_ANNOTATIONS } from './tool-annotations.js'
import type { ToolContext, ToolDefinition } from './tools.js'

/**
 * Wrap a structured payload as a tool success result (text mirror + structured).
 * The mirror is deliberate and load-bearing: see the `ok` doc comment in
 * tools.ts for why it cannot be dropped and what the >2x duplication costs
 * (issue #75).
 */
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
 * The candidate-narrowing filter fields shared by every V4 order branch
 * (relevance and chronological alike — both compose the SAME V1+V2 filter
 * axes, see search-list.ts). Typed as a slice of {@link SearchQueryV3Input}
 * rather than the specific V4 variant so `toFilters` works unchanged for
 * either branch of the `order` union.
 */
type FilterableInput = Pick<
  SearchQueryV3Input,
  | 'memoryType'
  | 'memoryTypes'
  | 'scope'
  | 'project'
  | 'status'
  | 'asOf'
  | 'recordedAfter'
  | 'recordedBefore'
>

/**
 * Candidate-narrowing filters: validated at the schema boundary, threaded
 * verbatim to core. defined() strips undefined axes so an absent filter never
 * narrows (exactOptional fit for SearchFilters). V2 axes ride the same object:
 * memoryTypes passes through as-is (the schema already enforced non-empty +
 * mutual exclusion with memoryType); the recorded_at range bounds coerce
 * ISO -> Date here like asOf.
 */
function toFilters(input: FilterableInput) {
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
  const compact = {
    id: hit.id,
    memoryType: hit.memoryType,
    topic: hit.topic,
    score: hit.score,
    superseded: hit.superseded,
  }
  if (projection === 'compact') return compact
  return {
    ...compact,
    content: hit.content,
    contentLength: hit.contentLength,
    truncated: hit.truncated,
  }
}

/** The scope a retrieval-scope policy applied (or would apply) to this call, for fingerprinting and echoing. */
interface PolicyScope {
  scope: string | undefined
  appliedScope: string | null
}

/**
 * Ranked (relevance-order) search: the shipped fused-retrieval path, byte-
 * compatible with the pre-V4 tool behavior. PAGINATION routes through the
 * SAME frozen-ordering machinery the dashboard uses (core searchDashboardPage
 * + the shared ../cursor.js codec): page 1 ranks the bounded candidate pool
 * once and freezes the ordering into `nextCursor`; a continuation pages BY
 * POSITION within it (fetchHitsByIds), immune to duplicate/skip under
 * mid-walk corpus drift. The cursor is BOUND to the query+filters that issued
 * it (the shared codec's fingerprint, verified in decodeSearchCursor): a
 * continuation under a CHANGED query/filters is a typed CursorQueryMismatchError
 * -> invalid_input, never a silent re-page of the old search's frozen
 * ordering. Fingerprint-less cursors minted before the binding stay valid
 * (verify-when-present); the fingerprint computation here is BYTE-IDENTICAL
 * to the pre-V4 tool (no `order` folded in), so a cursor minted before
 * chronological order existed keeps verifying.
 */
async function handleRelevanceSearch(
  input: Extract<SearchQueryV4Input, { order: 'relevance' }>,
  filters: ReturnType<typeof toFilters>,
  policyScope: PolicyScope,
  retrievalPolicy: RetrievalPolicy | undefined,
  ctx: ToolContext,
): Promise<CallToolResult> {
  if (ctx.gateway === undefined) {
    return fail('embedding gateway not configured')
  }
  const fingerprint = searchFingerprint(
    input.query,
    filters,
    policyScope.scope,
    policyScope.appliedScope !== null,
  )
  const decodedRaw =
    input.cursor === undefined ? undefined : decodeSearchCursor(input.cursor, fingerprint)
  // Relevance (ranked) search only ever mints/consumes the v2 frozen-ordering
  // cursor — the v3 chronological keyset cursor belongs to order:
  // 'chronological' only. In PRACTICE a v3 token minted with `fp` is already
  // rejected as a typed mismatch by decodeSearchCursor above (its fingerprint
  // folds in `order: 'chronological'`, which a relevance fingerprint never
  // does, so the hashes can never coincidentally collide) — this shape guard
  // is the fallback for a FINGERPRINT-LESS v3 token (the same
  // verify-when-present carve-out legacy v1 cursors get): without it, `.ids`/
  // `.scores` below would silently read as `undefined` off the wrong shape
  // instead of restarting cleanly at page 1.
  const decoded = decodedRaw !== undefined && decodedRaw.v === 2 ? decodedRaw : undefined
  const frozen =
    decoded === undefined
      ? undefined
      : {
          ids: decoded.ids,
          scores: decoded.scores,
          off: decoded.off,
          ...(decoded.policyScope === undefined ? {} : { policyScope: decoded.policyScope }),
        }
  const page = await searchDashboardPage(
    ctx.userId,
    input.query,
    { gateway: ctx.gateway },
    defined({
      limit: input.limit,
      filters,
      frozen,
      budget: ctx.budget,
      retrievalPolicy,
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
        fp: fingerprint,
        policyScope: page.frozen.policyScope,
      })
    : undefined
  const output = parseOutput(
    'search',
    searchToolOutputV3Schema,
    defined({
      hits: page.hits.map((hit) => projectHit(hit, input.projection)),
      count: page.hits.length,
      hasMore: page.hasMore,
      nextCursor,
      // Present exactly when the policy narrowed this call (never silent);
      // omitted otherwise so an off/no-policy response stays byte-identical.
      appliedScope: page.appliedScope ?? undefined,
    }),
  )
  return ok(output)
}

/**
 * Chronological (list-mode) search: an exhaustive, unranked recorded_at DESC
 * enumeration (packages/core/src/read/search-list.ts). Skips the embedding
 * gateway ENTIRELY — no gateway call, no query-embed cost row — and skips the
 * abstention path by construction: nothing here ever reads `vectorScore`
 * (that field only exists on the ranked path's hits), so there is no cosine
 * signal to abstain on.
 *
 * The v3 keyset cursor (recordedAt, id) is DRIFT-FREE, unlike the ranked
 * path's frozen-pool cursor, so it needs no frozen candidate set — tiny by
 * comparison. Its fingerprint folds `order: 'chronological'` into the hashed
 * filter set, which the ranked path's fingerprint (byte-identical to pre-V4)
 * does NOT do — so a v2 (ranked) cursor carrying `fp`, replayed here, is
 * REJECTED as a typed CursorQueryMismatchError (invalid_input) by
 * decodeSearchCursor, never silently misread. Only a fingerprint-LESS legacy
 * token (pre-binding v2, or a hand-crafted fp-less v3) skips that check and
 * reaches the shape guard below, which restarts at page 1 rather than
 * crashing on the wrong shape.
 */
async function handleChronologicalSearch(
  input: SearchQueryV4ChronologicalInput,
  filters: ReturnType<typeof toFilters>,
  policyScope: PolicyScope,
  retrievalPolicy: RetrievalPolicy | undefined,
  ctx: ToolContext,
): Promise<CallToolResult> {
  const fingerprint = searchFingerprint(
    input.query ?? '',
    { ...filters, order: 'chronological' },
    policyScope.scope,
    policyScope.appliedScope !== null,
  )
  const decodedRaw =
    input.cursor === undefined ? undefined : decodeSearchCursor(input.cursor, fingerprint)
  const decoded = decodedRaw !== undefined && decodedRaw.v === 3 ? decodedRaw : undefined
  const cursor =
    decoded === undefined ? undefined : { recordedAt: new Date(decoded.recordedAt), id: decoded.id }

  const page = await searchChronological(
    ctx.userId,
    defined({
      limit: input.limit,
      filters,
      cursor,
      retrievalPolicy,
    }),
  )
  const nextCursor =
    page.hasMore && page.nextCursor !== undefined
      ? encodeCursor({
          v: 3,
          recordedAt: page.nextCursor.recordedAt.toISOString(),
          id: page.nextCursor.id,
          fp: fingerprint,
        })
      : undefined
  const output = parseOutput(
    'search',
    searchToolOutputV3Schema,
    defined({
      hits: page.hits.map((hit) => projectHit(hit, input.projection)),
      count: page.hits.length,
      hasMore: page.hasMore,
      nextCursor,
      appliedScope: page.appliedScope ?? undefined,
    }),
  )
  return ok(output)
}

/**
 * search — unified fused retrieval (docs/concepts/mcp-design.mdx JTBD "find what I know"),
 * plus an exhaustive chronological list mode. The input contract is the V4
 * composition ({@link searchQueryV4Schema}, hard rule 2): query + limit, the
 * candidate-narrowing filters (V1 memoryType/scope/project/status/asOf + V2
 * memoryTypes[]/recordedAfter/recordedBefore), the continuation pair —
 * `cursor` (opaque token) + `projection` (full/compact) — and `order`
 * (relevance default | chronological). Each filter NARROWS the candidate set
 * BEFORE fusion/ordering; none alters the fusion weights or the supersession
 * ranking (docs/concepts/memory-model.mdx live-first stays the default). The
 * tool registers the FULL `.strict()` object (not its raw shape), so the SDK
 * parses inbound args strictly at the transport boundary and an UNKNOWN key
 * is REJECTED there — never silently dropped.
 *
 * `order: 'relevance'` (default) requires a gateway-configured embedding
 * source and a `query`; `order: 'chronological'` requires NEITHER — it never
 * calls the gateway, and `query` is optional as long as >=1 filter narrows
 * the scan. The two orders mint DIFFERENT cursor shapes (see
 * {@link handleRelevanceSearch} / {@link handleChronologicalSearch}); each
 * rejects/restarts on the other's cursor rather than misreading it.
 */
const searchTool: ToolDefinition = {
  name: 'search',
  requiredScope: MEMORY_READ_SCOPE,
  config: {
    title: 'Search',
    description:
      'Unified semantic + keyword retrieval over your memories, supersession-aware. Accepts a query and an optional result limit, plus optional filters that narrow the candidate set BEFORE fusion (no change to ranking weights): memoryType OR memoryTypes (a list of types, mutually exclusive with memoryType), scope, project, status, asOf (bi-temporal time travel with validAt/asKnownAt), and recordedAfter/recordedBefore (an inclusive recorded-at range over the live view — not time travel). Omit a filter to leave that axis unconstrained. Set order: "chronological" for an exhaustive, unranked recorded_at-descending listing instead of the fused ranking — no embedding call, no gateway required; query then becomes optional PROVIDED at least one filter narrows the set (an unfiltered chronological scan with no query and no filter is rejected — nothing would bound it). Default order "relevance" is the fused ranked search and still requires a query. If a retrieval-scope policy is set (configure_scope set_retrieval_default), an unscoped search may be narrowed to your default scope (the result then reports appliedScope) or rejected until you pass a scope filter. Hit content is a bounded excerpt — when a hit reports truncated: true, call get_memories with its id to read the full content. Superseded predecessors are never filtered out, only ranked below their successor — a hit reports superseded: true when it is one, so you can tell a demoted result from a current one; superseded is recomputed live on every page (including continuations of a frozen relevance walk), so a hit\'s rank and score stay frozen across pages of one walk but its superseded flag can still flip if it is revised mid-session. To page: pass nextCursor back as cursor with the SAME query, filters, and order; pages come from the ordering frozen (relevance) or the keyset position (chronological) on the first page, so a mid-walk write or archive can never duplicate or skip a hit. The cursor is bound to the query, filters, and order that issued it: passing it with any of those changed is rejected as invalid input — omit the cursor to start a new search. The relevance cursor token is a real context cost (~4-6 KB — it carries the frozen ids+scores of the candidate pool); the chronological cursor is tiny (a single row position) by comparison. Paging stops at the frozen pool (relevance) or the live corpus (chronological): hasMore: false means there is nothing more to page to. For broad scans set projection: "compact" to omit content/contentLength/truncated per hit (~5x fewer tokens), then batch-fetch the interesting ids with get_memories.',
    inputSchema: searchQueryV4Schema,
    outputSchema: searchToolOutputV3Schema,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async handler(args, ctx) {
    const input = searchQueryV4Schema.parse(args)
    const filters = toFilters(input)
    // Assert platform read access before policy resolution performs its tenant
    // lookup. The core call is therefore not given the gate a second time.
    if (ctx.access) await ctx.access.assertRead(ctx.userId)
    // RETRIEVAL-SCOPE POLICY (issue #47): resolved at most once per request
    // (the route's memoized thunk) and INJECTED into core, which owns the
    // enforcement (default fills a missing scope filter; require throws the
    // typed UnscopedRetrievalError mapped by errors.ts). Shared across both
    // order branches so neither pays a second lookup.
    const retrievalPolicy =
      ctx.retrievalPolicy === undefined ? undefined : await ctx.retrievalPolicy()
    const policyScope = applyPolicyToScopeFilter(retrievalPolicy, filters.scope)

    if (input.order === 'chronological') {
      return handleChronologicalSearch(input, filters, policyScope, retrievalPolicy, ctx)
    }
    return handleRelevanceSearch(input, filters, policyScope, retrievalPolicy, ctx)
  },
}

/**
 * The search tool, spliced into the {@link TOOLS} registry by tools.ts at its
 * original position (after remember). A readonly array so the registry stays
 * the single auditable surface.
 */
export const SEARCH_TOOLS: readonly ToolDefinition[] = [searchTool]
