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
import {
  type EnvironmentStats,
  getEnvironmentStats,
  listScopes,
  type ScopeRow,
  withTenant,
} from '@3ngram/db'

export type { EnvironmentStats } from '@3ngram/db'

/** The tenant-scoped half of a describe_environment report (scopes + stats). */
export interface EnvironmentReport {
  scopes: ScopeRow[]
  stats: EnvironmentStats
}

/**
 * Assemble the tenant-scoped environment report: the registered scopes and the
 * bounded count stats, in ONE withTenant transaction (a consistent snapshot).
 * Carries no config — capabilities are layered on by the transport.
 */
export function describeEnvironment(userId: string): Promise<EnvironmentReport> {
  return withTenant(userId, async (tx) => {
    const scopes = await listScopes(tx)
    const stats = await getEnvironmentStats(tx)
    return { scopes, stats }
  })
}
