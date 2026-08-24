// SPDX-License-Identifier: Apache-2.0
// deleteAccount(): the self-serve account-deletion policy surface (GDPR Art. 17).
//
// apps -> core -> db layering (hard rule 5): this owns the deletion POLICY —
// the withTenant boundary, idempotency, the optional platform cleanup hook,
// and the audit tombstone — and delegates the SQL to packages/db
// (account-delete.ts) under withTenant (hard rule 3). The REST transport calls
// this and holds zero business logic.
//
// APPEND-ONLY (docs/concepts/memory-model.mdx + Hard Rule 1): the db layer redacts PII in place and
// physically deletes NO memory-domain row (the runtime grant forbids it). This
// policy never reaches around that.
//
// Extension boundary: any platform-specific cleanup runs through the injected
// `onAccountDeletion` hook (absent on self-host); Apache code imports no private
// module.
//
// Observability (hard rule 6): the audit tombstone carries counts + a mechanism
// label only — never the erased content or the user's email. This module logs
// nothing itself.
import {
  type AccountErasureResult,
  auditLogEntryExists,
  eraseAccountData,
  insertAuditLog,
  withTenant,
} from '@3ngram/db'

/** The audit action recorded once per deleted account (idempotency anchor). */
const TOMBSTONE_ACTION = 'account.deleted'

export type { AccountErasureResult } from '@3ngram/db'

/** Injected dependencies for a deletion: an optional platform cleanup hook + a clock. */
export interface DeleteAccountOptions {
  /** Optional platform cleanup hook (absent on self-host), run before erasure. */
  onAccountDeletion?: (userId: string) => Promise<void>
  /** Injected clock (never datetime.now() inside core) — the transport stamps it. */
  now: Date
}

/** The outcome of a deletion: whether it actually erased + the per-table counts. */
export interface AccountDeletionResult {
  /** True when the account was already deleted (idempotent re-run or absent row). */
  alreadyDeleted: boolean
  erased: AccountErasureResult
}

const EMPTY_ERASURE: AccountErasureResult = {
  alreadyErased: true,
  memories: 0,
  facts: 0,
  commitments: 0,
  proposals: 0,
  factProposals: 0,
  agentSessions: 0,
  sessionsDeleted: 0,
  apiKeysRevoked: 0,
  oauthTokensRevoked: 0,
  oauthCodesDeleted: 0,
  passwordResetTokensDeleted: 0,
  emailVerificationTokensDeleted: 0,
}

/**
 * Permanently delete the authenticated user's account: run the optional platform
 * cleanup hook, erase the user's PII in place (tombstone), revoke every
 * credential, and record a content-free audit tombstone.
 *
 * Resumable under partial failure (P1). The cleanup hook runs BEFORE the
 * irreversible erasure + deletion marker: a transient hook failure erases nothing,
 * so the whole operation retries cleanly and any external state is never left
 * stranded with no retry path. The hook MUST be idempotent (re-running it is a
 * no-op). The erasure then runs in one withTenant transaction (RLS-scoped). The
 * audit tombstone is written exactly once via an existence check, so a retry that
 * completes a prior run whose erasure committed but whose tombstone never landed
 * still records it — without a duplicate.
 *
 * Idempotent: a second call (already-erased marker, or an absent row from a
 * mid-request deletion) is a success that re-runs the hook (a no-op) and tops up
 * the tombstone only if it is missing.
 *
 * @param userId   The authenticated tenant (req.userId).
 * @param options  The optional cleanup hook + injected clock.
 */
export async function deleteAccount(
  userId: string,
  options: DeleteAccountOptions,
): Promise<AccountDeletionResult> {
  // Run any platform cleanup BEFORE the irreversible erasure so a transient
  // failure here leaves nothing half-done and the operation is fully retryable.
  await options.onAccountDeletion?.(userId)

  const erased = await withTenant(userId, (tx) => eraseAccountData(tx, userId, options.now))
  if (erased === undefined) return { alreadyDeleted: true, erased: EMPTY_ERASURE }

  // Audit tombstone: a content-free record of the erasure (counts + mechanism) on
  // the append-only audit_log system table — never the email or content. Written
  // exactly once: on the first erasure (real counts) or to complete a prior run
  // whose tombstone never committed. Skipped when one already exists.
  if (!(await auditLogEntryExists(userId, TOMBSTONE_ACTION))) {
    await insertAuditLog({
      userId,
      actorKind: 'user_api',
      action: TOMBSTONE_ACTION,
      resource: 'account',
      metadata: {
        mechanism: 'pii_tombstone',
        memories: erased.memories,
        facts: erased.facts,
        commitments: erased.commitments,
        proposals: erased.proposals,
        factProposals: erased.factProposals,
        agentSessions: erased.agentSessions,
        sessionsDeleted: erased.sessionsDeleted,
        apiKeysRevoked: erased.apiKeysRevoked,
        oauthTokensRevoked: erased.oauthTokensRevoked,
        oauthCodesDeleted: erased.oauthCodesDeleted,
        passwordResetTokensDeleted: erased.passwordResetTokensDeleted,
        emailVerificationTokensDeleted: erased.emailVerificationTokensDeleted,
      },
    })
  }

  return { alreadyDeleted: erased.alreadyErased, erased }
}
