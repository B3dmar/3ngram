// SPDX-License-Identifier: Apache-2.0
// End-to-end regression test for dashboard search pagination stability under
// mid-session corpus drift, through the REAL Express transport,
// runtime role, and DB with a deterministic FakeGateway. The v1 keyset cursor
// recomputed the fused score each request and so could duplicate or skip a row
// whose score crossed the saved boundary when the corpus changed between two
// "Load more" requests. The v2 frozen-ordering cursor pages by position within
// the ordering frozen at page 1 — immune to both.
import type { Server } from 'node:http'
import { createUser, login } from '@3ngram/core/auth'
import { createFakeGateway } from '@3ngram/llm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
} from '../../../../packages/db/test/integration/helpers.js'
import { createApp } from '../../src/app.js'

const PASSWORD = 'search-pagination-361-password'
const gateway = createFakeGateway()
const TERM = 'zorblax'

let server: Server
let baseUrl: string
let email: string
let key: string

async function issueKey(token: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  })
  if (res.status !== 201) throw new Error(`issueKey failed: ${res.status}`)
  return ((await res.json()) as { key: string }).key
}

async function remember(content: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ memoryType: 'note', topic: TERM, content }),
  })
  if (res.status !== 201) throw new Error(`remember failed: ${res.status}`)
  return ((await res.json()) as { memory: { id: string } }).memory.id
}

interface SearchPage {
  hits: Array<{ id: string }>
  hasMore: boolean
  nextCursor?: string
}

async function searchPage(cursor?: string): Promise<SearchPage> {
  const res = await fetch(`${baseUrl}/api/v1/dashboard/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query: TERM, limit: 2, ...(cursor === undefined ? {} : { cursor }) }),
  })
  expect(res.status, `dashboard search should be 200, body: ${await res.clone().text()}`).toBe(200)
  return (await res.json()) as SearchPage
}

beforeAll(async () => {
  email = `search-pagination-361-${crypto.randomUUID()}@test.local`
  await createUser(email, PASSWORD)
  const grant = await login(email, PASSWORD, 1)
  if (!grant) throw new Error('login failed in setup')
  server = createApp({ gateway }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  key = await issueKey(grant.token, 'search-pagination-361')
}, 30_000)

// Each test starts from a clean corpus (the user + api key survive; only domain
// tables are truncated), so accumulated rows don't bleed across cases.
beforeEach(resetDomainTables)

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  await ownerPool.query('DELETE FROM users WHERE email = $1', [email])
  await closePools()
})

describe('dashboard search "Load more" under mid-session corpus drift (#361)', () => {
  it('never duplicates or skips a result when the corpus changes between pages', async () => {
    const seeded: string[] = []
    for (let i = 0; i < 5; i++)
      seeded.push(await remember(`${TERM} seeded row ${i} ${crypto.randomUUID()}`))

    // Page 1 freezes the ranked ordering into the cursor.
    const page1 = await searchPage()
    expect(page1.hits.length).toBe(2)
    expect(page1.hasMore).toBe(true)

    // CORPUS DRIFT between requests: a new matching row that would re-rank a
    // score-anchored cursor. The frozen ordering ignores it.
    const drifted = await remember(`${TERM} ${TERM} ${TERM} drift row ${crypto.randomUUID()}`)

    // Page through to the end via the cursor.
    const collected = [...page1.hits.map((h) => h.id)]
    let cursor = page1.nextCursor
    let guard = 0
    while (cursor !== undefined && guard++ < 10) {
      const page = await searchPage(cursor)
      collected.push(...page.hits.map((h) => h.id))
      cursor = page.hasMore ? page.nextCursor : undefined
      if (!page.hasMore) break
    }

    const distinct = new Set(collected)
    // No duplicates across pages.
    expect(collected.length, `duplicate ids across pages: ${collected.join(',')}`).toBe(
      distinct.size,
    )
    // Exactly the 5 rows frozen at page 1 — no skips, and the drift row inserted
    // after page 1 is NOT surfaced (it was not in the frozen ordering).
    expect(distinct.size).toBe(seeded.length)
    expect(distinct.has(drifted)).toBe(false)
    for (const id of seeded) expect(distinct.has(id)).toBe(true)
  }, 30_000)

  it('terminates cleanly with no empty/no-op page when frozen rows become ineligible (corpus shrink)', async () => {
    const seeded: string[] = []
    for (let i = 0; i < 5; i++)
      seeded.push(await remember(`${TERM} shrink row ${i} ${crypto.randomUUID()}`))

    const page1 = await searchPage()
    expect(page1.hits.length).toBe(2)
    const shown = new Set(page1.hits.map((h) => h.id))

    // CORPUS SHRINK between requests: archive TWO not-yet-shown frozen rows
    // (status='archived' drops them from the active-only eligibility in
    // fetchHitsByIds). A naive `off + limit` window could then yield an empty
    // page while hasMore stayed true (a dangling "Load more"); continuation must
    // skip the ineligible positions so every page stays full until the real end.
    const notYetShown = seeded.filter((id) => !shown.has(id)).slice(0, 2)
    await ownerPool.query(`UPDATE memories SET status = 'archived' WHERE id = ANY($1)`, [
      notYetShown,
    ])

    const collected = [...page1.hits.map((h) => h.id)]
    let cursor = page1.nextCursor
    let guard = 0
    while (cursor !== undefined && guard++ < 10) {
      const page = await searchPage(cursor)
      // No no-op page: a page is never empty while it claims there is more.
      expect(page.hits.length > 0 || !page.hasMore, 'empty page while hasMore=true').toBe(true)
      collected.push(...page.hits.map((h) => h.id))
      cursor = page.hasMore ? page.nextCursor : undefined
      if (!page.hasMore) break
    }

    const distinct = new Set(collected)
    expect(collected.length).toBe(distinct.size) // no duplicates
    for (const id of notYetShown) expect(distinct.has(id)).toBe(false) // archived rows dropped
    expect(distinct.size).toBe(seeded.length - notYetShown.length) // the other three, no skip
    expect(guard).toBeLessThan(10) // terminated, did not spin
  }, 30_000)

  it('does not advertise a further page when the remaining frozen tail is all ineligible (#377 P2)', async () => {
    const seeded: string[] = []
    for (let i = 0; i < 6; i++)
      seeded.push(await remember(`${TERM} tail row ${i} ${crypto.randomUUID()}`))

    const page1 = await searchPage()
    expect(page1.hits.length).toBe(2)
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBeDefined()

    // Decode the opaque cursor to learn the frozen order, then archive the LAST
    // two not-yet-shown frozen ids — the tail AFTER the next full page. A naive
    // `hasMore = off < ids.length` would then fill page 2 (showing the two
    // eligible mid-tail rows) but still advertise a further page, forcing an
    // empty no-op request before the button clears. The overfetch probe must set
    // hasMore=false on page 2 instead.
    const frozen = JSON.parse(Buffer.from(page1.nextCursor as string, 'base64url').toString()) as {
      ids: string[]
    }
    const tail = frozen.ids.slice(-2)
    await ownerPool.query(`UPDATE memories SET status = 'archived' WHERE id = ANY($1)`, [tail])

    const collected = [...page1.hits.map((h) => h.id)]
    let cursor = page1.nextCursor
    let continuationPages = 0
    let guard = 0
    while (cursor !== undefined && guard++ < 10) {
      const page = await searchPage(cursor)
      continuationPages++
      // The core fix: never return an empty continuation page (the old no-op).
      expect(page.hits.length, 'continuation page must not be empty').toBeGreaterThan(0)
      collected.push(...page.hits.map((h) => h.id))
      cursor = page.hasMore ? page.nextCursor : undefined
      if (!page.hasMore) break
    }

    const distinct = new Set(collected)
    expect(collected.length).toBe(distinct.size) // no duplicates
    expect(distinct.size).toBe(4) // the 4 eligible rows (6 seeded - 2 archived tail)
    for (const id of tail) expect(distinct.has(id)).toBe(false) // archived tail never shown
    // page 1 (2) + exactly one full continuation (2); no trailing no-op page.
    expect(continuationPages).toBe(1)
  }, 30_000)
})
