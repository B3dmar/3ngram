// SPDX-License-Identifier: Apache-2.0
// Retrieval-scope policy ENFORCEMENT (issue #47, epic #42) — the read-path
// half of the per-user retrieval-scope setting.
//
// ONE CORE, N TRANSPORTS (ADR-0011): core stays env-free — the policy arrives
// as a PARAMETER on each read surface (search, briefing, handoff), resolved
// ONCE per request by the transport (scope/retrieval-settings.ts is the
// resolver) and injected like the budget/access gates. This module owns the
// single enforcement semantics all three surfaces share, so a surface can
// never drift on what "unscoped" means:
//
// - `off`     : nothing changes — the shipped behavior, byte-identical.
// - `default` : an UNSCOPED call (search without a `scope` filter; a briefing/
//   handoff selector of `kind: 'all'`) is narrowed to the configured scope and
//   the result ECHOES `appliedScope` — narrowing is NEVER silent. An already-
//   scoped call is untouched (the caller's explicit choice always wins).
// - `require` : an UNSCOPED call throws the typed {@link UnscopedRetrievalError}
//   naming the registered scopes (a MissingSelectorError sibling) — forces
//   explicitness for privacy-sensitive tenants.
//
// WHAT COUNTS AS UNSCOPED (issue #47 contract): the SCOPE AXIS specifically.
// For search that is `filters.scope === undefined` — a project/type/status
// filter does not satisfy the scope axis (a `default` scope composes with them
// as one more AND-narrowing; they are different axes). For briefing/handoff
// the selector is single-axis by shape: only `kind: 'all'` omits the scope
// axis IN A WAY THE POLICY CAN FILL — a `kind: 'project'` selector cannot
// carry a scope at all, so the policy passes it through (narrowing it to
// scope AND project would fabricate a selector shape the contract does not
// have; `require` likewise admits it as an explicit, bounded choice).
//
// get_facts DECISION (stated per the epic): NOT policy-enforced. The facts
// surface has NO scope axis — FactsQuery is subject/predicate/asOf/limit and
// the facts table carries no scope column — so `default` has nothing to
// apply and `require` would brick the tool with no way to comply. If facts
// ever grow a scope axis, they adopt this module's helpers with it.
//
// Observability (hard rule 6): scope names are bounded user labels, not
// memory content; this module logs nothing.
import type { BriefingSelector } from '@3ngram/db'

/**
 * The per-user retrieval policy as core consumes it — a discriminated union so
 * every mode carries EXACTLY what its enforcement needs and nothing else
 * (published core types as strict as the schemas, hard rule 2 discipline):
 * `default` MUST carry the scope it applies; `require` MUST carry the
 * registered scope names its error surfaces; `off` carries nothing. A
 * mode/payload drift is unrepresentable. Built by the per-request resolver
 * (scope/retrieval-settings.ts resolveRetrievalPolicy) from the stored row.
 */
export type RetrievalPolicy =
  | { readonly mode: 'off' }
  | { readonly mode: 'default'; readonly defaultScope: string }
  | { readonly mode: 'require'; readonly registeredScopes: readonly string[] }

const UNSCOPED_RECOVERY_PREFIX =
  "this account requires an explicit retrieval scope (retrieval-scope mode 'require') — "
const MAX_UNSCOPED_RECOVERY_SCOPES = 8
export const MAX_UNSCOPED_RECOVERY_DETAIL_LENGTH = 512

/** Build the bounded recovery detail shared by every transport. */
export function formatUnscopedRetrievalDetail(registeredScopes: readonly string[]): string {
  if (registeredScopes.length === 0) {
    return `${UNSCOPED_RECOVERY_PREFIX}no scopes are registered yet — register one with configure_scope`
  }

  const candidateCount = Math.min(registeredScopes.length, MAX_UNSCOPED_RECOVERY_SCOPES)
  for (let included = candidateCount; included > 0; included -= 1) {
    const omitted = registeredScopes.length - included
    const omission = omitted > 0 ? `; +${omitted} more omitted` : ''
    const detail = `${UNSCOPED_RECOVERY_PREFIX}registered scopes: ${registeredScopes
      .slice(0, included)
      .join(', ')}${omission}`
    if (detail.length <= MAX_UNSCOPED_RECOVERY_DETAIL_LENGTH) return detail
  }

  return `${UNSCOPED_RECOVERY_PREFIX}registered scopes: +${registeredScopes.length} omitted`
}

/**
 * Thrown when the caller's policy is `require` and a retrieval call omitted
 * the scope axis. A {@link MissingSelectorError} sibling (same 400-class
 * caller-mistake family, same transport mapping): the message NAMES a bounded
 * prefix of the registered scopes so the caller can re-issue a compliant call,
 * then reports how many names were omitted. Scope names are user labels, never
 * memory content (hard rule 6).
 */
export class UnscopedRetrievalError extends Error {
  readonly registeredScopes: readonly string[]
  constructor(registeredScopes: readonly string[]) {
    super(formatUnscopedRetrievalDetail(registeredScopes))
    this.name = 'UnscopedRetrievalError'
    this.registeredScopes = registeredScopes
  }
}

/**
 * Enforce the policy on search's scope FILTER axis. Returns the effective
 * scope filter plus the `appliedScope` echo (`null` = the policy narrowed
 * nothing — mode off, or the caller already scoped the call).
 *
 * @throws {@link UnscopedRetrievalError} mode `require` and no scope filter.
 */
export function applyPolicyToScopeFilter(
  policy: RetrievalPolicy | undefined,
  scope: string | undefined,
): { scope: string | undefined; appliedScope: string | null } {
  if (policy === undefined || policy.mode === 'off' || scope !== undefined) {
    return { scope, appliedScope: null }
  }
  if (policy.mode === 'require') throw new UnscopedRetrievalError(policy.registeredScopes)
  return { scope: policy.defaultScope, appliedScope: policy.defaultScope }
}

/**
 * Enforce the policy on a briefing/handoff SELECTOR. Only `kind: 'all'` is
 * unscoped-fillable (module header): `default` narrows it to the configured
 * scope selector and echoes `appliedScope`; `require` rejects it; a `scope`
 * or `project` selector is the caller's explicit bounded choice and passes
 * through untouched.
 *
 * @throws {@link UnscopedRetrievalError} mode `require` and `kind: 'all'`.
 */
export function applyPolicyToSelector(
  policy: RetrievalPolicy | undefined,
  selector: BriefingSelector,
): { selector: BriefingSelector; appliedScope: string | null } {
  if (policy === undefined || policy.mode === 'off' || selector.kind !== 'all') {
    return { selector, appliedScope: null }
  }
  if (policy.mode === 'require') throw new UnscopedRetrievalError(policy.registeredScopes)
  return {
    selector: { kind: 'scope', scope: policy.defaultScope },
    appliedScope: policy.defaultScope,
  }
}
