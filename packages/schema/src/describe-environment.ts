// SPDX-License-Identifier: Apache-2.0
// describe_environment output successors (issues #321, #168 onward).
//
// Each additive field gets its own versioned schema composed from the previous
// one with `.safeExtend()`, and the openness marker is REAPPLIED at every level
// (output-openness.ts: composition does not inherit metadata). A later field
// (issue #235's `writeScopePolicy`) extends the newest schema here the same way.
import { z } from 'zod'
import { OPEN_OUTPUT_META } from './output-openness.js'
import { memoriesFacetsResponseSchema } from './rest.js'
import { describeEnvironmentOutputV2Schema } from './retrieval-scope.js'

/**
 * The authenticated account's identity (issue #321).
 *
 * `id` is the uuid of the 3ngram account the request authenticated as — the
 * `users.id` primary key, and the same value `GET /api/v1/me` returns as `id`.
 * It is stable for the account's lifetime across every OAuth client and API
 * key, and two accounts never share one, so two connectors that report the
 * same `id` reach the same memory corpus. It is NOT a secret, NOT a scope or
 * project, and NOT derived from either or from memory content. No email,
 * display name, token or credential metadata rides here: the identity model
 * has no display label, so none is reported.
 */
export const accountIdentitySchema = z
  .object({
    id: z
      .uuid()
      .describe(
        'Stable id of the authenticated 3ngram account (equals GET /api/v1/me id). Not a scope or project.',
      ),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type AccountIdentity = z.infer<typeof accountIdentitySchema>

/**
 * `describe_environment` output V3: the V2 report (retrieval-scope policy)
 * plus the authenticated `account` identity. ALWAYS present: a request whose
 * account no longer exists fails (`account_deleted`) instead of reporting one.
 */
export const describeEnvironmentOutputV3Schema = describeEnvironmentOutputV2Schema
  .safeExtend({
    account: accountIdentitySchema,
  })
  .meta(OPEN_OUTPUT_META)
export type DescribeEnvironmentOutputV3 = z.infer<typeof describeEnvironmentOutputV3Schema>

/**
 * The tenant's scope/project inventory as describe_environment inlines it
 * (issue #168): the SAME `{ scopes, projects }` payload REST
 * `GET /api/v1/memories/facets` and the `threengram://facets` resource serve,
 * built from the same element schemas, so a host that never surfaces resources
 * to the model still sees it. `scopes` are scopes holding LIVE memories — a
 * registered scope with none appears in the report's `scopes` registry list,
 * not here. Labels only, never memory content; empty arrays for an empty
 * account. A scope name is a filing label: it never identifies an account.
 */
export const environmentFacetsSchema = z
  .object({
    scopes: memoriesFacetsResponseSchema.shape.scopes.describe(
      'Scope names your live memories are filed under.',
    ),
    projects: memoriesFacetsResponseSchema.shape.projects.describe(
      'Project names on your live memories.',
    ),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type EnvironmentFacets = z.infer<typeof environmentFacetsSchema>

/**
 * `describe_environment` output V4: V3 (account identity) plus the inlined
 * `facets` inventory. ALWAYS present (empty arrays when there is nothing).
 */
export const describeEnvironmentOutputV4Schema = describeEnvironmentOutputV3Schema
  .safeExtend({
    facets: environmentFacetsSchema,
  })
  .meta(OPEN_OUTPUT_META)
export type DescribeEnvironmentOutputV4 = z.infer<typeof describeEnvironmentOutputV4Schema>
