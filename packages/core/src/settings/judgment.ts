// SPDX-License-Identifier: Apache-2.0
// Per-tenant judgment opt-in (issue #225).
//
// The privacy switch every `Gateway.decide()` call on tenant-derived text must
// read first. `off` — or no stored row — means nothing of this tenant reaches
// the judgment provider, whatever the deployment has configured. Default off,
// set only by the tenant (REST PUT /api/v1/settings/judgment).
//
// Tenant isolation: one withTenant() read keyed by the authenticated user id.
// Observability (hard rule 6): a bounded mode enum; this module logs nothing.
import {
  getJudgmentPolicy as getJudgmentPolicyDb,
  upsertJudgmentPolicy as upsertJudgmentPolicyDb,
  withTenant,
} from '@3ngram/db'
import type { JudgmentMode } from '@3ngram/schema'

/** The judgment policy as transports report it. `updatedAt` is null with no row. */
export interface JudgmentPolicySetting {
  mode: JudgmentMode
  updatedAt: Date | null
}

/** The caller's judgment policy; no stored row reads as `off`. */
export async function getJudgmentPolicy(userId: string): Promise<JudgmentPolicySetting> {
  const row = await withTenant(userId, (tx) => getJudgmentPolicyDb(tx, userId))
  return row === null ? { mode: 'off', updatedAt: null } : row
}

/** Whether the tenant opted in to typed judgments. False unless explicitly `on`. */
export async function isJudgmentEnabled(userId: string): Promise<boolean> {
  return (await getJudgmentPolicy(userId)).mode === 'on'
}

/** Set the caller's judgment policy. Returns the stored setting. */
export async function setJudgmentPolicy(
  userId: string,
  mode: JudgmentMode,
): Promise<JudgmentPolicySetting> {
  return withTenant(userId, (tx) => upsertJudgmentPolicyDb(tx, userId, mode))
}
