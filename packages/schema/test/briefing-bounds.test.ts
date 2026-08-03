// SPDX-License-Identifier: Apache-2.0
// Unit — the briefing/handoff bounds V2 contracts (issue #45): caller-tunable
// sectionLimit (bounded by the server-side ceilings), briefing section
// selection, hasMore/counts/truncated output additions — and the load-bearing
// property that a LEGACY input parses byte-identically through V1 and V2
// (composed successors, ADR-0011; shipped fields untouched).
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BRIEFING_SECTION_NAMES,
  briefingToolInputSchema,
  briefingToolInputV2Schema,
  briefingToolOutputV2Schema,
  handoffToolInputSchema,
  handoffToolInputV2Schema,
  handoffToolOutputV2Schema,
  MAX_BRIEFING_SECTION_CEILING,
  MAX_HANDOFF_SECTION_CEILING,
} from '../src/index.js'

const selector = { kind: 'scope', scope: 'work' } as const

describe('briefingToolInputV2Schema — composed successor input', () => {
  it('parses a legacy input byte-identically to V1 (mode default included)', () => {
    for (const legacy of [{ selector }, { selector, mode: 'full' }] as const) {
      const v1 = briefingToolInputSchema.parse(legacy)
      const v2 = briefingToolInputV2Schema.parse(legacy)
      expect(JSON.stringify(v2)).toBe(JSON.stringify(v1))
    }
  })

  it('accepts a section subset and the full unique set', () => {
    expect(
      briefingToolInputV2Schema.safeParse({ selector, sections: ['commitments', 'overdue'] })
        .success,
    ).toBe(true)
    expect(
      briefingToolInputV2Schema.safeParse({ selector, sections: [...BRIEFING_SECTION_NAMES] })
        .success,
    ).toBe(true)
  })

  it('rejects an empty, unknown, or duplicated sections list', () => {
    expect(briefingToolInputV2Schema.safeParse({ selector, sections: [] }).success).toBe(false)
    expect(briefingToolInputV2Schema.safeParse({ selector, sections: ['nope'] }).success).toBe(
      false,
    )
    expect(
      briefingToolInputV2Schema.safeParse({ selector, sections: ['overdue', 'overdue'] }).success,
    ).toBe(false)
  })

  it('bounds sectionLimit at [1, MAX_BRIEFING_SECTION_CEILING] and rejects non-integers', () => {
    expect(briefingToolInputV2Schema.safeParse({ selector, sectionLimit: 0 }).success).toBe(false)
    expect(briefingToolInputV2Schema.safeParse({ selector, sectionLimit: 1 }).success).toBe(true)
    expect(
      briefingToolInputV2Schema.safeParse({ selector, sectionLimit: MAX_BRIEFING_SECTION_CEILING })
        .success,
    ).toBe(true)
    expect(
      briefingToolInputV2Schema.safeParse({
        selector,
        sectionLimit: MAX_BRIEFING_SECTION_CEILING + 1,
      }).success,
    ).toBe(false)
    expect(briefingToolInputV2Schema.safeParse({ selector, sectionLimit: 2.5 }).success).toBe(false)
  })

  it('keeps the ceiling above the shipped fixed cap (100 admits the lossy corpora)', () => {
    expect(MAX_BRIEFING_SECTION_CEILING).toBe(100)
    expect(MAX_HANDOFF_SECTION_CEILING).toBe(100)
  })

  it('stays strict: an unknown key is rejected, never silently dropped', () => {
    expect(briefingToolInputV2Schema.safeParse({ selector, limit: 10 }).success).toBe(false)
  })

  it('still requires the selector (no-firehose is untouched)', () => {
    expect(briefingToolInputV2Schema.safeParse({ sectionLimit: 5 }).success).toBe(false)
  })
})

describe('handoffToolInputV2Schema — composed successor input', () => {
  it('parses a legacy input byte-identically to V1', () => {
    for (const legacy of [{ selector }, { selector, generatedFor: 'codex' }] as const) {
      const v1 = handoffToolInputSchema.parse(legacy)
      const v2 = handoffToolInputV2Schema.parse(legacy)
      expect(JSON.stringify(v2)).toBe(JSON.stringify(v1))
    }
  })

  it('bounds sectionLimit at [1, MAX_HANDOFF_SECTION_CEILING]', () => {
    expect(handoffToolInputV2Schema.safeParse({ selector, sectionLimit: 0 }).success).toBe(false)
    expect(handoffToolInputV2Schema.safeParse({ selector, sectionLimit: 1 }).success).toBe(true)
    expect(
      handoffToolInputV2Schema.safeParse({ selector, sectionLimit: MAX_HANDOFF_SECTION_CEILING })
        .success,
    ).toBe(true)
    expect(
      handoffToolInputV2Schema.safeParse({
        selector,
        sectionLimit: MAX_HANDOFF_SECTION_CEILING + 1,
      }).success,
    ).toBe(false)
  })

  it('stays strict and has no sections axis (a handoff exports all three lists)', () => {
    expect(handoffToolInputV2Schema.safeParse({ selector, sections: ['decisions'] }).success).toBe(
      false,
    )
  })
})

const commitmentItem = () => ({
  id: randomUUID(),
  memoryId: randomUUID(),
  topic: 'ship it',
  status: 'open',
  dueAt: null,
  overdue: false,
})

const memoryItem = (memoryType = 'decision') => ({
  id: randomUUID(),
  memoryType,
  topic: 'a topic',
  scope: 'work',
  project: null,
  recordedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

const sectionOf = <T>(items: T[], count = items.length) => ({
  count,
  items,
  hasMore: count > items.length,
})

describe('briefingToolOutputV2Schema — sections gain hasMore, subsets omit keys', () => {
  const fullEnvelope = () => ({
    selector,
    mode: 'full',
    generatedAt: new Date().toISOString(),
    commitments: sectionOf([commitmentItem()]),
    overdue: sectionOf([], 0),
    blockers: sectionOf([memoryItem('blocker')]),
    staleCandidates: sectionOf([], 0),
    recentDecisions: sectionOf([memoryItem()], 5),
    preferences: sectionOf([memoryItem('preference')]),
  })

  it('accepts the all-sections envelope with consistent hasMore flags', () => {
    const parsed = briefingToolOutputV2Schema.parse(fullEnvelope())
    expect(parsed.recentDecisions?.hasMore).toBe(true)
    expect(parsed.commitments?.hasMore).toBe(false)
  })

  it('accepts a subset envelope — un-requested sections are omitted, not zeroed', () => {
    const subset = {
      selector,
      mode: 'brief',
      generatedAt: new Date().toISOString(),
      overdue: sectionOf([commitmentItem()], 3),
    }
    const parsed = briefingToolOutputV2Schema.parse(subset)
    expect(parsed.overdue?.hasMore).toBe(true)
    expect(parsed.commitments).toBeUndefined()
  })

  it('rejects a hasMore flag inconsistent with count vs items.length', () => {
    const lying = fullEnvelope()
    lying.recentDecisions = { count: 5, items: [memoryItem()], hasMore: false }
    expect(briefingToolOutputV2Schema.safeParse(lying).success).toBe(false)
    const inflated = fullEnvelope()
    inflated.commitments = { count: 1, items: [commitmentItem()], hasMore: true }
    expect(briefingToolOutputV2Schema.safeParse(inflated).success).toBe(false)
  })

  it('rejects a count under-reporting the returned slice', () => {
    const under = fullEnvelope()
    under.blockers = { count: 0, items: [memoryItem('blocker')], hasMore: false }
    expect(briefingToolOutputV2Schema.safeParse(under).success).toBe(false)
  })

  it('stays strict on the envelope and each section', () => {
    expect(briefingToolOutputV2Schema.safeParse({ ...fullEnvelope(), extra: 1 }).success).toBe(
      false,
    )
    const strayKey = {
      ...fullEnvelope(),
      overdue: { count: 0, items: [], hasMore: false, total: 0 },
    }
    expect(briefingToolOutputV2Schema.safeParse(strayKey).success).toBe(false)
  })
})

describe('handoffToolOutputV2Schema — counts + per-section truncated flags', () => {
  const handoffMemory = (memoryType = 'decision') => ({
    id: randomUUID(),
    memoryType,
    topic: 'a topic',
    content: 'a body',
    contentLength: 6,
    truncated: false,
    scope: 'work',
    project: null,
  })

  const envelope = () => ({
    selector,
    generatedFor: null,
    generatedAt: new Date().toISOString(),
    decisions: [handoffMemory()],
    commitments: [
      {
        id: randomUUID(),
        memoryId: randomUUID(),
        topic: 'ship it',
        status: 'open',
        dueAt: null,
      },
    ],
    preferences: [handoffMemory('preference')],
    notes: [],
    counts: { decisions: 1, commitments: 1, preferences: 1 },
    truncated: { decisions: false, commitments: false, preferences: false },
  })

  it('accepts consistent counts and truncated flags (exact totals beyond the slice)', () => {
    const ok = envelope()
    ok.counts.decisions = 40
    ok.truncated.decisions = true
    const parsed = handoffToolOutputV2Schema.parse(ok)
    expect(parsed.counts.decisions).toBe(40)
    expect(parsed.truncated.decisions).toBe(true)
  })

  it('rejects a truncated flag inconsistent with counts vs list length', () => {
    const lying = envelope()
    lying.counts.preferences = 9
    // truncated.preferences stays false — inconsistent with 9 > 1.
    expect(handoffToolOutputV2Schema.safeParse(lying).success).toBe(false)
    const inflated = envelope()
    inflated.truncated.commitments = true
    expect(handoffToolOutputV2Schema.safeParse(inflated).success).toBe(false)
  })

  it('rejects a count under-reporting the exported slice', () => {
    const under = envelope()
    under.counts.commitments = 0
    under.truncated.commitments = false
    expect(handoffToolOutputV2Schema.safeParse(under).success).toBe(false)
  })

  it('requires counts and truncated on the V2 envelope and stays strict', () => {
    const { counts: _c, truncated: _t, ...withoutAdditions } = envelope()
    expect(handoffToolOutputV2Schema.safeParse(withoutAdditions).success).toBe(false)
    expect(handoffToolOutputV2Schema.safeParse({ ...envelope(), extra: 1 }).success).toBe(false)
  })
})
