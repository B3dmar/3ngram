// SPDX-License-Identifier: Apache-2.0
// Unit — the get_memories batched-read tool contract (the follow-up read for a
// truncated search/handoff line). Pins the bounded-batch input (ids 1..20,
// maxContentChars floor/ceiling/default, strict) and the output envelope
// (memories + count + notFound), all at the ONE validation boundary (hard
// rule 2).
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GET_CONTENT_CHARS,
  getMemoriesInputSchema,
  getMemoriesItemSchema,
  getMemoriesOutputSchema,
  MAX_EXCERPT_LENGTH,
  MAX_GET_CONTENT_CHARS,
  MAX_GET_MEMORIES_IDS,
  MAX_GET_TOTAL_CHARS,
  MIN_GET_CONTENT_CHARS,
} from '../src/index.js'

const uuid = () => randomUUID()

describe('getMemoriesInputSchema — bounded batch input', () => {
  it('applies the maxContentChars default and passes ids through', () => {
    const ids = [uuid(), uuid()]
    const parsed = getMemoriesInputSchema.parse({ ids })
    expect(parsed.ids).toEqual(ids)
    expect(parsed.maxContentChars).toBe(DEFAULT_GET_CONTENT_CHARS)
  })

  it('rejects an empty id list and a batch over MAX_GET_MEMORIES_IDS', () => {
    expect(getMemoriesInputSchema.safeParse({ ids: [] }).success).toBe(false)
    const over = Array.from({ length: MAX_GET_MEMORIES_IDS + 1 }, uuid)
    expect(getMemoriesInputSchema.safeParse({ ids: over }).success).toBe(false)
    const atCap = Array.from({ length: MAX_GET_MEMORIES_IDS }, uuid)
    expect(getMemoriesInputSchema.safeParse({ ids: atCap }).success).toBe(true)
  })

  it('rejects non-uuid ids', () => {
    expect(getMemoriesInputSchema.safeParse({ ids: ['not-a-uuid'] }).success).toBe(false)
  })

  it('bounds maxContentChars to [MIN, MAX] and rejects non-integers', () => {
    const ids = [uuid()]
    expect(
      getMemoriesInputSchema.safeParse({ ids, maxContentChars: MIN_GET_CONTENT_CHARS - 1 }).success,
    ).toBe(false)
    expect(
      getMemoriesInputSchema.safeParse({ ids, maxContentChars: MAX_GET_CONTENT_CHARS + 1 }).success,
    ).toBe(false)
    expect(getMemoriesInputSchema.safeParse({ ids, maxContentChars: 1000.5 }).success).toBe(false)
    expect(
      getMemoriesInputSchema.safeParse({ ids, maxContentChars: MIN_GET_CONTENT_CHARS }).success,
    ).toBe(true)
    expect(
      getMemoriesInputSchema.safeParse({ ids, maxContentChars: MAX_GET_CONTENT_CHARS }).success,
    ).toBe(true)
  })

  it('floors maxContentChars at the excerpt cap — expansion never returns less', () => {
    expect(MIN_GET_CONTENT_CHARS).toBe(MAX_EXCERPT_LENGTH)
    const ids = [uuid()]
    expect(
      getMemoriesInputSchema.safeParse({ ids, maxContentChars: MAX_EXCERPT_LENGTH }).success,
    ).toBe(true)
    expect(
      getMemoriesInputSchema.safeParse({ ids, maxContentChars: MAX_EXCERPT_LENGTH - 1 }).success,
    ).toBe(false)
  })

  it('bounds the aggregate response: ids.length × maxContentChars ≤ MAX_GET_TOTAL_CHARS', () => {
    // At the per-item ceiling the batch narrows to exactly the aggregate budget.
    const idsAtBudget = Math.floor(MAX_GET_TOTAL_CHARS / MAX_GET_CONTENT_CHARS)
    const accept = Array.from({ length: idsAtBudget }, uuid)
    expect(
      getMemoriesInputSchema.safeParse({ ids: accept, maxContentChars: MAX_GET_CONTENT_CHARS })
        .success,
    ).toBe(true)
    const reject = Array.from({ length: idsAtBudget + 1 }, uuid)
    expect(
      getMemoriesInputSchema.safeParse({ ids: reject, maxContentChars: MAX_GET_CONTENT_CHARS })
        .success,
    ).toBe(false)
  })

  it('keeps a full batch at the default budget within the aggregate cap', () => {
    expect(MAX_GET_MEMORIES_IDS * DEFAULT_GET_CONTENT_CHARS).toBeLessThanOrEqual(
      MAX_GET_TOTAL_CHARS,
    )
    const ids = Array.from({ length: MAX_GET_MEMORIES_IDS }, uuid)
    expect(getMemoriesInputSchema.safeParse({ ids }).success).toBe(true)
  })

  it('is strict: an unknown key is rejected, never silently dropped', () => {
    expect(getMemoriesInputSchema.safeParse({ ids: [uuid()], scope: 'work' }).success).toBe(false)
  })
})

describe('getMemoriesOutputSchema — envelope with notFound as data', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: uuid(),
    memoryType: 'note',
    topic: 'a topic',
    content: 'a body',
    contentLength: 6,
    truncated: false,
    scope: 'work',
    project: null,
    status: 'active',
    tags: ['a'],
    validFrom: new Date().toISOString(),
    validTo: null,
    recordedAt: new Date().toISOString(),
    ...over,
  })

  it('accepts a found item (commitmentStatus optional) plus notFound ids', () => {
    const result = getMemoriesOutputSchema.parse({
      memories: [item(), item({ memoryType: 'commitment', commitmentStatus: 'open' })],
      count: 2,
      notFound: [uuid()],
    })
    expect(result.count).toBe(2)
    expect(result.notFound).toHaveLength(1)
  })

  it('bounds per-item content at MAX_GET_CONTENT_CHARS (never an import-scale echo)', () => {
    expect(
      getMemoriesItemSchema.safeParse(item({ content: 'x'.repeat(MAX_GET_CONTENT_CHARS + 1) }))
        .success,
    ).toBe(false)
    expect(
      getMemoriesItemSchema.safeParse(item({ content: 'x'.repeat(MAX_GET_CONTENT_CHARS) })).success,
    ).toBe(true)
  })

  it('rejects a count that does not equal memories.length', () => {
    expect(
      getMemoriesOutputSchema.safeParse({ memories: [item()], count: 2, notFound: [] }).success,
    ).toBe(false)
    expect(
      getMemoriesOutputSchema.safeParse({ memories: [], count: 1, notFound: [] }).success,
    ).toBe(false)
    expect(
      getMemoriesOutputSchema.safeParse({ memories: [item()], count: 1, notFound: [] }).success,
    ).toBe(true)
  })

  it('is strict end-to-end: stray envelope or item keys are rejected', () => {
    expect(
      getMemoriesOutputSchema.safeParse({ memories: [], count: 0, notFound: [], extra: 1 }).success,
    ).toBe(false)
    expect(
      getMemoriesItemSchema.safeParse(item({ createdAt: new Date().toISOString() })).success,
    ).toBe(false)
  })
})
