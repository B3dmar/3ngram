// SPDX-License-Identifier: Apache-2.0
// Typed wrappers over the password_reset_tokens single-use path.
//
// Two access disciplines, matching the table's RLS posture (mirrors
// auth-oauth-codes.ts):
// - insertPasswordResetToken(): a tenant-scoped write. The forgot-password
//   handler has already resolved the email to a user_id, so the INSERT runs
//   through withTenant(userId) and the password_reset_tokens RLS WITH CHECK
//   enforces user_id == app.user_id — a forged userId fails closed.
// - consumePasswordResetToken(): a PRE-TENANT, ATOMIC single-use consumption.
//   The reset POST must resolve a presented token hash to its owner BEFORE any
//   tenant context exists. It goes through the SECURITY DEFINER
//   `auth_consume_password_reset_token` resolver (migrations/0015), which marks
//   the token consumed and returns its user in ONE statement — a replayed,
//   expired, or unknown token returns no row, so single-use holds under
//   concurrency without any app-side locking.
//
// Only the SHA-256 hash of the token ever reaches this layer (hard rule 6;
// mirrors the oauth_codes code_hash pattern) — core mints and hashes the
// plaintext, which is never persisted.
import { sql } from 'drizzle-orm'
import { getAdminDb, withTenant } from './client.js'
import { guardCredentialIssuance } from './credential-guard.js'
import { passwordResetTokens } from './schema/identity.js'

/** Insert shape: core supplies the pre-hashed token and its absolute expiry. */
export interface NewPasswordResetToken {
  tokenHash: string
  expiresAt: Date
}

/**
 * Persist a single-use reset token for an already-resolved user. Runs through
 * withTenant(userId): the row is a user-owned write, so the
 * password_reset_tokens RLS WITH CHECK enforces user_id == app.user_id. Only the
 * SHA-256 hash of the token is stored (the plaintext never touches the DB).
 */
export async function insertPasswordResetToken(
  userId: string,
  token: NewPasswordResetToken,
): Promise<void> {
  await withTenant(userId, async (tx) => {
    // Refuse to mint a reset token (a future password-set credential) on a
    // tombstoned account (resurrection race).
    await guardCredentialIssuance(tx, userId)
    await tx.insert(passwordResetTokens).values({ ...token, userId })
  })
}

/**
 * Atomically consume a reset token by its hash: marks it consumed and returns
 * its owner's user id, or undefined when the hash is unknown, already consumed
 * (replay), or expired — the resolver's UPDATE ... WHERE consumed_at IS NULL AND
 * expires_at > now() guarantees exactly one winner. The unscoped admin handle
 * calls the SECURITY DEFINER function; the function (owned by the migration
 * role) is what bypasses RLS, not us.
 */
export async function consumePasswordResetToken(tokenHash: string): Promise<string | undefined> {
  const result = await getAdminDb().execute<{ user_id: string }>(
    sql`SELECT user_id FROM auth_consume_password_reset_token(${tokenHash})`,
  )
  return result.rows[0]?.user_id
}

/**
 * Cheap, read-only check that a reset token is currently valid (exists,
 * unconsumed, unexpired), returning its owner's user id or undefined. Used by
 * the reset route BEFORE the expensive argon2id hash so a bogus token is
 * rejected without burning CPU/memory (DoS hardening) — the route is
 * unauthenticated and the per-IP limiter fails open on store errors.
 *
 * ADVISORY ONLY: a token valid here may be consumed by a concurrent reset before
 * {@link resetPasswordAtomic} runs; that function's under-lock re-check is the
 * sole authority, so a stale peek simply yields a later undefined and a uniform
 * InvalidResetTokenError. Goes through the SECURITY DEFINER `auth_peek_reset_token`
 * resolver (password_reset_tokens has RLS ON). Never log the hash (hard rule 6).
 */
export async function peekResetToken(tokenHash: string): Promise<string | undefined> {
  const result = await getAdminDb().execute<{ user_id: string }>(
    sql`SELECT user_id FROM auth_peek_reset_token(${tokenHash})`,
  )
  return result.rows[0]?.user_id
}

/**
 * Atomically reset a password: consume the presented token, rotate to
 * `newPasswordHash`, revoke EVERY session, and burn EVERY other outstanding
 * reset token for the user — all in ONE transaction behind a per-user advisory
 * lock (migrations/0016 `auth_reset_password` account-takeover fix).
 * Returns the user id on success, or undefined when the token is unknown,
 * expired, already consumed, or lost a concurrent reset race — the caller maps
 * undefined to a single uniform InvalidResetTokenError (no enumeration).
 *
 * Why a single SECURITY DEFINER resolver and not the consume + read-hash +
 * rotatePasswordAndRevokeOthers triple: that split was non-atomic, so a second
 * live reset link could be consumed in the race window (escaping the sibling
 * purge) and then rotate the freshly-reset password after reading the new hash.
 * Folding consume+rotate into one serialized tx makes exactly one reset take
 * effect and renders every sibling token dead. The new password is argon2-hashed
 * by core BEFORE this call; only the hash is passed (plaintext never reaches the
 * DB; hard rule 6 — never log the hash). The unscoped admin handle calls the
 * function; the function (owned by the migration role) is what bypasses RLS.
 */
export async function resetPasswordAtomic(
  tokenHash: string,
  newPasswordHash: string,
): Promise<string | undefined> {
  const result = await getAdminDb().execute<{ user_id: string }>(
    sql`SELECT user_id FROM auth_reset_password(${tokenHash}, ${newPasswordHash})`,
  )
  return result.rows[0]?.user_id
}
