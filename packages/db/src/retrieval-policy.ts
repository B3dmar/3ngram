// SPDX-License-Identifier: Apache-2.0
// Per-user retrieval-scope policy accessors (issue #47, epic #42).
//
// This module owns the SQL ONLY (hard rule 5: policy semantics — how a mode
// binds a read, which reads count as unscoped — live in packages/core). Every
// query runs inside withTenant(): RLS scopes every row to the caller, AND every
// query here ALSO carries an explicit caller-bound predicate (user_id = the
// withTenant userId) — the same two-layer tenant-isolation hardening as
// scopes.ts. One optional row per user (user_id PRIMARY KEY); NO ROW means
// mode 'off' (the shipped behavior), which callers get as `null` here — the
// off-default is core policy, not a fabricated row.
//
// The mode↔scope consistency invariant ('default' requires default_scope;
// 'require'/'off' forbid it) is enforced at BOTH boundaries: the Zod schema
// (retrievalScopePolicySchema — the one validation boundary transports parse)
// and the generated DB CHECK (user_retrieval_policy_scope_consistency_check),
// so a drifting pair can never be stored regardless of the writing path.
//
// Observability (hard rule 6): mode is a bounded enum and default_scope a
// bounded user label, not memory content; this module logs nothing and
// callers log ids/enum states only.
import type { RetrievalScopeMode } from '@3ngram/schema'
import { eq, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { userRetrievalPolicy } from './schema/identity.js'

/** One stored retrieval-policy row (absent row = mode 'off', returned as null). */
export interface RetrievalPolicyRow {
  mode: RetrievalScopeMode
  defaultScope: string | null
  updatedAt: Date
}

const POLICY_COLUMNS = {
  mode: userRetrievalPolicy.mode,
  defaultScope: userRetrievalPolicy.defaultScope,
  updatedAt: userRetrievalPolicy.updatedAt,
} as const

/**
 * Read the caller's retrieval policy, or null when none was ever set (the
 * caller maps null to the 'off' default — no fabricated row). RLS-scoped plus
 * the explicit caller-bound predicate.
 */
export async function getRetrievalPolicy(
  tx: TenantTx,
  userId: string,
): Promise<RetrievalPolicyRow | null> {
  const [row] = await tx
    .select(POLICY_COLUMNS)
    .from(userRetrievalPolicy)
    .where(eq(userRetrievalPolicy.userId, userId))
    .limit(1)
  return row ?? null
}

/**
 * Set the caller's retrieval policy (one row per user, upsert on user_id).
 * A FULL replace, never a merge: the action contract states the whole policy
 * atomically (setRetrievalDefaultInputSchema), so there is no partial update
 * to mis-apply. `userId` is REQUIRED on the insert (user_id is the PK and RLS
 * WITH CHECK pins it to the bound app.user_id). Returns the stored row.
 */
export async function upsertRetrievalPolicy(
  tx: TenantTx,
  userId: string,
  policy: { mode: RetrievalScopeMode; defaultScope: string | null },
): Promise<RetrievalPolicyRow> {
  const [row] = await tx
    .insert(userRetrievalPolicy)
    .values({ userId, mode: policy.mode, defaultScope: policy.defaultScope })
    .onConflictDoUpdate({
      target: userRetrievalPolicy.userId,
      set: { mode: policy.mode, defaultScope: policy.defaultScope, updatedAt: sql`now()` },
    })
    .returning(POLICY_COLUMNS)
  // .returning always yields exactly the upserted row on success.
  if (row === undefined) throw new Error('upsertRetrievalPolicy returned no row')
  return row
}
