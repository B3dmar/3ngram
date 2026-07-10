// SPDX-License-Identifier: Apache-2.0
// Credential-resurrection guard. Every path that CREATES or
// MUTATES auth material for a user (sessions, api keys, oauth tokens/codes, reset
// + verification tokens, the password hash) runs in SEPARATE db steps from the
// pre-tenant resolve/consume that precedes it. If an account deletion lands in
// that window it would tombstone the user AFTER the path's authorization but
// BEFORE its write, minting a LIVE credential on a deleted account.
//
// The fix is uniform: each issuance/mutation takes the per-user account-lifecycle
// advisory lock (the SAME one eraseAccountData takes) as its FIRST statement, then
// refuses to write when the user is a deletion tombstone. Deletion and issuance
// therefore serialize — an issuance either commits-then-gets-revoked by the
// deletion, or runs after it and is refused.
import { eq } from 'drizzle-orm'
import { isAccountTombstoned } from './account-delete.js'
import { lockAccountLifecycle, type TenantTx } from './client.js'
import { users } from './schema/identity.js'

/**
 * Thrown by a credential-issuance path when the target account is a deletion
 * tombstone. A typed boundary so transports fail closed uniformly (never an
 * oracle that distinguishes "deleted" from other failures).
 */
export class AccountDeletedError extends Error {
  constructor() {
    super('account_deleted')
    this.name = 'AccountDeletedError'
  }
}

/**
 * True when the user may still be issued credentials. Assumes the caller already
 * holds the account-lifecycle lock (so the tombstone read cannot race a deletion
 * that has not yet committed). False when the row is gone or tombstoned.
 */
export async function userIsLiveForIssuance(tx: TenantTx, userId: string): Promise<boolean> {
  const [user] = await tx
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (user === undefined) return false
  return !isAccountTombstoned(userId, user)
}

/**
 * Take the account-lifecycle lock and refuse (throw {@link AccountDeletedError})
 * when the user is tombstoned — the throwing variant for credential minters that
 * are not the OAuth grant flow (which maps a boolean to invalid_grant instead).
 * Must be the FIRST statement in the issuance transaction.
 */
export async function guardCredentialIssuance(tx: TenantTx, userId: string): Promise<void> {
  await lockAccountLifecycle(tx, userId)
  if (!(await userIsLiveForIssuance(tx, userId))) throw new AccountDeletedError()
}
