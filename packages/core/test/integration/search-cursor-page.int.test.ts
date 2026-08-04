// SPDX-License-Identifier: Apache-2.0
// Integration — searchDashboardPage() as the MCP search continuation engine
// (issue #49), against the real runtime role. The REST dashboard walk
// (apps/server search-pagination.int.test.ts) proves stability through the
// transport but DROPS the excerpt triple in its response shape; the MCP tool
// keeps it. This suite proves, at the core seam the tool will call:
//   - a 3-page frozen-ordering walk never duplicates or skips a hit under
//     CONCURRENT ARCHIVE between pages (corpus drift mid-walk);
//   - a row inserted after page 1 is NOT surfaced (frozen pool, not re-ranked);
//   - continuation hits keep the MCP excerpted hit shape: content bounded at
//     MAX_EXCERPT_LENGTH with contentLength/truncated intact (a continuation
//     refetches rows by id — the excerpt policy must be applied there too);
//   - the walk terminates: the final page reports hasMore=false.
//
// Reuses packages/db integration infra (helpers.ts).
import { closeDb } from '@3ngram/db'
import { createFakeGateway } from '@3ngram/llm'
import { EXCERPT_MARKER, MAX_EXCERPT_LENGTH } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { type DashboardSearchPage, searchDashboardPage } from '../../src/read/search.js'

const TERM = 'quantalope'
const gateway = createFakeGateway()

let userId: string

async function seedMemory(content: string): Promise<string> {
  const result = await ownerPool.query(
    `INSERT INTO memories (user_id, memory_type, topic, content, scope, project, content_hash)
     VALUES ($1, 'note', $2, $3, 'work', '3ngram', encode(sha256($4::bytea), 'hex'))
     RETURNING id`,
    [userId, TERM, content, content],
  )
  return result.rows[0].id
}

/** Continuation call: page by position within `prev`'s frozen ordering. */
function nextPage(prev: DashboardSearchPage, limit: number): Promise<DashboardSearchPage> {
  return searchDashboardPage(
    userId,
    TERM,
    { gateway },
    { limit, frozen: { ...prev.frozen, off: prev.nextOffset } },
  )
}

beforeAll(async () => {
  userId = await seedUser('search-cursor-page@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('searchDashboardPage as the MCP continuation engine (#49)', () => {
  it('3-page walk: no duplicate/skip under concurrent archive; drift row not surfaced', async () => {
    const seeded: string[] = []
    for (let i = 0; i < 6; i++) seeded.push(await seedMemory(`${TERM} seeded row ${i}`))

    const page1 = await searchDashboardPage(userId, TERM, { gateway }, { limit: 2 })
    expect(page1.hits).toHaveLength(2)
    expect(page1.hasMore).toBe(true)
    expect(page1.frozen.ids).toHaveLength(seeded.length)

    // CONCURRENT DRIFT between pages: one new matching row (must NOT appear —
    // it is outside the frozen pool) and one not-yet-shown row archived (must
    // drop out with no duplicate or skip around it).
    const drifted = await seedMemory(`${TERM} ${TERM} drift row`)
    const shown = new Set(page1.hits.map((h) => h.id))
    const archived = seeded.find((id) => !shown.has(id)) as string
    await ownerPool.query(`UPDATE memories SET status = 'archived' WHERE id = $1`, [archived])

    const collected = [...page1.hits.map((h) => h.id)]
    let page = page1
    let pages = 1
    while (page.hasMore && pages < 10) {
      page = await nextPage(page, 2)
      collected.push(...page.hits.map((h) => h.id))
      pages++
    }

    expect(page.hasMore).toBe(false) // terminated cleanly
    expect(pages).toBeGreaterThanOrEqual(3) // a real 3-page walk
    const distinct = new Set(collected)
    expect(collected.length, `duplicate ids: ${collected.join(',')}`).toBe(distinct.size)
    expect(distinct.has(drifted)).toBe(false)
    expect(distinct.has(archived)).toBe(false)
    expect(distinct.size).toBe(seeded.length - 1) // everything else, exactly once
  }, 30_000)

  it('continuation hits keep the MCP excerpted shape (bounded content + triple)', async () => {
    // Long bodies on EVERY row so whichever rows land on page 2 must be excerpted.
    const body = `${TERM} ${'x'.repeat(MAX_EXCERPT_LENGTH * 2)}`
    for (let i = 0; i < 4; i++) await seedMemory(`${body} row ${i}`)

    const page1 = await searchDashboardPage(userId, TERM, { gateway }, { limit: 2 })
    expect(page1.hasMore).toBe(true)
    const page2 = await nextPage(page1, 2)

    expect(page2.hits).toHaveLength(2)
    for (const hit of page2.hits) {
      expect(hit.content.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH)
      expect(hit.content.endsWith(EXCERPT_MARKER)).toBe(true)
      expect(hit.truncated).toBe(true)
      expect(hit.contentLength).toBeGreaterThan(MAX_EXCERPT_LENGTH)
      // The frozen page-1 score rides the continuation hit (no re-ranking).
      const pos = page1.frozen.ids.indexOf(hit.id)
      expect(hit.score).toBe(page1.frozen.scores[pos])
    }
  }, 30_000)
})
