// SPDX-License-Identifier: Apache-2.0
// Unit — the orientation selector V2 (issue #46): the `scope_project` variant
// (scope AND project intersection, opt-in `includeUnscoped` NULL-project
// visibility) and the load-bearing composition property (ADR-0011): the V2
// union is built FROM the shipped variant objects, so a legacy selector parses
// byte-identically through V1 and V2, and V1 keeps rejecting the new kind.
import { describe, expect, it } from 'vitest'
import {
  briefingSelectorSchema,
  briefingSelectorV2Schema,
  briefingToolInputV2Schema,
  briefingToolInputV3Schema,
  briefingToolOutputV3Schema,
  handoffToolInputV2Schema,
  handoffToolInputV3Schema,
  handoffToolOutputV3Schema,
  scopeProjectSelectorSchema,
} from '../src/index.js'

const scopeProject = { kind: 'scope_project', scope: 'work', project: '3ngram' } as const

describe('scopeProjectSelectorSchema — the new variant', () => {
  it('parses with includeUnscoped defaulting to false (strict intersection)', () => {
    const parsed = scopeProjectSelectorSchema.parse(scopeProject)
    expect(parsed).toEqual({ ...scopeProject, includeUnscoped: false })
  })

  it('parses an explicit includeUnscoped on and off', () => {
    expect(
      scopeProjectSelectorSchema.parse({ ...scopeProject, includeUnscoped: true }).includeUnscoped,
    ).toBe(true)
    expect(
      scopeProjectSelectorSchema.parse({ ...scopeProject, includeUnscoped: false }).includeUnscoped,
    ).toBe(false)
  })

  it('requires BOTH scope and project (the intersection is the point)', () => {
    expect(
      scopeProjectSelectorSchema.safeParse({ kind: 'scope_project', scope: 'work' }).success,
    ).toBe(false)
    expect(
      scopeProjectSelectorSchema.safeParse({ kind: 'scope_project', project: '3ngram' }).success,
    ).toBe(false)
  })

  it('stays strict: an unknown key or non-boolean flag is rejected', () => {
    expect(scopeProjectSelectorSchema.safeParse({ ...scopeProject, extra: 1 }).success).toBe(false)
    expect(
      scopeProjectSelectorSchema.safeParse({ ...scopeProject, includeUnscoped: 'yes' }).success,
    ).toBe(false)
  })
})

describe('briefingSelectorV2Schema — the grown union', () => {
  it('accepts all four kinds', () => {
    expect(briefingSelectorV2Schema.safeParse({ kind: 'all' }).success).toBe(true)
    expect(briefingSelectorV2Schema.safeParse({ kind: 'scope', scope: 'work' }).success).toBe(true)
    expect(briefingSelectorV2Schema.safeParse({ kind: 'project', project: '3ngram' }).success).toBe(
      true,
    )
    expect(briefingSelectorV2Schema.safeParse(scopeProject).success).toBe(true)
  })

  it('parses every shipped variant byte-identically to V1 (composed, not redefined)', () => {
    for (const legacy of [
      { kind: 'all' },
      { kind: 'scope', scope: 'work' },
      { kind: 'project', project: '3ngram' },
    ] as const) {
      const v1 = briefingSelectorSchema.parse(legacy)
      const v2 = briefingSelectorV2Schema.parse(legacy)
      expect(JSON.stringify(v2)).toBe(JSON.stringify(v1))
    }
  })

  it('shipped variants stay strict in V2: a scope selector cannot smuggle a project', () => {
    expect(
      briefingSelectorV2Schema.safeParse({ kind: 'scope', scope: 'work', project: '3ngram' })
        .success,
    ).toBe(false)
    expect(
      briefingSelectorV2Schema.safeParse({
        kind: 'project',
        project: '3ngram',
        includeUnscoped: true,
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown kind', () => {
    expect(briefingSelectorV2Schema.safeParse({ kind: 'everything' }).success).toBe(false)
  })

  it('V1 keeps rejecting scope_project (shipped union untouched — opt-in path only)', () => {
    expect(briefingSelectorSchema.safeParse(scopeProject).success).toBe(false)
  })
})

// --- IO V3 (issue #46): the V2 tool IO with the widened selector ---

describe('briefing/handoff IO V3 — safeExtend keeps V2 behavior, widens the selector', () => {
  const legacyInputs = [
    { selector: { kind: 'all' } },
    { selector: { kind: 'scope', scope: 'work' }, mode: 'full', sections: ['overdue'] },
    { selector: { kind: 'project', project: '3ngram' }, sectionLimit: 50 },
  ] as const

  it('parses every V2-valid briefing input identically through V3', () => {
    for (const legacy of legacyInputs) {
      const v2 = briefingToolInputV2Schema.parse(legacy)
      const v3 = briefingToolInputV3Schema.parse(legacy)
      expect(JSON.stringify(v3)).toBe(JSON.stringify(v2))
    }
  })

  it('briefing input V3 accepts scope_project and keeps the V2 knobs beside it', () => {
    const parsed = briefingToolInputV3Schema.parse({
      selector: scopeProject,
      mode: 'full',
      sections: ['commitments'],
      sectionLimit: 60,
    })
    expect(parsed.selector).toEqual({ ...scopeProject, includeUnscoped: false })
    expect(parsed.sectionLimit).toBe(60)
  })

  it('briefing input V3 inherits the V2 refinements (duplicate sections still rejected)', () => {
    expect(
      briefingToolInputV3Schema.safeParse({
        selector: scopeProject,
        sections: ['overdue', 'overdue'],
      }).success,
    ).toBe(false)
    // Strictness inherited too: an unknown key is rejected, never dropped.
    expect(briefingToolInputV3Schema.safeParse({ selector: scopeProject, limit: 5 }).success).toBe(
      false,
    )
  })

  it('handoff input V3 accepts scope_project; V2 parses identically through V3', () => {
    const legacy = { selector: { kind: 'scope', scope: 'work' }, sectionLimit: 30 } as const
    expect(JSON.stringify(handoffToolInputV3Schema.parse(legacy))).toBe(
      JSON.stringify(handoffToolInputV2Schema.parse(legacy)),
    )
    const parsed = handoffToolInputV3Schema.parse({
      selector: { ...scopeProject, includeUnscoped: true },
    })
    expect(parsed.selector).toEqual({ ...scopeProject, includeUnscoped: true })
  })

  it('V2 tool inputs keep rejecting scope_project (successor-only opt-in)', () => {
    expect(briefingToolInputV2Schema.safeParse({ selector: scopeProject }).success).toBe(false)
    expect(handoffToolInputV2Schema.safeParse({ selector: scopeProject }).success).toBe(false)
  })

  it('output V3 echoes a scope_project selector and inherits the consistency refinements', () => {
    const selector = { ...scopeProject, includeUnscoped: true }
    const briefingOut = {
      selector,
      mode: 'brief',
      generatedAt: new Date().toISOString(),
      overdue: { count: 2, items: [], hasMore: true },
    }
    expect(briefingToolOutputV3Schema.parse(briefingOut).selector).toEqual(selector)
    // The inherited hasMore identity still rejects a lying flag.
    expect(
      briefingToolOutputV3Schema.safeParse({
        ...briefingOut,
        overdue: { count: 2, items: [], hasMore: false },
      }).success,
    ).toBe(false)
    const handoffOut = {
      selector,
      generatedFor: null,
      generatedAt: new Date().toISOString(),
      decisions: [],
      commitments: [],
      preferences: [],
      notes: [],
      counts: { decisions: 0, commitments: 0, preferences: 0 },
      truncated: { decisions: false, commitments: false, preferences: false },
    }
    expect(handoffToolOutputV3Schema.parse(handoffOut).selector).toEqual(selector)
    // The inherited counts identity still rejects a lying truncated flag.
    expect(
      handoffToolOutputV3Schema.safeParse({
        ...handoffOut,
        counts: { decisions: 3, commitments: 0, preferences: 0 },
      }).success,
    ).toBe(false)
  })
})
