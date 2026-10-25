// SPDX-License-Identifier: Apache-2.0
// Write-scope policy (issue #235): where a `remember` that omits `scope`
// lands. The write-side sibling of retrieval-settings.ts.
//
// - `off` (or no stored row): the shipped literal, `personal`.
// - `default`: the configured scope.
// - `require`: a typed {@link UnscopedWriteError}; nothing is written.
//
// An explicit scope on the write always wins and is used as given. It is NOT
// checked against the scope registry (memories.scope is denormalized text and
// `personal` itself ships unregistered); only the policy's own default is
// registry-checked, when it is set.
//
// Tenant isolation: the policy is read with one withTenant() read keyed by the
// authenticated user id. Nothing in a request (a scope name, an alias) can
// select another account's policy.
//
// Observability (hard rule 6): a bounded mode enum and a scope label; this
// module logs nothing.
import {
  getWriteScopePolicy as getWriteScopePolicyDb,
  listScopes as listScopesDb,
  lockRetrievalScopePolicy,
  ScopeNotFoundError,
  upsertWriteScopePolicy as upsertWriteScopePolicyDb,
  withTenant,
} from '@3ngram/db'
import type { WriteScopeMode } from '@3ngram/schema'

/**
 * The scope an unscoped write lands in under mode `off`: the shipped literal,
 * the same value as the base remember schema default and the `memories.scope`
 * column default.
 */
export const UNPOLICIED_WRITE_SCOPE = 'personal'

/** The stored write policy as transports report it (mode + configured scope). */
export interface WriteScopePolicySetting {
  mode: WriteScopeMode
  scope: string | null
}

/**
 * Thrown when the caller's write policy is `require` and a `remember` omitted
 * `scope`. Content-free: the message names the fix only.
 */
export class UnscopedWriteError extends Error {
  constructor() {
    super(
      "this account requires an explicit scope on writes (write-scope mode 'require') — pass scope, or change the policy with configure_scope set_write_default",
    )
    this.name = 'UnscopedWriteError'
  }
}

/**
 * Read the caller's effective write policy. No stored row reports the `off`
 * default; a `default` row whose scope is somehow null (the DB CHECK forbids
 * it) is also reported as `off` rather than as an unusable default.
 */
export function resolveWriteScopePolicy(userId: string): Promise<WriteScopePolicySetting> {
  return withTenant(userId, async (tx): Promise<WriteScopePolicySetting> => {
    const row = await getWriteScopePolicyDb(tx, userId)
    if (row === null) return { mode: 'off', scope: null }
    if (row.mode === 'default' && row.defaultScope === null) return { mode: 'off', scope: null }
    return { mode: row.mode, scope: row.defaultScope }
  })
}

/**
 * Resolve the scope a `remember` writes to. Explicit wins without a policy
 * read; an omitted scope reads the policy once.
 *
 * @throws {@link UnscopedWriteError} mode `require` and no explicit scope.
 */
export async function resolveWriteScope(
  userId: string,
  explicitScope: string | undefined,
): Promise<string> {
  if (explicitScope !== undefined) return explicitScope
  const policy = await resolveWriteScopePolicy(userId)
  switch (policy.mode) {
    case 'off':
      return UNPOLICIED_WRITE_SCOPE
    case 'default':
      // Non-null by resolveWriteScopePolicy (a null default reports as off).
      return policy.scope ?? UNPOLICIED_WRITE_SCOPE
    case 'require':
      throw new UnscopedWriteError()
    default:
      return policy.mode satisfies never
  }
}

/**
 * Set (replace) the caller's write policy: the `set_write_default`
 * configure_scope action. Shape consistency is the schema's job; this asserts
 * the state check: a `default` scope must be a REGISTERED scope name (the
 * canonical name; aliases are not resolved), so a typo can never send every
 * unscoped write to a scope the tenant does not have. Takes the same per-user
 * lock as scope rename/delete. Returns the stored setting.
 *
 * @throws {@link ScopeNotFoundError} mode `default` with an unregistered scope.
 */
export function setWriteDefault(
  userId: string,
  policy: WriteScopePolicySetting,
): Promise<WriteScopePolicySetting> {
  return withTenant(userId, async (tx): Promise<WriteScopePolicySetting> => {
    await lockRetrievalScopePolicy(tx, userId)
    if (policy.mode === 'default' && policy.scope !== null) {
      const scopes = await listScopesDb(tx, userId)
      if (!scopes.some((s) => s.name === policy.scope)) {
        throw new ScopeNotFoundError(policy.scope)
      }
    }
    const stored = await upsertWriteScopePolicyDb(tx, userId, {
      mode: policy.mode,
      defaultScope: policy.scope,
    })
    return { mode: stored.mode, scope: stored.defaultScope }
  })
}
