// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. searchChronological()'s POLICY: retrieval-scope
// resolution (same policy machinery as search()/searchDashboardPage()), the
// read-path content excerpt, and — the defining property of list mode — NO
// embedding acquisition and NO gateway dependency at all. packages/db is
// mocked.
//
// Golden-set metric quality does not apply here: list mode is unranked, so
// there is no recall/mrr/supersession/abstention floor to prove against real
// Postgres for this path.
import { EXCERPT_MARKER, MAX_EXCERPT_LENGTH, searchHitSchema } from '@3ngram/schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

const searchList = vi.fn()
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
  fn({} as unknown),
)

vi.mock('@3ngram/db', () => ({
  searchList: (...args: unknown[]) => searchList(...args),
  withTenant: (userId: string, fn: (tx: unknown) => Promise<unknown>) => withTenant(userId, fn),
  // search-options.ts (imported transitively by search-list.ts) reads this at
  // module load time to define DEFAULT_SEARCH_SUPERSESSION_PENALTY, even
  // though list mode never applies a penalty itself.
  DEFAULT_SUPERSESSION_PENALTY: 2,
}))

const { searchChronological } = await import('../src/read/search-list.js')

const HIT = {
  id: 'm1',
  memoryType: 'note',
  topic: 't',
  content: 'c',
  score: 0,
  superseded: false,
}
const PAGE = {
  hits: [HIT],
  cursor: { recordedAt: '2026-01-01T00:00:00.000000Z', id: 'm1' },
  hasMore: false,
}

afterEach(() => {
  searchList.mockReset()
  withTenant.mockClear()
})

describe('searchChronological — no embedding, no gateway dependency', () => {
  it('never touches an embedding gateway (list mode has none to call)', async () => {
    searchList.mockResolvedValue(PAGE)
    // No `gateway` field exists on ListOptions at all — this is a structural
    // guarantee, not just an untested code path: TypeScript would reject a
    // gateway option here, unlike search()'s EmbeddingSource union.
    await searchChronological('u1', { limit: 5 })
    expect(searchList).toHaveBeenCalledTimes(1)
  })

  it('runs inside withTenant(userId)', async () => {
    searchList.mockResolvedValue(PAGE)
    await searchChronological('u1', {})
    expect(withTenant).toHaveBeenCalledWith('u1', expect.any(Function))
  })
})

describe('searchChronological — passthrough to db.searchList', () => {
  it('passes limit, filters, and cursor straight to searchList', async () => {
    searchList.mockResolvedValue(PAGE)
    const cursor = { recordedAt: '2026-01-01T00:00:00.000000Z', id: 'prev' }
    const filters = { scope: 'work' }
    await searchChronological('u1', { limit: 10, filters, cursor })
    expect(searchList).toHaveBeenCalledWith(expect.anything(), 'u1', 10, filters, cursor)
  })

  it('defaults limit to the shared product default (5) when omitted', async () => {
    searchList.mockResolvedValue(PAGE)
    await searchChronological('u1', {})
    expect(searchList).toHaveBeenCalledWith(expect.anything(), 'u1', 5, {}, undefined)
  })
})

describe('searchChronological — retrieval-scope policy (issue #47)', () => {
  it('narrows an unscoped call under a default-mode policy and echoes appliedScope', async () => {
    searchList.mockResolvedValue(PAGE)
    const page = await searchChronological('u1', {
      retrievalPolicy: { mode: 'default', defaultScope: 'work' },
    })
    expect(searchList).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      5,
      { scope: 'work' },
      undefined,
    )
    expect(page.appliedScope).toBe('work')
  })

  it('leaves an explicit scope filter untouched and reports no policy narrowing', async () => {
    searchList.mockResolvedValue(PAGE)
    const page = await searchChronological('u1', {
      filters: { scope: 'personal' },
      retrievalPolicy: { mode: 'default', defaultScope: 'work' },
    })
    expect(searchList).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      5,
      { scope: 'personal' },
      undefined,
    )
    expect(page.appliedScope).toBeNull()
  })

  it('rejects an unscoped call under require mode before any db work', async () => {
    await expect(
      searchChronological('u1', {
        retrievalPolicy: { mode: 'require', registeredScopes: ['work'] },
      }),
    ).rejects.toThrow()
    expect(searchList).not.toHaveBeenCalled()
  })
})

describe('searchChronological — access gate', () => {
  it('asserts read access before any db work when an access gate is injected', async () => {
    searchList.mockResolvedValue(PAGE)
    const assertRead = vi.fn(async () => undefined)
    await searchChronological('u1', { access: { assertRead, assertWrite: vi.fn() } })
    expect(assertRead).toHaveBeenCalledWith('u1')
  })

  it('propagates an access-denied rejection before calling searchList', async () => {
    const denied = new Error('denied')
    const assertRead = vi.fn(async () => {
      throw denied
    })
    await expect(
      searchChronological('u1', { access: { assertRead, assertWrite: vi.fn() } }),
    ).rejects.toBe(denied)
    expect(searchList).not.toHaveBeenCalled()
  })
})

describe('searchChronological — read-path content excerpting', () => {
  it('bounds a long hit to the excerpt cap, same as ranked search', async () => {
    const stored = 'x'.repeat(5000)
    searchList.mockResolvedValue({ ...PAGE, hits: [{ ...HIT, content: stored }] })
    const page = await searchChronological('u1', {})
    const hit = page.hits[0]
    expect(hit?.content.length).toBe(MAX_EXCERPT_LENGTH)
    expect(hit?.content.endsWith(EXCERPT_MARKER)).toBe(true)
    expect(hit?.contentLength).toBe(5000)
    expect(hit?.truncated).toBe(true)
  })

  it('every returned hit parses against the shared searchHitSchema output contract', async () => {
    const id = crypto.randomUUID()
    searchList.mockResolvedValue({ ...PAGE, hits: [{ ...HIT, id }] })
    const page = await searchChronological('u1', {})
    expect(searchHitSchema.safeParse(page.hits[0]).success).toBe(true)
  })
})

describe('searchChronological — continuation state', () => {
  it('echoes hasMore and the next keyset cursor from the db page', async () => {
    const cursor = { recordedAt: '2026-02-01T00:00:00.000000Z', id: 'last' }
    searchList.mockResolvedValue({ hits: [HIT], cursor, hasMore: true })
    const page = await searchChronological('u1', {})
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toEqual(cursor)
  })

  it('reports no cursor when the page is exhausted', async () => {
    searchList.mockResolvedValue({ hits: [], cursor: undefined, hasMore: false })
    const page = await searchChronological('u1', {})
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeUndefined()
  })
})
