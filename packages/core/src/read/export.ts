// SPDX-License-Identifier: Apache-2.0
// exportUserData(): the GDPR data-portability policy surface.
//
// apps -> core -> db layering (hard rule 5): this owns the export POLICY (one
// withTenant tx for a consistent snapshot + the not-found invariant) and delegates
// the SQL to packages/db (data-export.ts) under withTenant (hard rule 3). The REST
// transport calls this and holds zero business logic.
//
// The userId is already authenticated (apiKeyAuth / session bearer bound
// req.userId), so an absent account row means the identity was deleted mid-request
// — an INVARIANT violation surfaced as a throw (generic 500), mirroring
// read/me.ts, never a 404.
//
// Observability (hard rule 6): the export carries the owner's content/facts back
// to the owner (its JTBD), but this module logs NOTHING; callers log the id hash +
// counts only, never content or the email.
import {
  type ExportEnricher,
  readUserDataExport,
  type UserDataExport,
  withTenant,
} from '@3ngram/db'

export type {
  ExportAccountRow,
  ExportAgentSessionRow,
  ExportBudgetRow,
  ExportCommitmentRow,
  ExportEdgeRow,
  ExportEnricher,
  ExportFactProposalRow,
  ExportFactRow,
  ExportLlmUsageRow,
  ExportMemoryEventRow,
  ExportMemoryRow,
  ExportProposalRow,
  ExportRetrievalPolicyRow,
  ExportScopeRow,
  ExportUserProfileRow,
  UserDataExport,
} from '@3ngram/db'

/**
 * Assemble the authenticated user's complete portable dataset: account identity
 * (never the password hash) plus every memory, fact, commitment, scope, memory
 * event, consolidation proposal, staged fact proposal, and agent session they own — all
 * lifecycle states, not just the
 * live set (docs/concepts/memory-model.mdx retains superseded rows; a portability export must include
 * them).
 *
 * Runs inside ONE withTenant transaction at REPEATABLE READ so every table is read
 * under a single consistent snapshot — a concurrent write/import cannot surface a
 * dangling child row or mismatched counts in the archive. RLS scopes every
 * memory-domain read to the caller, so the result can only ever contain the
 * caller's own data.
 *
 * When `enrich` is supplied (a platform extension), its extra user-owned rows are
 * merged into the archive in the same snapshot; self-host passes none.
 *
 * @param userId  The authenticated tenant (req.userId).
 * @param enrich  Optional platform hook adding extra user-owned rows.
 * @throws when the just-authenticated identity no longer exists (invariant break).
 */
export async function exportUserData(
  userId: string,
  enrich?: ExportEnricher,
): Promise<UserDataExport> {
  const data = await withTenant(userId, (tx) => readUserDataExport(tx, userId, enrich), {
    isolationLevel: 'repeatable read',
  })
  if (data === undefined) throw new Error('authenticated user not found')
  return data
}
