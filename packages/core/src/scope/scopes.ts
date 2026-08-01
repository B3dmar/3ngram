// SPDX-License-Identifier: Apache-2.0
// Scopes registry policy surface (configure_scope). apps -> core -> db
// (hard rule 5): this is the THIN policy
// layer for the "organize my memory space" JTBD — it owns the withTenant()
// transaction wrapping and re-exports the typed db errors; it holds NO SQL and NO
// re-validation (hard rule 2: shape is validated once at the schema boundary the
// transport parses with).
//
// DELETE semantics (orchestrator decision, documented in packages/db/scopes.ts):
// deleting a scope removes the REGISTRY row only. memories.scope is denormalized
// text with no FK, so a deleted scope leaves memory rows untouched and valid —
// unregistered scope names remain usable ('personal' itself ships unregistered).
// No orphaning, no cascade.
import {
  createScope as createScopeDb,
  deleteScope as deleteScopeDb,
  listScopes as listScopesDb,
  renameScope as renameScopeDb,
  type ScopeRow,
  setScopeAliases as setScopeAliasesDb,
  withTenant,
} from '@3ngram/db'

export { ScopeNameConflictError, ScopeNotFoundError } from '@3ngram/db'

/** A scope-registry record returned to a transport (id + name + aliases + created). */
export type ScopeRecord = ScopeRow

/** List the tenant's registered scopes (name-ordered). Runs under withTenant/RLS. */
export function listScopes(userId: string): Promise<ScopeRecord[]> {
  return withTenant(userId, (tx) => listScopesDb(tx, userId))
}

/** Register a new scope. Name collision -> ScopeNameConflictError. */
export function createScope(
  userId: string,
  name: string,
  aliases: readonly string[],
): Promise<ScopeRecord> {
  return withTenant(userId, (tx) => createScopeDb(tx, userId, name, [...aliases]))
}

/** Rename a scope. Missing -> ScopeNotFoundError; new name taken -> conflict. */
export function renameScope(userId: string, from: string, to: string): Promise<ScopeRecord> {
  return withTenant(userId, (tx) => renameScopeDb(tx, userId, from, to))
}

/** Replace a scope's alias list (full replace). Missing -> ScopeNotFoundError. */
export function setScopeAliases(
  userId: string,
  name: string,
  aliases: readonly string[],
): Promise<ScopeRecord> {
  return withTenant(userId, (tx) => setScopeAliasesDb(tx, userId, name, [...aliases]))
}

/** Delete a scope from the registry (memory rows untouched). Missing -> not-found. */
export function deleteScope(userId: string, name: string): Promise<void> {
  return withTenant(userId, (tx) => deleteScopeDb(tx, userId, name))
}
