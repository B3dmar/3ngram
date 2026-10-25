// SPDX-License-Identifier: Apache-2.0
// Per-user write-scope policy (issue #235).
//
// The WRITE-side sibling of the retrieval-scope policy (retrieval-scope.ts):
// where a `remember` that omits `scope` lands. Three modes, the same enum the
// retrieval policy uses so a tenant learns one vocabulary:
//
// - `off`     : the shipped behavior — an omitted scope is `personal`.
// - `default` : an omitted scope is filled with the configured scope.
// - `require` : an omitted scope is a typed error; the caller must pass one.
//
// Managed through a NEW `configure_scope` ACTION VARIANT (`set_write_default`)
// — the action union grows, no new tool slot (hard rule 8) — and REPORTED via
// an additive `describe_environment` output field next to
// `retrievalScopePolicy`. An explicit `scope` on the write always wins.
//
// A separate module (retrieval-scope.ts precedent) so the contract stays
// bounded; the shipped V2 schemas it composes over stay byte-identical.
import { z } from 'zod'
import { scopeNameSchema } from './mcp.js'
import { OPEN_OUTPUT_META } from './output-openness.js'
import {
  configureScopeInputV2Schema,
  configureScopeOutputV2Schema,
  describeEnvironmentOutputV2Schema,
  retrievalScopeModeSchema,
  retrievalScopePolicyScopeRequirements,
} from './retrieval-scope.js'

/**
 * The write-scope mode. The SAME enum as the retrieval mode (identical values,
 * one vocabulary); a separate export so the DB CHECK and the docs name the
 * write policy explicitly.
 */
export const writeScopeModeSchema = retrievalScopeModeSchema
export type WriteScopeMode = z.infer<typeof writeScopeModeSchema>

/**
 * Mode-to-scope requirements, consumed by the DB consistency CHECK as well:
 * `default` needs a scope to fill with; `off`/`require` never fill, so a carried
 * scope could only drift.
 */
export const writeScopePolicyScopeRequirements = retrievalScopePolicyScopeRequirements

function hasConsistentWriteScope(policy: { mode: WriteScopeMode; scope: string | null }): boolean {
  return (writeScopePolicyScopeRequirements[policy.mode] === 'required') === (policy.scope !== null)
}

const CONSISTENCY_MESSAGE = "mode 'default' requires a scope; 'require' and 'off' take scope: null"

/**
 * The stored write policy as every surface reports it. Consistency is enforced
 * here and by the DB CHECK on user_write_scope_policy.
 */
export const writeScopePolicySchema = z
  .object({
    mode: writeScopeModeSchema,
    scope: scopeNameSchema.nullable(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
  .refine(hasConsistentWriteScope, { message: CONSISTENCY_MESSAGE, path: ['scope'] })
export type WriteScopePolicy = z.infer<typeof writeScopePolicySchema>

/**
 * The NEW `configure_scope` action: set (or clear) where an unscoped
 * `remember` lands. Every field is required, no defaults, so the whole policy
 * is stated in one action. Registry existence of `scope` is the handler's
 * check (state, not shape); the scope must be the canonical registered name.
 */
export const setWriteDefaultInputSchema = z
  .object({
    action: z.literal('set_write_default'),
    scope: scopeNameSchema
      .nullable()
      .describe(
        'Registered scope that a remember without scope lands in (mode default), else null.',
      ),
    mode: writeScopeModeSchema.describe(
      'Write policy for remember without scope: off = personal, default = scope above, require = reject.',
    ),
  })
  .strict()
  .refine(hasConsistentWriteScope, { message: CONSISTENCY_MESSAGE, path: ['scope'] })
export type SetWriteDefaultInput = z.infer<typeof setWriteDefaultInputSchema>

/** `configure_scope` input V3: the V2 union plus `set_write_default`. */
export const configureScopeInputV3Schema = z.discriminatedUnion('action', [
  ...configureScopeInputV2Schema.options,
  setWriteDefaultInputSchema,
])
export type ConfigureScopeInputV3 = z.infer<typeof configureScopeInputV3Schema>

/**
 * `configure_scope` output V3: the V2 union plus `write_default_set`, which
 * echoes the STORED write policy (what describe_environment will report next).
 */
export const configureScopeOutputV3Schema = z.discriminatedUnion('action', [
  ...configureScopeOutputV2Schema.options,
  z
    .object({
      action: z.literal('write_default_set'),
      policy: writeScopePolicySchema,
    })
    .strict()
    .meta(OPEN_OUTPUT_META),
])
export type ConfigureScopeOutputV3 = z.infer<typeof configureScopeOutputV3Schema>

/**
 * `describe_environment` output V3: V2 plus the effective write policy. ALWAYS
 * present: a tenant that never configured one reports `{ mode: 'off', scope:
 * null }`. A mode enum and a scope name only, so the redaction posture holds.
 */
export const describeEnvironmentOutputV3Schema = describeEnvironmentOutputV2Schema
  .safeExtend({
    writeScopePolicy: writeScopePolicySchema,
  })
  .meta(OPEN_OUTPUT_META)
export type DescribeEnvironmentOutputV3 = z.infer<typeof describeEnvironmentOutputV3Schema>
