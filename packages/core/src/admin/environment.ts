// SPDX-License-Identifier: Apache-2.0
// describe_environment policy surface — "know what this server can do / how
// I'm set up". apps -> core -> db
// (hard rule 5): core assembles the TENANT-SCOPED part of the report — the
// scopes registry and the bounded stats — from the db helpers, under withTenant
// (hard rule 3). CAPABILITIES (tool names/count, server version) are NOT here:
// the tool registry and package version live in apps/server, so the transport
// composes them onto this report (still zero business logic there).
//
// REDACTION-CRITICAL (hard rule 6): this report carries COUNTS, NAMES, and
// ALIASES only — NEVER an env value, DSN, key material, or base URL. There is no
// code path here that reads process.env or any secret: the surface is structurally
// incapable of leaking config. A sentinel test asserts a configured fake secret
// never appears in the response.
//
// ACCOUNT IDENTITY (issue #321): the report names the authenticated account by
// its `users.id` — the same value `GET /api/v1/me` returns as `id` — read from
// the live users row, never derived from a scope name or memory content. The
// email is never part of the report.
import {
  AccountDeletedError,
  type EnvironmentStats,
  getEnvironmentStats,
  getLiveAccountId,
  getRetrievalPolicy,
  listMemoryFacets,
  listScopes,
  type MemoryFacets,
  type ScopeRow,
  withTenant,
} from '@3ngram/db'
import type { RetrievalPolicySetting } from '../scope/retrieval-settings.js'

export type { EnvironmentStats } from '@3ngram/db'

/** The authenticated account's identity (issue #321): its `users.id` only. */
export interface AccountIdentity {
  id: string
}

/** The tenant-scoped half of a describe_environment report (account identity +
 * scopes + stats + the active retrieval-scope policy, issue #47). */
export interface EnvironmentReport {
  /** The authenticated account (issue #321). Not a scope, not a secret. */
  account: AccountIdentity
  /** DISTINCT scope/project labels on live memories (issue #168) — the same
   * inventory REST facets and `threengram://facets` serve. */
  facets: MemoryFacets
  scopes: ScopeRow[]
  stats: EnvironmentStats
  /** The active retrieval-scope policy (issue #47): no stored row reports the
   * `off` default, so a session can always rely on the field. A mode enum +
   * a registered scope name only — the redaction posture is unchanged. */
  retrievalScopePolicy: RetrievalPolicySetting
}

/**
 * Assemble the tenant-scoped environment report: the account identity, the
 * registered scopes, the live scope/project inventory, the bounded count
 * stats, and the active retrieval-scope policy, in ONE withTenant transaction (a consistent snapshot). Carries no
 * config — capabilities are layered on by the transport.
 *
 * @throws AccountDeletedError when the authenticated account no longer exists
 *   or is an erasure tombstone. Erasure revokes every token, so this is only
 *   reachable by a request already in flight; it fails rather than reporting
 *   an identity the account no longer has.
 */
export function describeEnvironment(userId: string): Promise<EnvironmentReport> {
  return withTenant(userId, async (tx) => {
    const accountId = await getLiveAccountId(tx, userId)
    if (accountId === undefined) throw new AccountDeletedError()
    const scopes = await listScopes(tx, userId)
    const stats = await getEnvironmentStats(tx, userId)
    const policy = await getRetrievalPolicy(tx, userId)
    const facets = await listMemoryFacets(tx, userId)
    return {
      account: { id: accountId },
      scopes,
      facets,
      stats,
      retrievalScopePolicy:
        policy === null
          ? { mode: 'off' as const, scope: null }
          : { mode: policy.mode, scope: policy.defaultScope },
    }
  })
}
