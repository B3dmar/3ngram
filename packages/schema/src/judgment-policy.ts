// SPDX-License-Identifier: Apache-2.0
// Per-tenant judgment opt-in (issue #225).
//
// Whether this tenant's derived text may be sent to the judgment provider
// (`Gateway.decide()`, TypeSafe AI's Jev) at all. Two modes, default `off`:
// a tenant with no row is `off`, and every caller of decide() on tenant data
// must read this policy first. It is a privacy switch, not a feature flag: the
// deployment must ALSO configure JEV_* for anything to be sent.
//
// REST only (`GET`/`PUT /api/v1/settings/judgment`); no MCP surface, so the
// tool registry and its selection eval are untouched (hard rule 8).
import { z } from 'zod'

/** `off` (default): nothing of this tenant reaches the judgment provider. */
export const judgmentModeSchema = z.enum(['off', 'on'])
export type JudgmentMode = z.infer<typeof judgmentModeSchema>

/** Body of `PUT /api/v1/settings/judgment`: the whole policy, no defaults. */
export const judgmentPolicyBodySchema = z
  .object({
    mode: judgmentModeSchema.describe(
      'on = this tenant opts in to typed judgments by the judgment provider; off = never.',
    ),
  })
  .strict()
export type JudgmentPolicyBody = z.infer<typeof judgmentPolicyBodySchema>

/**
 * The judgment policy as the REST surface reports it. `updatedAt` is null when
 * the tenant never set one (the `off` default is not a stored row).
 */
export const judgmentPolicyResponseSchema = z
  .object({
    mode: judgmentModeSchema,
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict()
export type JudgmentPolicyResponse = z.infer<typeof judgmentPolicyResponseSchema>
