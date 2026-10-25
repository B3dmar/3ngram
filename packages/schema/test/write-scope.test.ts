// SPDX-License-Identifier: Apache-2.0
// Unit — the write-scope policy contract (issue #235): the `set_write_default`
// configure_scope action composed onto the V2 action union, the policy record
// with its enforced mode/scope consistency, and the describe_environment V3
// field. The V2 schemas stay byte-identical: they must NOT admit the new
// action, result, or report field.
import { describe, expect, it } from 'vitest'
import {
  configureScopeInputV2Schema,
  configureScopeInputV3Schema,
  configureScopeOutputV2Schema,
  configureScopeOutputV3Schema,
  describeEnvironmentOutputV2Schema,
  describeEnvironmentOutputWithWritePolicySchema,
  describeEnvironmentWritePolicyFields,
  retrievalScopeModeSchema,
  setWriteDefaultInputSchema,
  writeScopeModeSchema,
  writeScopePolicySchema,
  writeScopePolicyScopeRequirements,
} from '../src/index.js'

const ENV_REPORT_V2 = {
  capabilities: { tools: ['search'], toolCount: 1, version: '1.0.0' },
  scopes: [],
  stats: {
    memoriesByType: {},
    activeMemories: 0,
    supersededMemories: 0,
    archivedMemories: 0,
    commitmentsByStatus: {},
  },
  retrievalScopePolicy: { mode: 'off', scope: null },
}

describe('writeScopeModeSchema', () => {
  it('is the same three-mode vocabulary as the retrieval policy', () => {
    expect(writeScopeModeSchema.options).toEqual(['off', 'default', 'require'])
    expect(writeScopeModeSchema.options).toEqual(retrievalScopeModeSchema.options)
    expect(writeScopePolicyScopeRequirements).toEqual({
      off: 'forbidden',
      default: 'required',
      require: 'forbidden',
    })
  })
})

describe('setWriteDefaultInputSchema', () => {
  it('accepts default mode with a scope', () => {
    expect(
      setWriteDefaultInputSchema.parse({
        action: 'set_write_default',
        scope: 'work',
        mode: 'default',
      }),
    ).toEqual({ action: 'set_write_default', scope: 'work', mode: 'default' })
  })

  it.each(['require', 'off'] as const)('accepts %s mode with scope: null', (mode) => {
    expect(
      setWriteDefaultInputSchema.parse({ action: 'set_write_default', scope: null, mode }),
    ).toEqual({ action: 'set_write_default', scope: null, mode })
  })

  it.each([
    ['default', null],
    ['require', 'work'],
    ['off', 'work'],
  ] as const)('rejects the inconsistent pair mode %s / scope %s', (mode, scope) => {
    const r = setWriteDefaultInputSchema.safeParse({ action: 'set_write_default', scope, mode })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.path).toEqual(['scope'])
  })

  it('requires every field: no defaults, so the whole policy is stated at once', () => {
    expect(
      setWriteDefaultInputSchema.safeParse({ action: 'set_write_default', mode: 'off' }).success,
    ).toBe(false)
    expect(
      setWriteDefaultInputSchema.safeParse({ action: 'set_write_default', scope: null }).success,
    ).toBe(false)
  })

  it('rejects an unknown mode, a malformed scope, and stray keys', () => {
    const base = { action: 'set_write_default', scope: 'work', mode: 'default' }
    expect(setWriteDefaultInputSchema.safeParse({ ...base, mode: 'always' }).success).toBe(false)
    expect(setWriteDefaultInputSchema.safeParse({ ...base, scope: 'Work Stuff' }).success).toBe(
      false,
    )
    expect(setWriteDefaultInputSchema.safeParse({ ...base, account: 'other' }).success).toBe(false)
  })
})

describe('configureScopeInputV3Schema', () => {
  it('admits set_write_default and still admits the V2 actions', () => {
    expect(
      configureScopeInputV3Schema.parse({
        action: 'set_write_default',
        scope: null,
        mode: 'require',
      }),
    ).toEqual({ action: 'set_write_default', scope: null, mode: 'require' })
    expect(
      configureScopeInputV3Schema.parse({
        action: 'set_retrieval_default',
        scope: null,
        mode: 'off',
      }),
    ).toEqual({ action: 'set_retrieval_default', scope: null, mode: 'off' })
    expect(configureScopeInputV3Schema.parse({ action: 'list' })).toEqual({ action: 'list' })
  })

  it('the V2 union stays byte-identical: it must NOT admit set_write_default', () => {
    expect(
      configureScopeInputV2Schema.safeParse({
        action: 'set_write_default',
        scope: null,
        mode: 'off',
      }).success,
    ).toBe(false)
  })

  it('applies the consistency refinement inside the union', () => {
    expect(
      configureScopeInputV3Schema.safeParse({
        action: 'set_write_default',
        scope: null,
        mode: 'default',
      }).success,
    ).toBe(false)
  })
})

describe('writeScopePolicySchema + configureScopeOutputV3Schema', () => {
  it('rejects an inconsistent stored policy', () => {
    expect(writeScopePolicySchema.safeParse({ mode: 'default', scope: null }).success).toBe(false)
    expect(writeScopePolicySchema.safeParse({ mode: 'off', scope: 'work' }).success).toBe(false)
  })

  it('echoes the stored policy as write_default_set; V2 output does not admit it', () => {
    const result = { action: 'write_default_set', policy: { mode: 'default', scope: 'work' } }
    expect(configureScopeOutputV3Schema.parse(result)).toEqual(result)
    expect(configureScopeOutputV2Schema.safeParse(result).success).toBe(false)
  })
})

describe('describeEnvironmentOutputWithWritePolicySchema', () => {
  it('requires writeScopePolicy next to retrievalScopePolicy', () => {
    expect(describeEnvironmentOutputWithWritePolicySchema.safeParse(ENV_REPORT_V2).success).toBe(
      false,
    )
    const parsed = describeEnvironmentOutputWithWritePolicySchema.parse({
      ...ENV_REPORT_V2,
      writeScopePolicy: { mode: 'off', scope: null },
    })
    expect(parsed.writeScopePolicy).toEqual({ mode: 'off', scope: null })
    expect(parsed.retrievalScopePolicy).toEqual({ mode: 'off', scope: null })
  })

  it('rejects an inconsistent write policy inside the report', () => {
    expect(
      describeEnvironmentOutputWithWritePolicySchema.safeParse({
        ...ENV_REPORT_V2,
        writeScopePolicy: { mode: 'default', scope: null },
      }).success,
    ).toBe(false)
  })

  it('exports the field fragment so a later report successor composes it in one line', () => {
    expect(Object.keys(describeEnvironmentWritePolicyFields)).toEqual(['writeScopePolicy'])
    const composed = describeEnvironmentOutputV2Schema.safeExtend(
      describeEnvironmentWritePolicyFields,
    )
    expect(
      composed.parse({ ...ENV_REPORT_V2, writeScopePolicy: { mode: 'require', scope: null } })
        .writeScopePolicy,
    ).toEqual({ mode: 'require', scope: null })
  })

  it('the V2 report schema stays byte-identical: it must NOT admit the field', () => {
    expect(
      describeEnvironmentOutputV2Schema.safeParse({
        ...ENV_REPORT_V2,
        writeScopePolicy: { mode: 'off', scope: null },
      }).success,
    ).toBe(false)
  })
})
