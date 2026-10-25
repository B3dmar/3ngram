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
//
// {@link guardSessionMutation} is the SHARED-mode sibling for writers of user
// CONTENT rather than auth material, which must not land after erasure either
// (account-delete.ts: erasure is the FINAL content write).
import { eq } from 'drizzle-orm'
import { isAccountTombstoned } from './account-delete.js'
import { lockAccountLifecycle, lockAccountLifecycleShared, type TenantTx } from './client.js'
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
 * The account id of a LIVE user, or undefined when the row is absent or a
 * deletion tombstone ({@link isAccountTombstoned}). The ONE liveness read:
 * {@link userIsLiveForIssuance} is this answer as a boolean, and
 * describe_environment reports the returned id as `account.id` (issue #321).
 * The lookup is keyed by primary key, so a found row's id IS `userId`; the id
 * is returned only once a live row proved it, never echoed for a missing or
 * erased account. The email and password hash are read only to recognise a
 * tombstone and never leave this function.
 *
 * Lock-free on its own: a caller that must serialize against a concurrent
 * erasure takes the account-lifecycle lock first (as the issuance guards below
 * do); a plain read sees its transaction's snapshot.
 */
export async function getLiveAccountId(tx: TenantTx, userId: string): Promise<string | undefined> {
  const [user] = await tx
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (user === undefined || isAccountTombstoned(userId, user)) return undefined
  return userId
}

/**
 * True when the user may still be issued credentials. Assumes the caller already
 * holds the account-lifecycle lock (so the tombstone read cannot race a deletion
 * that has not yet committed). False when the row is gone or tombstoned.
 */
export async function userIsLiveForIssuance(tx: TenantTx, userId: string): Promise<boolean> {
  return (await getLiveAccountId(tx, userId)) !== undefined
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

/**
 * The same refusal for a path that writes user CONTENT rather than credentials:
 * take the account-lifecycle lock in SHARED mode and throw
 * {@link AccountDeletedError} when the user is tombstoned. Must be the FIRST
 * statement in the transaction (lock order: account-lifecycle before every other
 * advisory and row lock).
 *
 * SHARED is the correct mode. These writers must not interleave with an erasure,
 * but they have no reason to exclude EACH OTHER — a session open serializing
 * against every other session open would put an exclusive per-user lock on the
 * hot SessionStart path. Erasure's exclusive acquisition still waits for every
 * holder and then locks them all out, which is all the invariant needs.
 *
 * The tombstone re-check AFTER the lock is not optional. Under READ COMMITTED a
 * statement that waits on a concurrently-updated row re-evaluates its qual
 * against the new row version but reads other relations from the ORIGINAL
 * snapshot, so an `EXISTS (... users ...)` guard would still see a live account
 * (client.ts). Acquiring the lock first and reading `users` in a fresh statement
 * after it is what makes the answer current.
 *
 * THROWS rather than silently dropping the write, unlike the heartbeat's excerpt
 * guard (session-lifecycle.ts): a session open is a user-visible request whose
 * whole purpose is the row it would create, not a background stamp riding along
 * with structural bookkeeping that stays valid without it.
 */
export async function guardSessionMutation(tx: TenantTx, userId: string): Promise<void> {
  await lockAccountLifecycleShared(tx, userId)
  if (!(await userIsLiveForIssuance(tx, userId))) throw new AccountDeletedError()
}
