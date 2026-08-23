// SPDX-License-Identifier: Apache-2.0
// Unit tests — no DB. listSessionEvents' PAGING ARITHMETIC and its INDEX-SHAPE
// contract (docs/concepts/session-continuity.mdx layer 3).
//
// Two things are worth pinning without Postgres. First, the boundary algebra:
// `truncated` and `nextCursor` answer different questions (the run exceeds the
// per-run ceiling vs another page exists within it), the limit+1 probe row must
// never be emitted, and the cursor must be the LAST EMITTED id rather than the
// last row fetched. Second, the SQL the reader hands the planner: the predicate
// must be spelled with the same `payload->>'sessionRunId'` expression as
// memory_events_session_idx and must never touch `payload` as a blob — a cast,
// a jsonb_extract_path, or a `->` in place of `->>` silently drops the index.
//
// The end-to-end path (real RLS, a real EXPLAIN, foreign tenants) lives in
// packages/db/test/integration/session-events-read.int.test.ts.
import { MAX_SESSION_EVENT_IDS } from '@3ngram/schema'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { listSessionEvents } from '../src/session-events-read.js'

const USER = '00000000-0000-7000-8000-000000000001'
const RUN = '01890b6e-0000-7000-8000-0000000000aa'
const MEMORY = '01890b6e-0000-7000-8000-0000000000c1'
const NOW = new Date('2026-08-21T12:00:00.000Z')

const eventId = (n: number) => `01890b6e-0000-7000-8000-${String(n).padStart(12, '0')}`

const event = (n: number) => ({
  id: eventId(n),
  memoryId: MEMORY,
  eventKind: 'create',
  actorKind: 'user_mcp',
  sessionRunId: RUN,
  createdAt: NOW,
})

interface Call {
  where: unknown
  offset: number | undefined
  limit: number | undefined
}

/**
 * Fake tenant tx replaying one result set per SELECT (FIFO — the ceiling probe,
 * then the page) and recording each statement's where/offset/limit. Both
 * statements the reader builds terminate at `.limit()`, so that stage resolves
 * the rows and the intermediate stages just chain.
 */
function makeTx(results: Record<string, unknown>[][]) {
  const calls: Call[] = []
  const queue = [...results]
  const tx = {
    select() {
      const call: Call = { where: undefined, offset: undefined, limit: undefined }
      calls.push(call)
      const rows = queue.shift() ?? []
      const builder = {
        from: () => builder,
        where(w: unknown) {
          call.where = w
          return builder
        },
        orderBy: () => builder,
        offset(o: number) {
          call.offset = o
          return builder
        },
        limit(l: number) {
          call.limit = l
          return Promise.resolve(rows)
        },
      }
      return builder
    },
  }
  return { tx: tx as unknown as Parameters<typeof listSessionEvents>[0], calls }
}

/** Flatten a drizzle SQL tree into its literal chunks so a test can read the predicate. */
function sqlText(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'object' && 'queryChunks' in (node as SQL)) {
    return (node as { queryChunks: unknown[] }).queryChunks.map(sqlText).join('')
  }
  if (typeof node === 'object' && 'value' in (node as { value: unknown })) {
    const value = (node as { value: unknown }).value
    return Array.isArray(value) ? value.join('') : String(value)
  }
  if (typeof node === 'object' && 'name' in (node as { name: unknown })) {
    return String((node as { name: unknown }).name)
  }
  return ''
}

describe('listSessionEvents paging', () => {
  it('returns the page and a cursor when more rows exist within the ceiling', async () => {
    const { tx } = makeTx([[], [event(1), event(2), event(3)]])
    const page = await listSessionEvents(tx, USER, RUN, { limit: 2 })
    expect(page.items.map((i) => i.id)).toEqual([eventId(1), eventId(2)])
    expect(page.nextCursor).toBe(eventId(2))
    expect(page.truncated).toBe(false)
  })

  it('drops the probe row rather than emitting it', async () => {
    const { tx, calls } = makeTx([[], [event(1), event(2), event(3)]])
    const page = await listSessionEvents(tx, USER, RUN, { limit: 2 })
    // limit+1 is fetched to detect a next page; only `limit` rows are returned.
    expect(calls[1]?.limit).toBe(3)
    expect(page.items).toHaveLength(2)
  })

  it('ends the walk with no cursor when the page is not full', async () => {
    const { tx } = makeTx([[], [event(1)]])
    const page = await listSessionEvents(tx, USER, RUN, { limit: 2 })
    expect(page.nextCursor).toBeUndefined()
    expect(page.truncated).toBe(false)
  })

  it('returns an empty first page for a run that wrote nothing', async () => {
    const { tx } = makeTx([[], []])
    const page = await listSessionEvents(tx, USER, RUN, { limit: 10 })
    expect(page).toEqual({ items: [], nextCursor: undefined, truncated: false })
  })

  it('probes at the ceiling and defaults it to MAX_SESSION_EVENT_IDS', async () => {
    const { tx, calls } = makeTx([[], []])
    await listSessionEvents(tx, USER, RUN, { limit: 10 })
    expect(calls[0]?.offset).toBe(MAX_SESSION_EVENT_IDS)
    expect(calls[0]?.limit).toBe(1)
  })

  it('honours an injected ceiling so the truncation branch is testable', async () => {
    const { tx, calls } = makeTx([[event(9)], [event(1), event(2)]])
    const page = await listSessionEvents(tx, USER, RUN, { limit: 10, ceiling: 2 })
    expect(calls[0]?.offset).toBe(2)
    expect(page.truncated).toBe(true)
  })

  it('reports truncated but still ends the walk cleanly at the ceiling', async () => {
    // A ceiling row exists (truncated) and the page fits inside it, so the
    // caller gets no cursor: paging must stop at the ceiling, not walk past it.
    const { tx } = makeTx([[event(9)], [event(1), event(2)]])
    const page = await listSessionEvents(tx, USER, RUN, { limit: 10, ceiling: 2 })
    expect(page.items.map((i) => i.id)).toEqual([eventId(1), eventId(2)])
    expect(page.nextCursor).toBeUndefined()
    expect(page.truncated).toBe(true)
  })

  it('rejects a row whose projected key is not a uuid', async () => {
    const { tx } = makeTx([[], [{ ...event(1), sessionRunId: 'not-a-uuid' }]])
    await expect(listSessionEvents(tx, USER, RUN, { limit: 10 })).rejects.toThrow()
  })
})

describe('listSessionEvents index compatibility', () => {
  it('filters on the indexed ->> expression, never on payload as a blob', async () => {
    const { tx, calls } = makeTx([[], []])
    await listSessionEvents(tx, USER, RUN, { limit: 10 })
    for (const call of calls) {
      const text = sqlText(call.where)
      expect(text).toContain(`payload->>'sessionRunId'`)
      // `->` would return jsonb (unindexed); a cast would defeat the expression
      // index just as surely.
      expect(text).not.toMatch(/payload->'sessionRunId'/)
      expect(text).not.toMatch(/payload::/)
      expect(text).toContain('user_id')
    }
  })

  it('keysets on id, not created_at', async () => {
    const { tx, calls } = makeTx([[], []])
    await listSessionEvents(tx, USER, RUN, { limit: 10, cursor: eventId(1) })
    const text = sqlText(calls[1]?.where)
    expect(text).toContain('id > ')
    expect(text).not.toContain('created_at')
  })

  it('bounds the page by the ceiling row id when the run overflows', async () => {
    const { tx, calls } = makeTx([[event(9)], []])
    await listSessionEvents(tx, USER, RUN, { limit: 10, ceiling: 2 })
    expect(sqlText(calls[1]?.where)).toContain('id < ')
  })
})
