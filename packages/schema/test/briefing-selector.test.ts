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
