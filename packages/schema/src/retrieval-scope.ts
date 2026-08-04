// SPDX-License-Identifier: Apache-2.0
// Per-user retrieval-scope policy (issue #47, epic #42).
//
// The contract for binding a session's READS to a scope: a per-user setting
// with three modes — `off` (today's behavior), `default` (an unscoped read is
// narrowed to the configured scope and the response ECHOES `appliedScope`,
// never silently), `require` (an unscoped read is a typed error naming the
// registered scopes). Managed through a NEW `configure_scope` ACTION VARIANT
// (`set_retrieval_default`) — the action union grows, no new tool slot — and
// REPORTED via an additive `describe_environment` output field.
//
// A SEPARATE module from mcp.ts (which is past the 500-line file cap) so the
// contract stays bounded and reviewable (get-memories.ts / search-cursor.ts
// precedent) — same one-validation-boundary rules (hard rule 2), same
// composed-schema pattern (successor schemas compose over shipped ones;
// shipped variants stay byte-identical).
import { z } from 'zod'
import {
  configureScopeInputSchema,
  configureScopeOutputSchema,
  describeEnvironmentOutputSchema,
  scopeNameSchema,
} from './mcp.js'

/**
 * The retrieval-scope enforcement mode. Single source for the DB CHECK
 * (packages/db enumCheckSql — the Zod→CHECK strategy) and every transport:
 *
 * - `off`     : no enforcement — an unscoped read behaves exactly as shipped.
 * - `default` : an unscoped read (no `scope` filter on search; selector
 *   `kind: 'all'` on briefing/handoff) is narrowed to the configured scope and
 *   the response echoes `appliedScope` — narrowing is never silent.
 * - `require` : an unscoped read is a typed error naming the registered
 *   scopes — forces explicitness; recommended for privacy-sensitive use.
 */
export const retrievalScopeModeSchema = z.enum(['off', 'default', 'require'])
export type RetrievalScopeMode = z.infer<typeof retrievalScopeModeSchema>

/**
 * The stored policy as every surface reports it: the mode plus the configured
 * scope. CONSISTENCY IS ENFORCED, not advisory (refinement, same discipline as
 * the get-memories/search-cursor output contracts): `default` REQUIRES a
 * scope (there is nothing to apply without one); `require`/`off` FORBID one
 * (neither mode ever applies a scope, so a carried value could only drift).
 * The DB row carries the same CHECK (packages/db user_retrieval_policy).
 */
export const retrievalScopePolicySchema = z
  .object({
    mode: retrievalScopeModeSchema,
    scope: scopeNameSchema.nullable(),
  })
  .strict()
  .refine((p) => (p.mode === 'default') === (p.scope !== null), {
    message: "mode 'default' requires a scope; 'require' and 'off' take scope: null",
    path: ['scope'],
  })
export type RetrievalScopePolicy = z.infer<typeof retrievalScopePolicySchema>

/**
 * The NEW `configure_scope` action variant: set (or clear) the per-user
 * retrieval-scope policy. All three fields are REQUIRED (`.strict()`, no
 * defaults) so a caller states the full policy in one atomic action — there is
 * no partial update to mis-merge. The same mode↔scope consistency refinement
 * as {@link retrievalScopePolicySchema} applies at this ONE boundary (hard
 * rule 2); "scope exists in the registry" is the handler's semantic check
 * (registry state is not a shape concern).
 */
export const setRetrievalDefaultInputSchema = z
  .object({
    action: z.literal('set_retrieval_default'),
    scope: scopeNameSchema.nullable(),
    mode: retrievalScopeModeSchema,
  })
  .strict()
  .refine((p) => (p.mode === 'default') === (p.scope !== null), {
    message: "mode 'default' requires a scope; 'require' and 'off' take scope: null",
    path: ['scope'],
  })
export type SetRetrievalDefaultInput = z.infer<typeof setRetrievalDefaultInputSchema>

/**
 * `configure_scope` input V2: the shipped action union COMPOSED with the new
 * `set_retrieval_default` variant — the shipped variants ride through
 * UNTOUCHED (byte-stable growth, the issue-#47 design: action unions grow, no
 * new tool slot; same composition pattern as searchQueryV3Schema).
 */
export const configureScopeInputV2Schema = z.discriminatedUnion('action', [
  ...configureScopeInputSchema.options,
  setRetrievalDefaultInputSchema,
])
export type ConfigureScopeInputV2 = z.infer<typeof configureScopeInputV2Schema>

/**
 * `configure_scope` output V2: the shipped result union COMPOSED with the new
 * `retrieval_default_set` variant, which echoes the STORED policy (the
 * consistency-refined record — what the next `describe_environment` will
 * report), so a caller never has to re-read to confirm the setting.
 */
export const configureScopeOutputV2Schema = z.discriminatedUnion('action', [
  ...configureScopeOutputSchema.options,
  z
    .object({
      action: z.literal('retrieval_default_set'),
      policy: retrievalScopePolicySchema,
    })
    .strict(),
])
export type ConfigureScopeOutputV2 = z.infer<typeof configureScopeOutputV2Schema>

/**
 * `describe_environment` output V2: the shipped report EXTENDED with the
 * active retrieval-scope policy (additive field, issue #47). ALWAYS present —
 * a user who never configured one reports `{ mode: 'off', scope: null }`, so
 * a session can rely on the field to know how its reads will behave.
 * REDACTION posture unchanged (hard rule 6): the field carries a bounded mode
 * enum and a registered scope NAME (a user label) — never an env value, DSN,
 * key, or base URL.
 */
export const describeEnvironmentOutputV2Schema = describeEnvironmentOutputSchema.safeExtend({
  retrievalScopePolicy: retrievalScopePolicySchema,
})
export type DescribeEnvironmentOutputV2 = z.infer<typeof describeEnvironmentOutputV2Schema>
