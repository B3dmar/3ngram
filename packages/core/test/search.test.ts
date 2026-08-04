// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. search()'s POLICY: default fusion weights (vector leg
// enabled) + the db tier supersession penalty, the gateway-vs-precomputed-embedding
// dual path (core never builds a provider), query-text redaction
// (hard rule 6), and the InvalidEmbeddingError dimension invariant. packages/db
// is mocked; FakeGateway is the real deterministic embedding fake.
//
// Input validation (empty query, enum constraints) is now the transport's
// responsibility (packages/schema searchInputSchema — hard rule 2).
//
// Golden-set metric quality (recall/mrr/supersession/abstention through the
// REAL fused path) is proven by test/integration/search-golden.int.test.ts
// against real Postgres with the cached real-model embeddings — never here (a
// hash fake has no semantic structure, so it could never score the floors).
import { EMBEDDING_DIMENSIONS } from '@3ngram/llm'
import { EXCERPT_MARKER, MAX_EXCERPT_LENGTH, searchHitSchema } from '@3ngram/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

const searchFused = vi.fn()
const insertLlmUsage = vi.fn(async (..._args: unknown[]) => undefined)
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
  fn({} as unknown),
)

class InvalidEmbeddingError extends Error {
  constructor(actual: number) {
    super(`embedding must have exactly ${EMBEDDING_DIMENSIONS} dimensions, got ${actual}`)
    this.name = 'InvalidEmbeddingError'
  }
}

// Mirror the real db tier penalty so the policy default (which imports it) is
// the same value the integration test seeds and ships.
const DEFAULT_SUPERSESSION_PENALTY = 2

vi.mock('@3ngram/db', () => ({
  searchFused: (...args: unknown[]) => searchFused(...args),
  withTenant: (userId: string, fn: (tx: unknown) => Promise<unknown>) => withTenant(userId, fn),
  insertLlmUsage: (...args: unknown[]) => insertLlmUsage(...args),
  InvalidEmbeddingError,
  EMBEDDING_DIMENSIONS,
  DEFAULT_SUPERSESSION_PENALTY,
}))

const { createFakeGateway } = await import('@3ngram/llm')
const { search, DEFAULT_SEARCH_WEIGHTS, DEFAULT_SEARCH_SUPERSESSION_PENALTY } = await import(
  '../src/read/search.js'
)

const HIT = { id: 'm1', memoryType: 'note', topic: 't', content: 'c', score: 0.9 }
const dim = (n = EMBEDDING_DIMENSIONS) => Array.from({ length: n }, () => 0.01)

afterEach(() => {
  searchFused.mockReset()
  withTenant.mockClear()
  insertLlmUsage.mockClear()
})

describe('search — policy defaults', () => {
  it('exposes a vector-led product default distinct from the db FTS-only default', () => {
    // Vector is the PRIMARY signal; recency is OFF (a non-zero recency leg
    // displaces gold rows from the golden set, failing recall/mrr floors — see
    // the tuning evidence on DEFAULT_SEARCH_WEIGHTS), and FTS is a
    // modest pool-recall contribution below the mrr cliff.
    expect(DEFAULT_SEARCH_WEIGHTS.vector).toBeGreaterThan(0)
    expect(DEFAULT_SEARCH_WEIGHTS).toEqual({ fts: 0.2, recency: 0, vector: 1 })
  })

  it('uses the db TIER supersession penalty (docs/concepts/memory-model.mdx: currently-valid first)', () => {
    // The product default IS the db tier penalty (2), imported not redefined:
    // a superseded predecessor sinks below every live row, so retrieval never
    // surfaces a stale memory above its successor. Superseded rows stay
    // retrievable, just ranked below.
    expect(DEFAULT_SEARCH_SUPERSESSION_PENALTY).toBe(DEFAULT_SUPERSESSION_PENALTY)
  })

  it('passes the product defaults (K=5, weights, tier penalty, empty filters) to searchFused', async () => {
    // Use a 3-token query so the short-query topic-boost path (≤2 tokens) does
    // not activate — this test pins the pass-through path where weights reach
    // searchFused unchanged.
    searchFused.mockResolvedValue([HIT])
    await search('u1', 'find it now', { queryEmbedding: dim() })
    expect(searchFused).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'find it now',
      5,
      DEFAULT_SEARCH_WEIGHTS,
      DEFAULT_SEARCH_SUPERSESSION_PENALTY,
      dim(),
      // No filters supplied: an EMPTY filter object reaches the db layer, where it
      // composes to the unchanged active-only candidate rule.
      {},
      undefined,
    )
  })

  it('honours explicit limit / weights / penalty overrides', async () => {
    // Use a 3-token query to stay on the pass-through path.
    searchFused.mockResolvedValue([])
    const weights = { fts: 0, recency: 0, vector: 1 }
    await search(
      'u1',
      'explicit weights query',
      { queryEmbedding: dim() },
      { limit: 3, weights, supersessionPenalty: 2 },
    )
    expect(searchFused).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'explicit weights query',
      3,
      weights,
      2,
      dim(),
      {},
      undefined,
    )
  })

  it('honours explicit cursor for ranked continuation', async () => {
    searchFused.mockResolvedValue([])
    const cursor = { score: 1.5, id: '00000000-0000-0000-0000-000000000001' }
    await search('u1', 'continuation query', { queryEmbedding: dim() }, { limit: 10, cursor })

    expect(searchFused.mock.calls[0]?.[3]).toBe(10)
    expect(searchFused.mock.calls[0]?.[8]).toEqual(cursor)
  })
})

describe('short-query topic boost (issue #339)', () => {
  it('1-token query "Ana" injects topicMatch: 0.5 into weights forwarded to searchFused', async () => {
    searchFused.mockResolvedValue([HIT])
    await search('u1', 'Ana', { queryEmbedding: dim() })
    expect(searchFused).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'Ana',
      5,
      { ...DEFAULT_SEARCH_WEIGHTS, topicMatch: 0.5 },
      DEFAULT_SEARCH_SUPERSESSION_PENALTY,
      dim(),
      {},
      undefined,
    )
  })

  it('4-token query does not activate the topic boost (topicMatch stays undefined)', async () => {
    searchFused.mockResolvedValue([])
    await search('u1', 'find all meeting notes', { queryEmbedding: dim() })
    const calledWeights = searchFused.mock.calls[0]?.[4] as Record<string, unknown>
    // topicMatch must not be set (or be 0) for long queries
    expect(calledWeights.topicMatch == null || calledWeights.topicMatch === 0).toBe(true)
  })

  it('explicit topicMatch in caller weights is forwarded as-is without override', async () => {
    searchFused.mockResolvedValue([])
    const weights = { ...DEFAULT_SEARCH_WEIGHTS, topicMatch: 0.3 }
    await search('u1', 'Ana', { queryEmbedding: dim() }, { weights })
    expect(searchFused).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'Ana',
      5,
      weights,
      DEFAULT_SEARCH_SUPERSESSION_PENALTY,
      dim(),
      {},
      undefined,
    )
  })

  it('explicit topicMatch: 0 suppresses the boost on a short query (0 is not overridden to 0.5)', async () => {
    // Regression guard for the !weights.topicMatch bug: `!0` is truthy, so a
    // caller passing topicMatch:0 to suppress the boost had it silently overridden
    // to 0.5. The guard must be `=== undefined` to respect deliberate suppression.
    searchFused.mockResolvedValue([])
    const weights = { ...DEFAULT_SEARCH_WEIGHTS, topicMatch: 0 }
    await search('u1', 'Ana', { queryEmbedding: dim() }, { weights })
    expect(searchFused).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'Ana',
      5,
      weights,
      DEFAULT_SEARCH_SUPERSESSION_PENALTY,
      dim(),
      {},
      undefined,
    )
  })
})

describe('search — filter threading (issue #134)', () => {
  it('threads the candidate filters straight to searchFused as the 7th arg', async () => {
    // Filters NARROW the candidate set at the db layer; core only forwards them
    // (validation is the schema boundary's job, not core's — hard rule 2). The
    // fusion weights and tier penalty stay the product defaults alongside.
    // Use a 3-token query to stay on the pass-through path.
    searchFused.mockResolvedValue([HIT])
    const filters = { memoryType: 'decision', scope: 'work', project: '3ngram', status: 'active' }
    await search('u1', 'filter threading query', { queryEmbedding: dim() }, { filters })
    expect(searchFused).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'filter threading query',
      5,
      DEFAULT_SEARCH_WEIGHTS,
      DEFAULT_SEARCH_SUPERSESSION_PENALTY,
      dim(),
      filters,
      undefined,
    )
  })

  it('forwards an asOf time-travel coordinate unchanged (bi-temporal, docs/concepts/memory-model.mdx)', async () => {
    // as_of is bi-temporal: core passes validAt/asKnownAt through verbatim. The
    // db layer turns them into the valid-time/transaction-time predicates that
    // surface superseded history — core adds no policy here.
    searchFused.mockResolvedValue([])
    const asOf = { validAt: new Date('2026-01-01T00:00:00Z') }
    await search('u1', 'temporal query test', { queryEmbedding: dim() }, { filters: { asOf } })
    expect(searchFused.mock.calls[0]?.[7]).toEqual({ asOf })
  })

  it('composes filters WITH explicit fusion-weight overrides (filters do not touch weights)', async () => {
    // Use a 3-token query to stay on the pass-through path.
    searchFused.mockResolvedValue([])
    const weights = { fts: 1, recency: 0, vector: 0 }
    const filters = { scope: 'personal' }
    await search('u1', 'filter weight compose', { queryEmbedding: dim() }, { weights, filters })
    expect(searchFused).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'filter weight compose',
      5,
      weights,
      2,
      dim(),
      filters,
      undefined,
    )
  })
})

describe('search — embedding acquisition', () => {
  it('embeds the query via the injected gateway with the search operation tag', async () => {
    searchFused.mockResolvedValue([HIT])
    const gateway = createFakeGateway()
    const hits = await search('u1', 'how do I recover memories', { gateway })
    expect(gateway.calls.embed).toHaveLength(1)
    expect(gateway.calls.embed[0]).toMatchObject({
      texts: ['how do I recover memories'],
      operation: 'search',
    })
    // the gateway-produced vector is forwarded to the fused query
    const forwarded = searchFused.mock.calls[0]?.[6]
    expect(forwarded).toHaveLength(EMBEDDING_DIMENSIONS)
    // the hit gains the read-path excerpt metadata: short content
    // passes through verbatim with the full-length/truncated coordinates.
    expect(hits).toEqual([{ ...HIT, contentLength: HIT.content.length, truncated: false }])
    // Cost tracking: one usage row under the 'search' operation key.
    expect(insertLlmUsage).toHaveBeenCalledTimes(1)
    const usageRow = insertLlmUsage.mock.calls[0]?.[1] as { operation?: string } | undefined
    expect(usageRow?.operation).toBe('search')
  })

  it('uses a pre-computed embedding without calling any gateway (cached path)', async () => {
    searchFused.mockResolvedValue([HIT])
    const embedding = dim()
    await search('u1', 'q', { queryEmbedding: embedding })
    expect(searchFused.mock.calls[0]?.[6]).toBe(embedding)
    // No gateway call -> no cost row (the cached path incurs no spend).
    expect(insertLlmUsage).not.toHaveBeenCalled()
  })

  it('runs inside withTenant(userId)', async () => {
    searchFused.mockResolvedValue([])
    await search('u1', 'q', { queryEmbedding: dim() })
    expect(withTenant).toHaveBeenCalledWith('u1', expect.any(Function))
  })
})

describe('search — embedding dimension invariant', () => {
  it('rejects a pre-computed embedding of the wrong width (typed, not opaque)', async () => {
    await expect(search('u1', 'q', { queryEmbedding: dim(10) })).rejects.toBeInstanceOf(
      InvalidEmbeddingError,
    )
    expect(searchFused).not.toHaveBeenCalled()
  })
})

describe('search — redaction (hard rule 6)', () => {
  it('never echoes the query text in an error message', async () => {
    const secret = 'PATIENT SSN 123-45-6789 in the leak'
    try {
      await search('u1', secret, { queryEmbedding: dim(3) })
      throw new Error('expected a throw')
    } catch (err) {
      expect((err as Error).message).not.toContain(secret)
      expect((err as Error).message).not.toContain('123-45-6789')
    }
  })

  it('forwards the raw query to the FTS leg (db redacts in its own logs) but core logs nothing', async () => {
    // The query text MUST reach searchFused (FTS needs it); redaction is about
    // LOGS, not the query path. This test pins that the text is passed through
    // intact while core emits no log line carrying it (core has no logger here).
    searchFused.mockResolvedValue([])
    await search('u1', 'lexical term', { queryEmbedding: dim() })
    expect(searchFused.mock.calls[0]?.[2]).toBe('lexical term')
  })
})

describe('search — read-path content excerpting (issue #238)', () => {
  it('bounds a long hit to the excerpt cap with the marker, full length, truncated flag', async () => {
    // Imported rows can exceed any write-time cap (schema import path admits
    // 262,144 chars); the read path must bound them so output contracts hold.
    const stored = 'x'.repeat(5000)
    searchFused.mockResolvedValue([{ ...HIT, content: stored }])
    const hits = await search('u1', 'q', { queryEmbedding: dim() })
    const hit = hits[0]
    expect(hit?.content.length).toBe(MAX_EXCERPT_LENGTH)
    expect(hit?.content.endsWith(EXCERPT_MARKER)).toBe(true)
    expect(hit?.contentLength).toBe(5000)
    expect(hit?.truncated).toBe(true)
  })

  it('passes content at exactly the cap through verbatim (no marker, not truncated)', async () => {
    const stored = 'y'.repeat(MAX_EXCERPT_LENGTH)
    searchFused.mockResolvedValue([{ ...HIT, content: stored }])
    const hits = await search('u1', 'q', { queryEmbedding: dim() })
    expect(hits[0]?.content).toBe(stored)
    expect(hits[0]?.contentLength).toBe(MAX_EXCERPT_LENGTH)
    expect(hits[0]?.truncated).toBe(false)
  })

  it('every returned hit parses against the searchHitSchema output contract', async () => {
    // The defect: a >2,000-char stored row made the MCP output schema
    // reject the WHOLE result. With core excerpting, an arbitrarily long row
    // always yields a schema-valid hit.
    const id = crypto.randomUUID()
    searchFused.mockResolvedValue([
      { id, memoryType: 'note', topic: 't', content: 'z'.repeat(245_428), score: 0.5 },
    ])
    const hits = await search('u1', 'q', { queryEmbedding: dim() })
    expect(searchHitSchema.safeParse(hits[0]).success).toBe(true)
  })
})
