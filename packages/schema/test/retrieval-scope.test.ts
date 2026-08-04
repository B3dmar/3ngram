// SPDX-License-Identifier: Apache-2.0
// Unit — the retrieval-scope policy contract (issue #47): the new
// `set_retrieval_default` configure_scope action variant composed onto the
// shipped action union, the policy record with its ENFORCED mode↔scope
// consistency, and the additive describe_environment output field. Pins
// (1) the shipped variants ride the V2 union untouched while the SHIPPED
// schema stays byte-identical (it must NOT admit the new action), (2) the
// consistency refinement rejects every drifting mode/scope pair on both the
// input variant and the policy record, and (3) the V2 environment report
// REQUIRES the new field (a server that forgets it fails output validation,
// never ships a silent omission).
import { describe, expect, it } from 'vitest'
import {
  configureScopeInputSchema,
  configureScopeInputV2Schema,
  configureScopeOutputV2Schema,
  describeEnvironmentOutputSchema,
  describeEnvironmentOutputV2Schema,
  retrievalScopePolicySchema,
  retrievalScopePolicyScopeRequirements,
  setRetrievalDefaultInputSchema,
} from '../src/index.js'

const ENV_REPORT = {
  capabilities: { tools: ['search'], toolCount: 1, version: '1.0.0' },
  scopes: [],
  stats: {
    memoriesByType: {},
    activeMemories: 0,
    supersededMemories: 0,
    archivedMemories: 0,
    commitmentsByStatus: {},
  },
}

describe('setRetrievalDefaultInputSchema (the new action variant)', () => {
  it('accepts default mode with a scope', () => {
    const parsed = setRetrievalDefaultInputSchema.parse({
      action: 'set_retrieval_default',
      scope: 'work',
      mode: 'default',
    })
    expect(parsed).toEqual({ action: 'set_retrieval_default', scope: 'work', mode: 'default' })
  })

  it.each(['require', 'off'] as const)('accepts %s mode with scope: null', (mode) => {
    expect(
      setRetrievalDefaultInputSchema.parse({ action: 'set_retrieval_default', scope: null, mode }),
    ).toEqual({ action: 'set_retrieval_default', scope: null, mode })
  })

  it("rejects mode 'default' without a scope (nothing to apply)", () => {
    const r = setRetrievalDefaultInputSchema.safeParse({
      action: 'set_retrieval_default',
      scope: null,
      mode: 'default',
    })
    expect(r.success).toBe(false)
  })

  it.each(['require', 'off'] as const)('rejects a carried scope under %s mode', (mode) => {
    const r = setRetrievalDefaultInputSchema.safeParse({
      action: 'set_retrieval_default',
      scope: 'work',
      mode,
    })
    expect(r.success).toBe(false)
  })

  it('rejects a missing scope field entirely (all three fields are required)', () => {
    const r = setRetrievalDefaultInputSchema.safeParse({
      action: 'set_retrieval_default',
      mode: 'off',
    })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown key (strict)', () => {
    const r = setRetrievalDefaultInputSchema.safeParse({
      action: 'set_retrieval_default',
      scope: null,
      mode: 'off',
      extra: true,
    })
    expect(r.success).toBe(false)
  })

  it('rejects a non-kebab-case scope (same contract as memories.scope)', () => {
    const r = setRetrievalDefaultInputSchema.safeParse({
      action: 'set_retrieval_default',
      scope: 'Not Valid',
      mode: 'default',
    })
    expect(r.success).toBe(false)
  })
})

describe('configureScopeInputV2Schema (composed action union)', () => {
  it('routes the new action through the composed union', () => {
    const parsed = configureScopeInputV2Schema.parse({
      action: 'set_retrieval_default',
      scope: 'work',
      mode: 'default',
    })
    expect(parsed.action).toBe('set_retrieval_default')
  })

  it('carries the consistency refinement through the composed union', () => {
    const r = configureScopeInputV2Schema.safeParse({
      action: 'set_retrieval_default',
      scope: null,
      mode: 'default',
    })
    expect(r.success).toBe(false)
  })

  it.each([
    { action: 'list' },
    { action: 'create', name: 'research', aliases: ['r'] },
    { action: 'rename', name: 'research', newName: 'r-and-d' },
    { action: 'set_aliases', name: 'research', aliases: [] },
    { action: 'delete', name: 'research' },
  ])('still admits the shipped $action variant unchanged', (input) => {
    expect(configureScopeInputV2Schema.parse(input)).toEqual(configureScopeInputSchema.parse(input))
  })

  it('the SHIPPED union stays byte-identical: it must NOT admit the new action', () => {
    const r = configureScopeInputSchema.safeParse({
      action: 'set_retrieval_default',
      scope: null,
      mode: 'off',
    })
    expect(r.success).toBe(false)
  })
})

describe('retrievalScopePolicySchema + configureScopeOutputV2Schema', () => {
  it('derives accepted scope nullability from the schema-owned mode rules', () => {
    for (const [mode, requirement] of Object.entries(retrievalScopePolicyScopeRequirements)) {
      const scope = requirement === 'required' ? 'work' : null
      expect(retrievalScopePolicySchema.safeParse({ mode, scope }).success).toBe(true)
      expect(
        retrievalScopePolicySchema.safeParse({ mode, scope: scope === null ? 'work' : null })
          .success,
      ).toBe(false)
    }
  })

  it('accepts a consistent stored policy', () => {
    expect(retrievalScopePolicySchema.parse({ mode: 'default', scope: 'work' })).toEqual({
      mode: 'default',
      scope: 'work',
    })
    expect(retrievalScopePolicySchema.parse({ mode: 'off', scope: null })).toEqual({
      mode: 'off',
      scope: null,
    })
  })

  it('rejects a drifting stored pair (refinement-enforced, not advisory)', () => {
    expect(retrievalScopePolicySchema.safeParse({ mode: 'default', scope: null }).success).toBe(
      false,
    )
    expect(retrievalScopePolicySchema.safeParse({ mode: 'require', scope: 'work' }).success).toBe(
      false,
    )
  })

  it('the output union admits the retrieval_default_set variant', () => {
    const parsed = configureScopeOutputV2Schema.parse({
      action: 'retrieval_default_set',
      policy: { mode: 'require', scope: null },
    })
    expect(parsed).toEqual({
      action: 'retrieval_default_set',
      policy: { mode: 'require', scope: null },
    })
  })
})

describe('describeEnvironmentOutputV2Schema (additive report field)', () => {
  it('requires retrievalScopePolicy — a report without it fails output validation', () => {
    expect(describeEnvironmentOutputV2Schema.safeParse(ENV_REPORT).success).toBe(false)
    const parsed = describeEnvironmentOutputV2Schema.parse({
      ...ENV_REPORT,
      retrievalScopePolicy: { mode: 'off', scope: null },
    })
    expect(parsed.retrievalScopePolicy).toEqual({ mode: 'off', scope: null })
  })

  it('the SHIPPED report schema stays byte-identical: it must NOT admit the field', () => {
    const r = describeEnvironmentOutputSchema.safeParse({
      ...ENV_REPORT,
      retrievalScopePolicy: { mode: 'off', scope: null },
    })
    expect(r.success).toBe(false)
  })

  it('rejects an inconsistent policy inside the report', () => {
    const r = describeEnvironmentOutputV2Schema.safeParse({
      ...ENV_REPORT,
      retrievalScopePolicy: { mode: 'default', scope: null },
    })
    expect(r.success).toBe(false)
  })
})

describe('appliedScope output successors (layer 3)', () => {
  const SEARCH_PAGE = { hits: [], count: 0, hasMore: false }

  it('search V3 admits the echo, keeps V2 refinements, and V2 stays byte-identical', async () => {
    const { searchToolOutputV2Schema, searchToolOutputV3Schema } = await import('../src/index.js')
    expect(
      searchToolOutputV3Schema.parse({ ...SEARCH_PAGE, appliedScope: 'work' }).appliedScope,
    ).toBe('work')
    // Absent echo parses (off/no-policy responses are byte-identical).
    expect('appliedScope' in searchToolOutputV3Schema.parse(SEARCH_PAGE)).toBe(false)
    // V2 consistency refinements carry through the composition.
    expect(
      searchToolOutputV3Schema.safeParse({ ...SEARCH_PAGE, count: 1, appliedScope: 'work' })
        .success,
    ).toBe(false)
    expect(
      searchToolOutputV3Schema.safeParse({ ...SEARCH_PAGE, nextCursor: 'x', appliedScope: 'work' })
        .success,
    ).toBe(false)
    // The SHIPPED V2 schema must NOT admit the new key.
    expect(
      searchToolOutputV2Schema.safeParse({ ...SEARCH_PAGE, appliedScope: 'work' }).success,
    ).toBe(false)
  })

  it('REST search + dashboard responses compose the echo the same way', async () => {
    const { searchRestResponseV2Schema, dashboardSearchResponseV2Schema } = await import(
      '../src/index.js'
    )
    expect(
      searchRestResponseV2Schema.parse({ hits: [], count: 0, appliedScope: 'work' }).appliedScope,
    ).toBe('work')
    expect(
      dashboardSearchResponseV2Schema.parse({ ...SEARCH_PAGE, appliedScope: 'work' }).appliedScope,
    ).toBe('work')
  })

  it('briefing/handoff V4 admit the echo and keep their V3 refinements', async () => {
    const { briefingToolOutputV4Schema, handoffToolOutputV4Schema } = await import(
      '../src/index.js'
    )
    const section = { count: 0, items: [], hasMore: false }
    const briefing = {
      selector: { kind: 'scope', scope: 'work' },
      mode: 'brief',
      generatedAt: '2026-08-04T00:00:00.000Z',
      commitments: section,
      appliedScope: 'work',
    }
    expect(briefingToolOutputV4Schema.parse(briefing).appliedScope).toBe('work')
    // V3 refinement (hasMore consistency) still rejects through V4.
    expect(
      briefingToolOutputV4Schema.safeParse({
        ...briefing,
        commitments: { count: 0, items: [], hasMore: true },
      }).success,
    ).toBe(false)

    const handoff = {
      selector: { kind: 'scope', scope: 'work' },
      generatedFor: null,
      generatedAt: '2026-08-04T00:00:00.000Z',
      decisions: [],
      commitments: [],
      preferences: [],
      notes: [],
      counts: { decisions: 0, commitments: 0, preferences: 0 },
      truncated: { decisions: false, commitments: false, preferences: false },
      appliedScope: 'work',
    }
    expect(handoffToolOutputV4Schema.parse(handoff).appliedScope).toBe('work')
    expect(
      handoffToolOutputV4Schema.safeParse({
        ...handoff,
        truncated: { decisions: true, commitments: false, preferences: false },
      }).success,
    ).toBe(false)
  })
})
