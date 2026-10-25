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
  lockScopePolicies,
  ScopeNotFoundError,
  upsertWriteScopePolicy as upsertWriteScopePolicyDb,
  type WriteScopePolicyRow,
  withTenant,
} from '@3ngram/db'
import type { WriteScopeMode } from '@3ngram/schema'
import { formatScopeRecoveryDetail } from '../read/retrieval-policy.js'

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

const UNSCOPED_WRITE_PREFIX =
  "this account requires an explicit scope on writes (write-scope mode 'require') — pass scope; "

/**
 * Build the bounded, transport-neutral recovery detail for a rejected unscoped
 * write: it names a prefix of the REGISTERED scopes (the retrieval precedent,
 * {@link formatScopeRecoveryDetail}), so "pass scope" is actionable over MCP
 * and REST alike. With nothing registered it says any scope name works, since
 * an explicit scope is never registry-checked. Labels only, never content.
 */
export function formatUnscopedWriteDetail(registeredScopes: readonly string[]): string {
  if (registeredScopes.length === 0) {
    return `${UNSCOPED_WRITE_PREFIX}any kebab-case scope name is accepted`
  }
  return formatScopeRecoveryDetail(UNSCOPED_WRITE_PREFIX, registeredScopes)
}

/**
 * Thrown when the caller's write policy is `require` and a `remember` omitted
 * `scope`. Content-free: the message is {@link formatUnscopedWriteDetail}.
 */
export class UnscopedWriteError extends Error {
  readonly registeredScopes: readonly string[]
  constructor(registeredScopes: readonly string[]) {
    super(formatUnscopedWriteDetail(registeredScopes))
    this.name = 'UnscopedWriteError'
    this.registeredScopes = registeredScopes
  }
}

const OFF_SETTING: WriteScopePolicySetting = { mode: 'off', scope: null }

/**
 * Map a stored row (or its absence) to the effective setting. The ONE mapping
 * both `remember` and `describe_environment` use, so they cannot disagree: no
 * row is `off`, and a `default` row whose scope is somehow null (the DB CHECK
 * forbids it) is also `off` rather than an unusable default.
 */
export function toWriteScopeSetting(row: WriteScopePolicyRow | null): WriteScopePolicySetting {
  if (row === null) return OFF_SETTING
  if (row.mode === 'default' && row.defaultScope === null) return OFF_SETTING
  return { mode: row.mode, scope: row.defaultScope }
}

/** Read the caller's effective write policy (see {@link toWriteScopeSetting}). */
export function resolveWriteScopePolicy(userId: string): Promise<WriteScopePolicySetting> {
  return withTenant(userId, async (tx) =>
    toWriteScopeSetting(await getWriteScopePolicyDb(tx, userId)),
  )
}

/**
 * Resolve the scope a `remember` writes to. Explicit wins without a policy
 * read; an omitted scope reads the policy in one tenant transaction (plus the
 * registry, under `require`, so the error can name the registered scopes).
 *
 * @throws {@link UnscopedWriteError} mode `require` and no explicit scope.
 */
export async function resolveWriteScope(
  userId: string,
  explicitScope: string | undefined,
): Promise<string> {
  if (explicitScope !== undefined) return explicitScope
  return withTenant(userId, async (tx): Promise<string> => {
    const policy = toWriteScopeSetting(await getWriteScopePolicyDb(tx, userId))
    switch (policy.mode) {
      case 'off':
        return UNPOLICIED_WRITE_SCOPE
      case 'default':
        // Non-null by toWriteScopeSetting (a null default maps to off).
        return policy.scope ?? UNPOLICIED_WRITE_SCOPE
      case 'require': {
        const scopes = await listScopesDb(tx, userId)
        throw new UnscopedWriteError(scopes.map((scope) => scope.name))
      }
      default:
        return policy.mode satisfies never
    }
  })
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
    await lockScopePolicies(tx, userId)
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
