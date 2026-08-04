// SPDX-License-Identifier: Apache-2.0
// Retrieval-scope policy SETTINGS surface (issue #47, epic #42) — resolve and
// set the per-user policy the read surfaces enforce (read/retrieval-policy.ts).
//
// apps -> core -> db layering (hard rule 5): this is the THIN policy layer for
// the "bind my session's reads to a scope" JTBD. The transport resolves the
// policy ONCE per request via {@link resolveRetrievalPolicy} and INJECTS it
// into core reads (ADR-0011: core stays env-free; the policy is a parameter,
// never ambient state). Writes go through {@link setRetrievalDefault}, which
// owns the ONE semantic check the schema boundary cannot do: a `default`
// scope must exist in the tenant's scope REGISTRY (shape consistency —
// mode↔scope pairing — is already enforced at the Zod boundary AND by the DB
// CHECK; registry existence is state, not shape).
//
// Observability (hard rule 6): mode is a bounded enum, scope a bounded user
// label; this module logs nothing.
import {
  getRetrievalPolicy as getRetrievalPolicyDb,
  listScopes as listScopesDb,
  lockRetrievalScopePolicy,
  ScopeNotFoundError,
  upsertRetrievalPolicy as upsertRetrievalPolicyDb,
  withTenant,
} from '@3ngram/db'
import type { RetrievalScopeMode } from '@3ngram/schema'
import type { RetrievalPolicy } from '../read/retrieval-policy.js'

/**
 * The stored policy as transports report it (`describe_environment`, the
 * `retrieval_default_set` result echo): the mode plus the configured scope.
 * Mirrors the schema-boundary retrievalScopePolicySchema shape — `default`
 * carries its scope; `require`/`off` carry null (the DB CHECK guarantees it).
 */
export interface RetrievalPolicySetting {
  mode: RetrievalScopeMode
  scope: string | null
}

/**
 * Resolve the caller's retrieval policy into the enforcement union the read
 * surfaces consume — the ONCE-PER-REQUEST call the transport makes before
 * injecting the result into search/briefing/handoff.
 *
 * - no stored row → `{ mode: 'off' }` (the shipped behavior; never a
 *   fabricated row)
 * - `default` → carries the stored scope (NOT NULL by the DB CHECK)
 * - `require` → also reads the scope REGISTRY in the same withTenant
 *   transaction, so the typed error a rejected read throws can NAME the
 *   registered scopes without a second round-trip at error time
 */
export function resolveRetrievalPolicy(userId: string): Promise<RetrievalPolicy> {
  return withTenant(userId, async (tx): Promise<RetrievalPolicy> => {
    const row = await getRetrievalPolicyDb(tx, userId)
    if (row === null || row.mode === 'off') return { mode: 'off' }
    if (row.mode === 'default') {
      // default_scope is NOT NULL under mode 'default' (DB CHECK); the guard
      // keeps the published union honest even against a manually-edited row.
      if (row.defaultScope === null) return { mode: 'off' }
      return { mode: 'default', defaultScope: row.defaultScope }
    }
    const scopes = await listScopesDb(tx, userId)
    return { mode: 'require', registeredScopes: scopes.map((s) => s.name) }
  })
}

/**
 * Set (replace) the caller's retrieval policy — the `set_retrieval_default`
 * configure_scope action. Shape consistency (mode↔scope pairing) is the
 * schema boundary's job (hard rule 2); THIS layer asserts the one semantic
 * invariant only state can answer: a `default` scope must be REGISTERED, so
 * a typo'd scope can never silently narrow every future read to an empty
 * slice. Scope mutations share this setter's per-user transaction lock and
 * preserve the invariant after configuration. Missing → the existing typed
 * {@link ScopeNotFoundError} (same not-found mapping as rename/delete).
 * Returns the stored setting (what the next describe_environment reports).
 */
export function setRetrievalDefault(
  userId: string,
  policy: RetrievalPolicySetting,
): Promise<RetrievalPolicySetting> {
  return withTenant(userId, async (tx): Promise<RetrievalPolicySetting> => {
    await lockRetrievalScopePolicy(tx, userId)
    if (policy.mode === 'default' && policy.scope !== null) {
      const scopes = await listScopesDb(tx, userId)
      if (!scopes.some((s) => s.name === policy.scope)) {
        throw new ScopeNotFoundError(policy.scope)
      }
    }
    const stored = await upsertRetrievalPolicyDb(tx, userId, {
      mode: policy.mode,
      defaultScope: policy.scope,
    })
    return { mode: stored.mode, scope: stored.defaultScope }
  })
}
