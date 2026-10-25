// SPDX-License-Identifier: Apache-2.0
// describe_environment output successors (issue #321 onward).
//
// Each additive field gets its own versioned schema composed from the previous
// one with `.safeExtend()`, and the openness marker is REAPPLIED at every level
// (output-openness.ts: composition does not inherit metadata). A later field
// (issue #235's `writeScopePolicy`) extends the newest schema here the same way.
import { z } from 'zod'
import { OPEN_OUTPUT_META } from './output-openness.js'
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
