// SPDX-License-Identifier: Apache-2.0
// Per-user write-scope policy accessors (issue #235).
//
// The write-side twin of retrieval-policy.ts: SQL only (hard rule 5: how a
// mode resolves an omitted `remember` scope lives in packages/core). Every
// query runs inside withTenant() AND carries the explicit caller-bound
// predicate (user_id = the withTenant userId), the same two-layer isolation as
// scopes.ts. One optional row per user; NO ROW means mode 'off', returned as
// null here (the off default is core policy, not a fabricated row).
//
// Concurrency: callers serialize changes to this row with scope renames and
// deletes by taking lockScopePolicies (retrieval-policy.ts) first. That
// one per-user lock guards every denormalized copy of a scope name the
// policies hold, so a concurrent setter cannot restore a renamed or deleted
// default after the registry mutation commits.
//
// Observability (hard rule 6): a bounded mode enum and a bounded scope label;
// this module logs nothing.
import type { WriteScopeMode } from '@3ngram/schema'
import { and, eq, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { userWriteScopePolicy } from './schema/identity.js'

/** One stored write-policy row (absent row = mode 'off', returned as null). */
export interface WriteScopePolicyRow {
  mode: WriteScopeMode
  defaultScope: string | null
  updatedAt: Date
}

const POLICY_COLUMNS = {
  mode: userWriteScopePolicy.mode,
  defaultScope: userWriteScopePolicy.defaultScope,
  updatedAt: userWriteScopePolicy.updatedAt,
} as const

/** Read the caller's write policy, or null when none was ever set. */
export async function getWriteScopePolicy(
  tx: TenantTx,
  userId: string,
): Promise<WriteScopePolicyRow | null> {
  const [row] = await tx
    .select(POLICY_COLUMNS)
    .from(userWriteScopePolicy)
    .where(eq(userWriteScopePolicy.userId, userId))
    .limit(1)
  return row ?? null
}

/**
 * Set the caller's write policy: a FULL replace (upsert on user_id), never a
 * merge, because the action states the whole policy at once. Returns the
 * stored row.
 */
export async function upsertWriteScopePolicy(
  tx: TenantTx,
  userId: string,
  policy: { mode: WriteScopeMode; defaultScope: string | null },
): Promise<WriteScopePolicyRow> {
  const [row] = await tx
    .insert(userWriteScopePolicy)
    .values({ userId, mode: policy.mode, defaultScope: policy.defaultScope })
    .onConflictDoUpdate({
      target: userWriteScopePolicy.userId,
      set: { mode: policy.mode, defaultScope: policy.defaultScope, updatedAt: sql`now()` },
    })
    .returning(POLICY_COLUMNS)
  if (row === undefined) throw new Error('upsertWriteScopePolicy returned no row')
  return row
}

/**
 * Replace a matching active write default (mode 'default' on `currentScope`)
 * without touching any other policy. Used by registry rename/delete, inside
 * their transaction.
 */
export async function replaceWriteScopePolicyDefault(
  tx: TenantTx,
  userId: string,
  currentScope: string,
  replacement: { mode: WriteScopeMode; defaultScope: string | null },
): Promise<void> {
  await tx
    .update(userWriteScopePolicy)
    .set({
      mode: replacement.mode,
      defaultScope: replacement.defaultScope,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(userWriteScopePolicy.userId, userId),
        eq(userWriteScopePolicy.mode, 'default'),
        eq(userWriteScopePolicy.defaultScope, currentScope),
      ),
    )
}
