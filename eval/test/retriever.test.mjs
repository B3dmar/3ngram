// SPDX-License-Identifier: Apache-2.0
// Offline plumbing tests for the pluggable retrievers (#37). These NEVER touch
// the network or a DB: the real retriever is exercised with dependency-injected
// fakes (a FakeGateway-shaped stub + in-memory remember/search), so `pnpm test`
// stays the deterministic, zero-network PR lane (docs/concepts/testing.mdx evals layer). The real wiring
// (createRealRetrieverFromEnv) is covered separately as a skip-when-absent
// contract, not as a live integration here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFlag } from '../src/lib.mjs'
import {
  assertKnownRetriever,
  chunkSessionText,
  createRealRetriever,
  isDuplicateMemoryError,
  lexicalRetriever,
  planSessionMemories,
  rankSessionsFromHits,
  resolveRetriever,
  resolveRetrieverName,
} from '../src/retriever.mjs'

// Mirror of core's DuplicateMemoryError contract (name + contentHash). We do
// NOT import the real class: the unit lane stays free of any @3ngram/core load,
// and the retriever detects duplicates by that contract, not by instanceof.
class FakeDuplicateMemoryError extends Error {
  constructor(contentHash) {
    super('memory with this content already exists for this tenant')
    this.name = 'DuplicateMemoryError'
    this.contentHash = contentHash
  }
}

const SESSIONS = [
  { session_id: 's1', turns: [{ role: 'user', content: 'I picked PostgreSQL for the project.' }] },
  { session_id: 's2', turns: [{ role: 'user', content: 'The weather is nice today.' }] },
]

test('resolveRetrieverName defaults to lexical and honours flag/env precedence', () => {
  assert.equal(resolveRetrieverName(undefined, {}), 'lexical')
  assert.equal(resolveRetrieverName('real', {}), 'real')
  assert.equal(resolveRetrieverName(undefined, { EVAL_RETRIEVER: 'real' }), 'real')
  // explicit flag wins over env
  assert.equal(resolveRetrieverName('lexical', { EVAL_RETRIEVER: 'real' }), 'lexical')
})

test('equals-form and space-form --retriever both resolve to real (#122)', () => {
  // The end-to-end CLI path: parse the flag, then resolve the name. Both the
  // documented `--retriever=real` and `--retriever real` must select real — the
  // equals form used to fall through to the lexical default (silent
  // misattribution: the run claimed real while scoring lexical).
  const fromEquals = resolveRetrieverName(
    parseFlag(['--retriever=real'], 'retriever', undefined),
    {},
  )
  const fromSpace = resolveRetrieverName(
    parseFlag(['--retriever', 'real'], 'retriever', undefined),
    {},
  )
  assert.equal(fromEquals, 'real')
  assert.equal(fromSpace, 'real')
})

test('assertKnownRetriever throws clearly on an unknown value', () => {
  assert.throws(() => assertKnownRetriever('reel'), /unknown retriever: "reel".*lexical, real/s)
  assert.throws(() => assertKnownRetriever(''), /unknown retriever/)
  // the two known names never throw
  assert.doesNotThrow(() => assertKnownRetriever('lexical'))
  assert.doesNotThrow(() => assertKnownRetriever('real'))
})

test('resolveRetriever rejects an unknown retriever name (no silent lexical fallback)', async () => {
  await assert.rejects(() => resolveRetriever('bogus', {}), /unknown retriever: "bogus"/)
})

test('lexicalRetriever ranks the overlapping session first (offline default)', async () => {
  const ranked = await lexicalRetriever.rankSessions(
    'Which database did I pick for the project?',
    SESSIONS,
  )
  assert.equal(ranked[0].session_id, 's1')
  assert.ok(ranked[0].score >= ranked[1].score)
})

test('chunkSessionText splits on the cap and drops empty chunks', () => {
  assert.deepEqual(chunkSessionText('abcdef', 3), ['abc', 'def'])
  assert.deepEqual(chunkSessionText('ab', 5), ['ab'])
  assert.deepEqual(chunkSessionText('   ', 2), [''])
})

test('planSessionMemories: one memory per short session, chunks a long one', () => {
  const long = 'x'.repeat(50)
  const sessions = [
    { session_id: 'short', turns: [{ role: 'user', content: 'hi there' }] },
    { session_id: 'long', turns: [{ role: 'user', content: long }] },
  ]
  const plan = planSessionMemories(sessions, 20)
  assert.equal(plan.filter((p) => p.session_id === 'short').length, 1)
  // 50 chars / 20 cap -> 3 chunks
  assert.equal(plan.filter((p) => p.session_id === 'long').length, 3)
})

test('rankSessionsFromHits ranks by best chunk, ties by session_id, misses score 0', () => {
  const sessionIds = ['s1', 's2', 's3']
  const memoryToSession = new Map([
    ['m1', 's1'],
    ['m2', 's1'],
    ['m3', 's2'],
  ])
  const hits = [
    { id: 'm1', score: 0.4 },
    { id: 'm2', score: 0.9 }, // best chunk for s1
    { id: 'm3', score: 0.9 }, // s2 ties s1 on score -> session_id breaks it
  ]
  const ranked = rankSessionsFromHits(sessionIds, memoryToSession, hits)
  assert.deepEqual(ranked, [
    { session_id: 's1', score: 0.9 },
    { session_id: 's2', score: 0.9 },
    { session_id: 's3', score: 0 },
  ])
})

test('createRealRetriever drives remember+search through fakes (no DB/network)', async () => {
  // In-memory store: remember() records text per memory id; search() returns
  // hits scored by naive token overlap so the wiring is verifiable offline.
  const store = new Map() // memoryId -> { sessionId, content }
  let nextId = 0
  const gateway = { embed: () => Promise.resolve([[]]), complete: () => Promise.resolve('') }
  const fakeRemember = (_userId, input, _actor, opts) => {
    assert.equal(opts.gateway, gateway, 'real retriever must inject the gateway on the write path')
    const id = `m${nextId++}`
    store.set(id, { content: input.content })
    return Promise.resolve({ id, embed: { settled: Promise.resolve(true) } })
  }
  const fakeSearch = (_userId, query, opts, optsLimit) => {
    assert.equal(opts.gateway, gateway, 'real retriever must inject the gateway on the read path')
    assert.ok(optsLimit.limit >= 1)
    const q = new Set(query.toLowerCase().match(/[a-z]+/g) ?? [])
    return Promise.resolve(
      [...store.entries()]
        .map(([id, { content }]) => {
          const words = content.toLowerCase().match(/[a-z]+/g) ?? []
          const score = words.filter((w) => q.has(w)).length
          return { id, score }
        })
        .sort((a, b) => b.score - a.score),
    )
  }
  let tenants = 0
  const retriever = createRealRetriever({
    remember: fakeRemember,
    search: fakeSearch,
    makeTenant: () => Promise.resolve(`tenant-${tenants++}`),
    gateway,
    maxContentLength: 2000,
  })
  const ranked = await retriever.rankSessions('which database did I pick', SESSIONS)
  assert.equal(retriever.name, 'real')
  assert.equal(ranked[0].session_id, 's1')
  assert.equal(tenants, 1, 'one disposable tenant per question')
})

test('resolveRetriever real skips cleanly when DATABASE_URL absent', async () => {
  const { retriever, skipReason } = await resolveRetriever('real', { LLM_GATEWAY_API_KEY: 'k' })
  assert.equal(retriever, null)
  assert.match(skipReason, /DATABASE_URL/)
})

test('resolveRetriever real skips cleanly when the gateway secret absent', async () => {
  const { retriever, skipReason } = await resolveRetriever('real', { DATABASE_URL: 'postgres://x' })
  assert.equal(retriever, null)
  assert.match(skipReason, /LLM_GATEWAY_API_KEY/)
})

test('resolveRetriever defaults to the offline lexical retriever', async () => {
  const { retriever, skipReason } = await resolveRetriever('lexical', {})
  assert.equal(retriever, lexicalRetriever)
  assert.equal(skipReason, null)
})

test('isDuplicateMemoryError matches the name/contentHash contract only', () => {
  assert.equal(isDuplicateMemoryError(new FakeDuplicateMemoryError('abc')), true)
  assert.equal(isDuplicateMemoryError(new Error('boom')), false)
  const namedButNoHash = new Error('x')
  namedButNoHash.name = 'DuplicateMemoryError'
  assert.equal(isDuplicateMemoryError(namedButNoHash), false)
  assert.equal(isDuplicateMemoryError(null), false)
})

test('createRealRetriever tolerates two sessions with identical content', async () => {
  // Two sessions whose trimmed content is byte-identical. Ranking must complete
  // without throwing and BOTH sessions must remain rankable. The in-run content
  // map writes the shared chunk ONCE (the primary fix), so the second session is
  // not even attempted as a write.
  const dupSessions = [
    { session_id: 'a', turns: [{ role: 'user', content: 'shared boilerplate line' }] },
    { session_id: 'b', turns: [{ role: 'user', content: 'shared boilerplate line' }] },
  ]
  const gateway = { embed: () => Promise.resolve([[]]), complete: () => Promise.resolve('') }
  const store = new Map() // memoryId -> { content }
  let nextId = 0
  let remembers = 0
  const fakeRemember = (_userId, input, _actor, _opts) => {
    remembers++
    const id = `m${nextId++}`
    store.set(id, { content: input.content })
    return Promise.resolve({ id, embed: { settled: Promise.resolve(true) } })
  }
  const fakeSearch = (_userId, query, _opts, _limit) => {
    const q = new Set(query.toLowerCase().match(/[a-z]+/g) ?? [])
    return Promise.resolve(
      [...store.entries()]
        .map(([id, { content }]) => {
          const words = content.toLowerCase().match(/[a-z]+/g) ?? []
          const score = words.filter((w) => q.has(w)).length
          return { id, score }
        })
        .sort((a, b) => b.score - a.score),
    )
  }
  const retriever = createRealRetriever({
    remember: fakeRemember,
    search: fakeSearch,
    makeTenant: () => Promise.resolve('tenant-0'),
    gateway,
    maxContentLength: 2000,
  })

  const ranked = await retriever.rankSessions('shared boilerplate', dupSessions)

  // Ranking completed (no throw); shared chunk written exactly once.
  assert.equal(remembers, 1, 'identical chunk written once, not per session')
  assert.equal(ranked.length, 2)
  const ids = new Set(ranked.map((r) => r.session_id))
  assert.ok(ids.has('a') && ids.has('b'), 'both sessions remain rankable')
  // Tie behaviour: the shared chunk is a single physical memory attributed to the
  // FIRST writer ('a', earlier in plan order). 'a' carries the hit; 'b' has no
  // distinct chunk to attribute, so it scores 0 but is still ranked.
  const a = ranked.find((r) => r.session_id === 'a')
  const b = ranked.find((r) => r.session_id === 'b')
  assert.ok(a.score > 0, 'first writer of the shared chunk keeps the score')
  assert.equal(b.score, 0, 'duplicate-only session forfeits the shared score, still rankable')
})

test('createRealRetriever swallows a DuplicateMemoryError from remember()', async () => {
  // Defensive net: a duplicate the in-run map could not foresee (e.g. a row
  // pre-seeded on the shared branch) surfaces as a thrown DuplicateMemoryError.
  // It must be caught so ranking still completes and every session is returned.
  const sessions = [
    { session_id: 'a', turns: [{ role: 'user', content: 'preexisting content' }] },
    { session_id: 'b', turns: [{ role: 'user', content: 'fresh content' }] },
  ]
  const gateway = { embed: () => Promise.resolve([[]]), complete: () => Promise.resolve('') }
  const store = new Map()
  let nextId = 0
  const fakeRemember = (_userId, input, _actor, _opts) => {
    if (input.content === 'preexisting content') {
      return Promise.reject(new FakeDuplicateMemoryError('hash-preexisting'))
    }
    const id = `m${nextId++}`
    store.set(id, { content: input.content })
    return Promise.resolve({ id, embed: { settled: Promise.resolve(true) } })
  }
  const fakeSearch = (_userId, query, _opts, _limit) => {
    const q = new Set(query.toLowerCase().match(/[a-z]+/g) ?? [])
    return Promise.resolve(
      [...store.entries()].map(([id, { content }]) => {
        const words = content.toLowerCase().match(/[a-z]+/g) ?? []
        return { id, score: words.filter((w) => q.has(w)).length }
      }),
    )
  }
  const retriever = createRealRetriever({
    remember: fakeRemember,
    search: fakeSearch,
    makeTenant: () => Promise.resolve('tenant-0'),
    gateway,
    maxContentLength: 2000,
  })
  const ranked = await retriever.rankSessions('fresh content', sessions)
  assert.equal(ranked.length, 2, 'both sessions returned despite the duplicate throw')
  const a = ranked.find((r) => r.session_id === 'a')
  assert.equal(a.score, 0, 'unwritable duplicate session has no hit but is still rankable')
})

test('createRealRetriever rethrows non-duplicate remember() errors', async () => {
  const sessions = [{ session_id: 'a', turns: [{ role: 'user', content: 'x' }] }]
  const gateway = { embed: () => Promise.resolve([[]]), complete: () => Promise.resolve('') }
  const retriever = createRealRetriever({
    remember: () => Promise.reject(new Error('db is down')),
    search: () => Promise.resolve([]),
    makeTenant: () => Promise.resolve('tenant-0'),
    gateway,
    maxContentLength: 2000,
  })
  await assert.rejects(() => retriever.rankSessions('q', sessions), /db is down/)
})
