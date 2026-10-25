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
 * Per-array cap on the facets describe_environment INLINES (review of #168).
 * The tool runs at session start and its output lands in model context, and
 * distinct projects can approach the live-memory count, so the inline copy is
 * bounded like the rest of the report. The `threengram://facets` resource and
 * REST `GET /api/v1/memories/facets` stay unbounded: they are on-demand reads.
 */
export const MAX_INLINE_FACET_LABELS = 50

/**
 * The tenant's scope/project inventory as describe_environment inlines it
 * (issue #168): the `{ scopes, projects }` labels REST
 * `GET /api/v1/memories/facets` and the `threengram://facets` resource serve,
 * built from the same element schemas, capped at
 * {@link MAX_INLINE_FACET_LABELS} per array (ASC order — the first labels),
 * so a host that never surfaces resources to the model still sees it.
 * `truncated` says, PER ARRAY, whether the cap cut it — per array rather than
 * one flag because the two lists grow very differently (a handful of scopes,
 * possibly hundreds of projects), so a client can trust a complete `scopes`
 * list while knowing to read `threengram://facets` for every project.
 * `scopes` are scopes holding LIVE memories — a registered scope with none
 * appears in the report's `scopes` registry list, not here. Labels only, never
 * memory content; empty arrays for an empty account. A scope name is a filing
 * label: it never identifies an account.
 */
export const environmentFacetsSchema = z
  .object({
    scopes: memoriesFacetsResponseSchema.shape.scopes
      .max(MAX_INLINE_FACET_LABELS)
      .describe('Scope names your live memories are filed under.'),
    projects: memoriesFacetsResponseSchema.shape.projects
      .max(MAX_INLINE_FACET_LABELS)
      .describe('Project names on your live memories.'),
    truncated: z
      .object({
        scopes: z.boolean(),
        projects: z.boolean(),
      })
      .strict()
      .meta({
        ...OPEN_OUTPUT_META,
        description: 'True where the list was capped; read threengram://facets for all of it.',
      }),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type EnvironmentFacets = z.infer<typeof environmentFacetsSchema>

/**
 * `describe_environment` output V4: V3 (account identity) plus the inlined,
 * capped `facets` inventory. ALWAYS present (empty arrays when there is
 * nothing). A later field (issue #235) composes a V5 from this one.
 */
export const describeEnvironmentOutputV4Schema = describeEnvironmentOutputV3Schema
  .safeExtend({
    facets: environmentFacetsSchema,
  })
  .meta(OPEN_OUTPUT_META)
export type DescribeEnvironmentOutputV4 = z.infer<typeof describeEnvironmentOutputV4Schema>
