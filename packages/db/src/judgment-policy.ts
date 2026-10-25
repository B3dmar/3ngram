// SPDX-License-Identifier: Apache-2.0
// Per-user judgment opt-in accessors (issue #225).
//
// SQL only (hard rule 5: what the mode means lives in packages/core). Every
// query runs inside withTenant() AND carries the explicit caller-bound
// predicate (user_id = the withTenant userId), the same two-layer isolation as
// write-scope-policy.ts. One optional row per user; NO ROW means mode 'off',
// returned as null here (the off default is core policy, not a fabricated row).
//
// Observability (hard rule 6): a bounded mode enum; this module logs nothing.
import type { JudgmentMode } from '@3ngram/schema'
import { eq, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { userJudgmentPolicy } from './schema/identity.js'

/** One stored judgment-policy row (absent row = mode 'off', returned as null). */
export interface JudgmentPolicyRow {
  mode: JudgmentMode
  updatedAt: Date
}

const POLICY_COLUMNS = {
  mode: userJudgmentPolicy.mode,
  updatedAt: userJudgmentPolicy.updatedAt,
} as const

/** Read the caller's judgment policy, or null when none was ever set. */
export async function getJudgmentPolicy(
  tx: TenantTx,
  userId: string,
): Promise<JudgmentPolicyRow | null> {
  const [row] = await tx
    .select(POLICY_COLUMNS)
    .from(userJudgmentPolicy)
    .where(eq(userJudgmentPolicy.userId, userId))
    .limit(1)
  return row ?? null
}

/** Set the caller's judgment policy (upsert on user_id). Returns the stored row. */
export async function upsertJudgmentPolicy(
  tx: TenantTx,
  userId: string,
  mode: JudgmentMode,
): Promise<JudgmentPolicyRow> {
  const [row] = await tx
    .insert(userJudgmentPolicy)
    .values({ userId, mode })
    .onConflictDoUpdate({
      target: userJudgmentPolicy.userId,
      set: { mode, updatedAt: sql`now()` },
    })
    .returning(POLICY_COLUMNS)
  if (row === undefined) throw new Error('upsertJudgmentPolicy returned no row')
  return row
}
