// SPDX-License-Identifier: Apache-2.0
// Unit — describe_environment output successors (issue #321 onward). Pins that
// the V3 report REQUIRES the authenticated account identity as a uuid (a server
// that forgets it, or reports a non-uuid such as a scope name, fails output
// validation), that the identity carries nothing but the id, that V2 stays
// byte-identical, and that the advertised JSON Schema stays open (issue #154).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  accountIdentitySchema,
  describeEnvironmentOutputV2Schema,
  describeEnvironmentOutputV3Schema,
} from '../src/index.js'

const ACCOUNT_ID = '0197f3a1-3b7c-7c9a-9f2e-0000000000aa'

const V2_REPORT = {
  capabilities: { tools: ['describe_environment'], toolCount: 1, version: '1.0.0' },
  scopes: [],
  retrievalScopePolicy: { mode: 'off', scope: null },
  stats: {
    memoriesByType: {},
    activeMemories: 0,
    supersededMemories: 0,
    archivedMemories: 0,
    commitmentsByStatus: {},
  },
} as const

describe('describeEnvironmentOutputV3Schema (account identity, issue #321)', () => {
  it('requires account — a report without it fails output validation', () => {
    expect(describeEnvironmentOutputV3Schema.safeParse(V2_REPORT).success).toBe(false)
    const parsed = describeEnvironmentOutputV3Schema.parse({
      ...V2_REPORT,
      account: { id: ACCOUNT_ID },
    })
    expect(parsed.account).toEqual({ id: ACCOUNT_ID })
  })

  it.each([
    ['a scope name', 'work'],
    ['an empty string', ''],
    ['an email', 'someone@example.test'],
  ])('rejects %s as the account id (only a uuid identifies an account)', (_label, id) => {
    expect(
      describeEnvironmentOutputV3Schema.safeParse({ ...V2_REPORT, account: { id } }).success,
    ).toBe(false)
  })

  it('the identity carries ONLY the id: no email, label, or credential field rides along', () => {
    for (const extra of [
      { email: 'someone@example.test' },
      { label: 'Work account' },
      { clientId: 'cl_123' },
    ]) {
      expect(accountIdentitySchema.safeParse({ id: ACCOUNT_ID, ...extra }).success).toBe(false)
    }
  })

  it('keeps the V2 refinements (an inconsistent policy still fails)', () => {
    const r = describeEnvironmentOutputV3Schema.safeParse({
      ...V2_REPORT,
      retrievalScopePolicy: { mode: 'default', scope: null },
      account: { id: ACCOUNT_ID },
    })
    expect(r.success).toBe(false)
  })

  it('the SHIPPED V2 schema stays byte-identical: it must NOT admit the field', () => {
    expect(
      describeEnvironmentOutputV2Schema.safeParse({ ...V2_REPORT, account: { id: ACCOUNT_ID } })
        .success,
    ).toBe(false)
  })

  it('advertises open at the root and on the account node (parse stays strict)', () => {
    const json = z.toJSONSchema(describeEnvironmentOutputV3Schema, { io: 'output' }) as {
      additionalProperties?: unknown
      required?: string[]
      properties: { account: { additionalProperties?: unknown; required?: string[] } }
    }
    expect(json.additionalProperties).toBe(true)
    expect(json.required).toContain('account')
    expect(json.properties.account.additionalProperties).toBe(true)
    expect(json.properties.account.required).toEqual(['id'])
  })
})
