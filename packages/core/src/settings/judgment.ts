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
  insertAuditLog,
  upsertJudgmentPolicy as upsertJudgmentPolicyDb,
  withTenant,
} from '@3ngram/db'
import type { ActorKind, JudgmentMode } from '@3ngram/schema'

/** audit_log action for a judgment opt-in change (a consent record). */
export const JUDGMENT_POLICY_AUDIT_ACTION = 'settings.judgment.set'

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

/**
 * Whether the tenant opted in to typed judgments. False unless explicitly `on`.
 * Read it IMMEDIATELY before the send, never at enqueue time: an opt-out that
 * lands between an early check and a later send must still stop the send.
 */
export async function isJudgmentEnabled(userId: string): Promise<boolean> {
  return (await getJudgmentPolicy(userId)).mode === 'on'
}

/**
 * Set the caller's judgment policy and record the change. Returns the stored
 * setting.
 *
 * Every set appends a content-free `audit_log` row (the mode, nothing else):
 * the row's own `updated_at` is overwritten on each change, so without it an
 * on -> off toggle would leave no evidence of the window in which text could
 * be sent. audit_log is written through its own tenant-less connection
 * (packages/db audit-log.ts), so it lands AFTER the upsert commits; a failed
 * audit write rejects this call, and the PUT is idempotent to retry.
 */
export async function setJudgmentPolicy(
  userId: string,
  mode: JudgmentMode,
  actorKind: ActorKind,
): Promise<JudgmentPolicySetting> {
  const stored = await withTenant(userId, (tx) => upsertJudgmentPolicyDb(tx, userId, mode))
  await insertAuditLog({
    userId,
    actorKind,
    action: JUDGMENT_POLICY_AUDIT_ACTION,
    resource: 'user_judgment_policy',
    metadata: { mode },
  })
  return stored
}
