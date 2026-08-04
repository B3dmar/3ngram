// SPDX-License-Identifier: Apache-2.0
// Unit coverage for retrieval-scope policy enforcement across core read surfaces.
import { EMBEDDING_DIMENSIONS } from '@3ngram/llm'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type {
  DashboardPageOptions,
  ScopedSearchResult,
  SearchHit,
  SearchOptions,
} from '../src/read/search.js'

const searchFused = vi.fn()
const fetchHitsByIds = vi.fn()
const insertLlmUsage = vi.fn(async () => undefined)
const openCommitments = vi.fn()
const overdueCommitments = vi.fn()
const activeBlockers = vi.fn()
const staleCandidates = vi.fn()
const recentDecisions = vi.fn()
const activePreferences = vi.fn()
const getRetrievalPolicy = vi.fn()
const upsertRetrievalPolicy = vi.fn()
const listScopes = vi.fn()
const getEnvironmentStats = vi.fn()
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
  fn({} as unknown),
)

class InvalidEmbeddingError extends Error {
  constructor(actual: number) {
    super(`embedding must have exactly ${EMBEDDING_DIMENSIONS} dimensions, got ${actual}`)
    this.name = 'InvalidEmbeddingError'
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

vi.mock('@3ngram/db', () => ({
  searchFused: (...a: unknown[]) => searchFused(...a),
  fetchHitsByIds: (...a: unknown[]) => fetchHitsByIds(...a),
  insertLlmUsage: (...a: unknown[]) => insertLlmUsage(...a),
  openCommitments: (...a: unknown[]) => openCommitments(...a),
  overdueCommitments: (...a: unknown[]) => overdueCommitments(...a),
  activeBlockers: (...a: unknown[]) => activeBlockers(...a),
  staleCandidates: (...a: unknown[]) => staleCandidates(...a),
  recentDecisions: (...a: unknown[]) => recentDecisions(...a),
  activePreferences: (...a: unknown[]) => activePreferences(...a),
  getRetrievalPolicy: (...a: unknown[]) => getRetrievalPolicy(...a),
  upsertRetrievalPolicy: (...a: unknown[]) => upsertRetrievalPolicy(...a),
  listScopes: (...a: unknown[]) => listScopes(...a),
  getEnvironmentStats: (...a: unknown[]) => getEnvironmentStats(...a),
  withTenant: (userId: string, fn: (tx: unknown) => Promise<unknown>) => withTenant(userId, fn),
  InvalidEmbeddingError,
  ScopeNotFoundError,
  EMBEDDING_DIMENSIONS,
  DEFAULT_SUPERSESSION_PENALTY: 2,
}))

const { applyPolicyToScopeFilter, applyPolicyToSelector, UnscopedRetrievalError } = await import(
  '../src/read/retrieval-policy.js'
)
const { search, searchDashboardPage } = await import('../src/read/search.js')
const { briefing } = await import('../src/read/briefing.js')
const { handoff } = await import('../src/read/handoff.js')
const { resolveRetrievalPolicy, setRetrievalDefault } = await import(
  '../src/scope/retrieval-settings.js'
)
const { describeEnvironment } = await import('../src/admin/environment.js')

const USER = 'user-1'
const NOW = new Date('2026-08-04T12:00:00.000Z')
const HIT = { id: 'm1', memoryType: 'note', topic: 't', content: 'c', score: 0.9 }
const dim = () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01)
const page = <T>(items: T[] = []) => ({ items, totalCount: items.length })

const OFF = { mode: 'off' } as const
const DEFAULT_WORK = { mode: 'default', defaultScope: 'work' } as const
const DEFAULT_PERSONAL = { mode: 'default', defaultScope: 'personal' } as const
const REQUIRE = { mode: 'require', registeredScopes: ['personal', 'work'] } as const

function dashboard(opts: DashboardPageOptions = {}) {
  return searchDashboardPage(USER, 'q', { queryEmbedding: dim() }, opts)
}

function mockBriefingSections() {
  for (const fn of [
    openCommitments,
    overdueCommitments,
    activeBlockers,
    staleCandidates,
    recentDecisions,
    activePreferences,
  ]) {
    fn.mockResolvedValue(page())
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('enforcement helpers', () => {
  it('passes through with no policy or mode off', () => {
    expect(applyPolicyToScopeFilter(undefined, undefined)).toEqual({
      scope: undefined,
      appliedScope: null,
    })
    expect(applyPolicyToScopeFilter(OFF, undefined)).toEqual({
      scope: undefined,
      appliedScope: null,
    })
  })

  it('default fills a missing scope filter and echoes it; an explicit scope wins', () => {
    expect(applyPolicyToScopeFilter(DEFAULT_WORK, undefined)).toEqual({
      scope: 'work',
      appliedScope: 'work',
    })
    expect(applyPolicyToScopeFilter(DEFAULT_WORK, 'personal')).toEqual({
      scope: 'personal',
      appliedScope: null,
    })
  })

  it('require rejects an unscoped filter with the typed error naming the scopes', () => {
    let thrown: unknown
    try {
      applyPolicyToScopeFilter(REQUIRE, undefined)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(UnscopedRetrievalError)
    const e = thrown as InstanceType<typeof UnscopedRetrievalError>
    expect(e.name).toBe('UnscopedRetrievalError')
    expect(e.registeredScopes).toEqual(['personal', 'work'])
    expect(e.message).toContain('personal, work')
    // An explicitly scoped call is always admitted.
    expect(applyPolicyToScopeFilter(REQUIRE, 'work')).toEqual({
      scope: 'work',
      appliedScope: null,
    })
  })

  it('names the no-scopes-registered case actionably', () => {
    expect(() =>
      applyPolicyToScopeFilter({ mode: 'require', registeredScopes: [] }, undefined),
    ).toThrow(/no scopes are registered yet/)
  })

  it('selector: only kind all is policy-fillable; scope/project pass through', () => {
    expect(applyPolicyToSelector(DEFAULT_WORK, { kind: 'all' })).toEqual({
      selector: { kind: 'scope', scope: 'work' },
      appliedScope: 'work',
    })
    expect(applyPolicyToSelector(DEFAULT_WORK, { kind: 'project', project: 'p' })).toEqual({
      selector: { kind: 'project', project: 'p' },
      appliedScope: null,
    })
    expect(applyPolicyToSelector(REQUIRE, { kind: 'scope', scope: 'work' })).toEqual({
      selector: { kind: 'scope', scope: 'work' },
      appliedScope: null,
    })
    expect(() => applyPolicyToSelector(REQUIRE, { kind: 'all' })).toThrow(UnscopedRetrievalError)
  })
})

describe('search per mode', () => {
  it('keeps widened policy-bearing options type-safe', async () => {
    searchFused.mockResolvedValue([HIT])
    const policyOptions: SearchOptions = { retrievalPolicy: OFF }
    const plainOptions = { limit: 1 } satisfies SearchOptions
    const widened = search(USER, 'q', { queryEmbedding: dim() }, policyOptions)
    const plain = search(USER, 'q', { queryEmbedding: dim() }, plainOptions)
    const scoped = search(USER, 'q', { queryEmbedding: dim() }, { retrievalPolicy: OFF })

    expectTypeOf(widened).toEqualTypeOf<Promise<SearchHit[] | ScopedSearchResult>>()
    expectTypeOf(plain).toEqualTypeOf<Promise<SearchHit[]>>()
    expectTypeOf(scoped).toEqualTypeOf<Promise<ScopedSearchResult>>()
    await Promise.all([widened, plain, scoped])
  })

  it('returns an envelope for widened policy-bearing options at runtime', async () => {
    searchFused.mockResolvedValue([HIT])
    const policyOptions: SearchOptions = { retrievalPolicy: OFF }

    const result = await search(USER, 'q', { queryEmbedding: dim() }, policyOptions)

    expect(Array.isArray(result)).toBe(false)
    expect(result).toEqual({
      hits: [expect.objectContaining(HIT)],
      appliedScope: null,
    })
  })

  it('no policy: the shipped plain-array contract is untouched', async () => {
    searchFused.mockResolvedValue([HIT])
    const hits = await search(USER, 'q', { queryEmbedding: dim() })
    expect(Array.isArray(hits)).toBe(true)
    expect(hits[0]?.id).toBe('m1')
  })

  it('off: the envelope rides with appliedScope null and untouched filters', async () => {
    searchFused.mockResolvedValue([HIT])
    const result = await search(USER, 'q', { queryEmbedding: dim() }, { retrievalPolicy: OFF })
    expect(result.appliedScope).toBeNull()
    expect(result.hits[0]?.id).toBe('m1')
    expect(searchFused.mock.calls[0]?.[7]).toEqual({})
  })

  it('default: an unscoped search is narrowed to the scope and echoes it', async () => {
    searchFused.mockResolvedValue([HIT])
    const result = await search(
      USER,
      'q',
      { queryEmbedding: dim() },
      { retrievalPolicy: DEFAULT_WORK, filters: { project: 'p' } },
    )
    expect(result.appliedScope).toBe('work')
    expect(searchFused.mock.calls[0]?.[7]).toEqual({ project: 'p', scope: 'work' })
  })

  it('default: an explicit scope filter always wins (no echo)', async () => {
    searchFused.mockResolvedValue([HIT])
    const result = await search(
      USER,
      'q',
      { queryEmbedding: dim() },
      { retrievalPolicy: DEFAULT_WORK, filters: { scope: 'personal' } },
    )
    expect(result.appliedScope).toBeNull()
    expect(searchFused.mock.calls[0]?.[7]).toEqual({ scope: 'personal' })
  })

  it('require: an unscoped search throws typed BEFORE any metered work', async () => {
    const embed = vi.fn()
    const gateway = { embed } as unknown as import('@3ngram/llm').Gateway
    await expect(
      search(USER, 'q', { gateway }, { retrievalPolicy: REQUIRE }),
    ).rejects.toBeInstanceOf(UnscopedRetrievalError)
    expect(embed).not.toHaveBeenCalled()
    expect(searchFused).not.toHaveBeenCalled()
  })
})

describe('searchDashboardPage per mode', () => {
  it('default: page 1 freezes the POLICY-scoped pool and echoes appliedScope', async () => {
    searchFused.mockResolvedValue([HIT])
    const result = await dashboard({ retrievalPolicy: DEFAULT_WORK })
    expect(result.appliedScope).toBe('work')
    expect(result.frozen.policyScope).toBe('work')
    expectTypeOf(result.frozen.policyScope).toEqualTypeOf<string | null>()
    expect(searchFused.mock.calls[0]?.[7]).toEqual({ scope: 'work' })
  })

  it('default: an unchanged-policy continuation uses the frozen ordering', async () => {
    fetchHitsByIds.mockResolvedValue([HIT])
    const result = await dashboard({
      retrievalPolicy: DEFAULT_WORK,
      limit: 5,
      frozen: { ids: ['m1'], scores: [0.9], off: 0, policyScope: 'work' },
    })
    expect(result.appliedScope).toBe('work')
    expect(result.frozen.policyScope).toBe('work')
    expect(fetchHitsByIds.mock.calls[0]?.[3]).toEqual({ scope: 'work' })
    expect(searchFused).not.toHaveBeenCalled()
  })

  it('restarts page 1 when the default policy changes from work to personal', async () => {
    searchFused.mockResolvedValue([HIT])
    const result = await dashboard({
      retrievalPolicy: DEFAULT_PERSONAL,
      limit: 5,
      frozen: { ids: ['m1'], scores: [0.9], off: 1, policyScope: 'work' },
    })
    expect(fetchHitsByIds).not.toHaveBeenCalled()
    expect(searchFused.mock.calls[0]?.[7]).toEqual({ scope: 'personal' })
    expect(result.appliedScope).toBe('personal')
    expect(result.frozen.policyScope).toBe('personal')
  })

  it('restarts legacy unbound state when a default policy scope is active', async () => {
    searchFused.mockResolvedValue([HIT])
    const result = await dashboard({
      retrievalPolicy: DEFAULT_WORK,
      frozen: { ids: ['m1'], scores: [0.9], off: 1 },
    })
    expect(fetchHitsByIds).not.toHaveBeenCalled()
    expect(searchFused.mock.calls[0]?.[7]).toEqual({ scope: 'work' })
    expect(result.frozen.policyScope).toBe('work')
  })

  it('keeps legacy frozen state compatible when no policy scope is applied', async () => {
    fetchHitsByIds.mockResolvedValue([HIT])
    const result = await dashboard({
      retrievalPolicy: OFF,
      frozen: { ids: ['m1'], scores: [0.9], off: 0 },
    })
    expect(fetchHitsByIds).toHaveBeenCalledTimes(1)
    expect(searchFused).not.toHaveBeenCalled()
    expect(result.frozen.policyScope).toBeNull()
  })

  it('require: an unscoped continuation is rejected too (no silent widening)', async () => {
    await expect(
      dashboard({
        retrievalPolicy: REQUIRE,
        frozen: { ids: ['m1'], scores: [0.9], off: 0 },
      }),
    ).rejects.toBeInstanceOf(UnscopedRetrievalError)
    expect(fetchHitsByIds).not.toHaveBeenCalled()
  })

  it('no policy: appliedScope reports null (nothing narrowed)', async () => {
    searchFused.mockResolvedValue([HIT])
    const result = await dashboard()
    expect(result.appliedScope).toBeNull()
  })
})

describe('briefing per mode', () => {
  it('off / no policy: no appliedScope key, selector echoed verbatim', async () => {
    mockBriefingSections()
    const result = await briefing(USER, {
      selector: { kind: 'all' },
      now: NOW,
      retrievalPolicy: OFF,
    })
    expect(result.selector).toEqual({ kind: 'all' })
    expect('appliedScope' in result).toBe(false)
  })

  it('default: kind all narrows to the scope selector and echoes appliedScope', async () => {
    mockBriefingSections()
    const result = await briefing(USER, {
      selector: { kind: 'all' },
      now: NOW,
      retrievalPolicy: DEFAULT_WORK,
    })
    expect(result.selector).toEqual({ kind: 'scope', scope: 'work' })
    expect(result.appliedScope).toBe('work')
    // Every section query received the EFFECTIVE (narrowed) selector.
    expect(openCommitments.mock.calls[0]?.[2]).toEqual({ kind: 'scope', scope: 'work' })
  })

  it('default: an explicit selector passes through without an echo', async () => {
    mockBriefingSections()
    const result = await briefing(USER, {
      selector: { kind: 'project', project: 'p' },
      now: NOW,
      retrievalPolicy: DEFAULT_WORK,
    })
    expect(result.selector).toEqual({ kind: 'project', project: 'p' })
    expect('appliedScope' in result).toBe(false)
  })

  it('require: kind all throws the typed error; a scoped selector proceeds', async () => {
    await expect(
      briefing(USER, { selector: { kind: 'all' }, now: NOW, retrievalPolicy: REQUIRE }),
    ).rejects.toBeInstanceOf(UnscopedRetrievalError)
    expect(openCommitments).not.toHaveBeenCalled()

    mockBriefingSections()
    const result = await briefing(USER, {
      selector: { kind: 'scope', scope: 'work' },
      now: NOW,
      retrievalPolicy: REQUIRE,
    })
    expect(result.selector).toEqual({ kind: 'scope', scope: 'work' })
  })
})

describe('handoff per mode', () => {
  it('default: kind all narrows, echoes appliedScope, and reads the scoped slice', async () => {
    for (const fn of [recentDecisions, openCommitments, activePreferences]) {
      fn.mockResolvedValue(page())
    }
    const result = await handoff(USER, {
      selector: { kind: 'all' },
      now: NOW,
      retrievalPolicy: DEFAULT_WORK,
    })
    expect(result.selector).toEqual({ kind: 'scope', scope: 'work' })
    expect(result.appliedScope).toBe('work')
    expect(recentDecisions.mock.calls[0]?.[2]).toEqual({ kind: 'scope', scope: 'work' })
  })

  it('require: kind all throws typed; off leaves the result shape untouched', async () => {
    await expect(
      handoff(USER, { selector: { kind: 'all' }, now: NOW, retrievalPolicy: REQUIRE }),
    ).rejects.toBeInstanceOf(UnscopedRetrievalError)

    for (const fn of [recentDecisions, openCommitments, activePreferences]) {
      fn.mockResolvedValue(page())
    }
    const result = await handoff(USER, {
      selector: { kind: 'all' },
      now: NOW,
      retrievalPolicy: OFF,
    })
    expect(result.selector).toEqual({ kind: 'all' })
    expect('appliedScope' in result).toBe(false)
  })
})

describe('resolveRetrievalPolicy (once-per-request resolver)', () => {
  it('maps no stored row to off', async () => {
    getRetrievalPolicy.mockResolvedValue(null)
    expect(await resolveRetrievalPolicy(USER)).toEqual({ mode: 'off' })
    expect(listScopes).not.toHaveBeenCalled()
  })

  it('maps a default row to the default union member', async () => {
    getRetrievalPolicy.mockResolvedValue({ mode: 'default', defaultScope: 'work' })
    expect(await resolveRetrievalPolicy(USER)).toEqual({ mode: 'default', defaultScope: 'work' })
  })

  it('require reads the registry in the same transaction for the error naming', async () => {
    getRetrievalPolicy.mockResolvedValue({ mode: 'require', defaultScope: null })
    listScopes.mockResolvedValue([{ name: 'personal' }, { name: 'work' }])
    expect(await resolveRetrievalPolicy(USER)).toEqual({
      mode: 'require',
      registeredScopes: ['personal', 'work'],
    })
    expect(withTenant).toHaveBeenCalledTimes(1)
  })

  it('degrades a corrupt default row (null scope) to off, never a broken union', async () => {
    getRetrievalPolicy.mockResolvedValue({ mode: 'default', defaultScope: null })
    expect(await resolveRetrievalPolicy(USER)).toEqual({ mode: 'off' })
  })
})

describe('setRetrievalDefault (registry-checked setter)', () => {
  it('rejects a default scope missing from the registry with the typed not-found', async () => {
    listScopes.mockResolvedValue([{ name: 'personal' }])
    await expect(
      setRetrievalDefault(USER, { mode: 'default', scope: 'work' }),
    ).rejects.toBeInstanceOf(ScopeNotFoundError)
    expect(upsertRetrievalPolicy).not.toHaveBeenCalled()
  })

  it('stores a registered default scope and echoes the stored setting', async () => {
    listScopes.mockResolvedValue([{ name: 'work' }])
    upsertRetrievalPolicy.mockResolvedValue({
      mode: 'default',
      defaultScope: 'work',
      updatedAt: NOW,
    })
    expect(await setRetrievalDefault(USER, { mode: 'default', scope: 'work' })).toEqual({
      mode: 'default',
      scope: 'work',
    })
    expect(upsertRetrievalPolicy.mock.calls[0]?.[2]).toEqual({
      mode: 'default',
      defaultScope: 'work',
    })
  })

  it('off/require skip the registry read entirely (no scope to validate)', async () => {
    upsertRetrievalPolicy.mockResolvedValue({ mode: 'require', defaultScope: null, updatedAt: NOW })
    expect(await setRetrievalDefault(USER, { mode: 'require', scope: null })).toEqual({
      mode: 'require',
      scope: null,
    })
    expect(listScopes).not.toHaveBeenCalled()
  })
})

describe('describeEnvironment report mapping', () => {
  const STATS = {
    memoriesByType: {},
    activeMemories: 0,
    supersededMemories: 0,
    archivedMemories: 0,
    commitmentsByStatus: {},
  }

  it('reports the off default when no row is stored', async () => {
    listScopes.mockResolvedValue([])
    getEnvironmentStats.mockResolvedValue(STATS)
    getRetrievalPolicy.mockResolvedValue(null)
    const report = await describeEnvironment(USER)
    expect(report.retrievalScopePolicy).toEqual({ mode: 'off', scope: null })
  })

  it('reports the stored policy verbatim', async () => {
    listScopes.mockResolvedValue([])
    getEnvironmentStats.mockResolvedValue(STATS)
    getRetrievalPolicy.mockResolvedValue({ mode: 'default', defaultScope: 'work' })
    const report = await describeEnvironment(USER)
    expect(report.retrievalScopePolicy).toEqual({ mode: 'default', scope: 'work' })
  })
})
