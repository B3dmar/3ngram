// SPDX-License-Identifier: Apache-2.0
// Typed wrappers over the session credential paths (docs/concepts/data-model.mdx).
//
// Two distinct access disciplines, matching the table's RLS posture:
// - resolveSession(): a PRE-TENANT lookup — the token hash must be resolved to
//   a user_id BEFORE any tenant context exists. user_sessions has RLS ON, so
//   this goes through the SECURITY DEFINER `auth_resolve_session` resolver
//   (migrations/0003_auth_resolvers.sql), the one narrow audited path. The
//   unscoped admin handle calls the function; the function (owned by the
//   migration role) is what bypasses RLS, not us.
// - insertSession(): a tenant-scoped write — the user_id is already known
//   (login just verified the password), so the INSERT runs through
//   withTenant(userId), satisfying the user_sessions RLS WITH CHECK like any
//   other user-owned write.
//
// getAdminDb stays internal to this package (the barrel does not re-export it,
// audit) — callers get this narrow typed surface only.
import { sql } from 'drizzle-orm'
import { getAdminDb, withTenant } from './client.js'
import { guardCredentialIssuance, userIsLiveForIssuance } from './credential-guard.js'

/** A resolved, non-expired session: identity + its expiry. */
export interface ResolvedSession {
  userId: string
  expiresAt: Date
}

/**
 * Resolve a session token hash to its owner via the SECURITY DEFINER resolver.
 * Returns undefined when the hash is unknown or the session has expired (the
 * function filters `expires_at > now()`), so callers never see a stale grant.
 */
export async function resolveSession(tokenHash: string): Promise<ResolvedSession | undefined> {
  // Raw `execute` rows bypass drizzle's column type mapping, so expires_at
  // arrives as a string from pg; coerce to Date here to honour the typed
  // wrapper contract (userId is a uuid string, which needs no coercion).
  const result = await getAdminDb().execute<{ user_id: string; expires_at: string }>(
    sql`SELECT user_id, expires_at FROM auth_resolve_session(${tokenHash})`,
  )
  const row = result.rows[0]
  if (!row) return undefined
  return { userId: row.user_id, expiresAt: new Date(row.expires_at) }
}

/**
 * Persist a new session for an already-authenticated user. Runs through
 * withTenant(userId): the row is a user-owned write, so the user_sessions RLS
 * WITH CHECK enforces user_id == app.user_id — a forged userId fails closed.
 * Only the SHA-256 hash of the token is stored (the plaintext never touches
 * the DB; mirrors the api_keys scheme).
 *
 * Serialized against account deletion (account-lifecycle lock) and refuses with
 * AccountDeletedError when the user is a deletion tombstone — a login whose
 * password check passed just before deletion erased the hash cannot mint a live
 * session on the deleted account (resurrection race).
 */
export async function insertSession(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await withTenant(userId, async (tx) => {
    await guardCredentialIssuance(tx, userId)
    await tx.execute(
      sql`INSERT INTO user_sessions (user_id, token_hash, expires_at)
          VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()})`,
    )
  })
}

/**
 * Revoke every session for a user EXCEPT the one whose hash is keepTokenHash —
 * the "log out all other devices" half of a password rotation.
 * Runs through withTenant(userId): the DELETE is scoped to the caller's own
 * rows by the user_sessions tenantPolicy() RLS (USING app.user_id), so a forged
 * userId can only ever touch its own sessions — never use getAdminDb() here.
 *
 * keepTokenHash is OPTIONAL: when omitted (the deferred reset flow), the
 * `token_hash <> NULL` predicate is unsatisfiable, so the guard collapses and
 * EVERY session for the user is revoked. This is NOT a delete on a memory write
 * path (hard rule 1) — sessions are ephemeral credentials, not memory rows.
 */
export async function deleteOtherSessions(userId: string, keepTokenHash?: string): Promise<void> {
  await withTenant(userId, async (tx) => {
    if (keepTokenHash === undefined) {
      await tx.execute(sql`DELETE FROM user_sessions WHERE user_id = ${userId}`)
      return
    }
    await tx.execute(
      sql`DELETE FROM user_sessions
          WHERE user_id = ${userId} AND token_hash <> ${keepTokenHash}`,
    )
  })
}

/**
 * Rotate one user's password hash AND revoke every OTHER live session in a
 * SINGLE transaction (atomicity hardening). The password UPDATE and
 * the session DELETE must commit together: if the rotation committed but the
 * session purge failed in a separate tx, the new hash would be live while other
 * sessions stayed valid AND the user could not retry (the old password is gone).
 * Running both in one tx means a failure in either rolls BOTH back, so the user
 * can simply retry with the still-valid old password.
 *
 * Caller contract: the CURRENT password MUST already be verified read-only
 * BEFORE this runs (packages/core changePasswordAndRevokeOthers does so), and
 * `newPasswordHash` is the already-hashed new credential — this function does no
 * verification or hashing, only the two writes.
 *
 * Why withTenant() spans BOTH tables: `users` is the pre-tenant system table (no
 * RLS), so setting app.user_id is harmless to its UPDATE; `user_sessions` has
 * RLS ON, so the DELETE needs app.user_id set to satisfy its tenantPolicy().
 * One withTenant(userId) tx therefore covers both writes — the UPDATE keyed by
 * primary key only ever touches the caller's own row, and the DELETE is RLS-
 * scoped to the caller's own sessions. `expectedHash` keeps the same TOCTOU
 * compare-and-swap as updateUserPassword: a concurrent rotation that already
 * moved the hash matches zero rows, so this returns false and the caller treats
 * it as a stale current password (revoking nothing). `keepTokenHash` preserves
 * the requesting session; when omitted EVERY session is revoked (deferred).
 *
 * The same tx ALSO burns every outstanding (unconsumed) password_reset_token for
 * the user (full-delta review P2). A password change must invalidate
 * every credential-in-flight: a user who requested a reset link and then changed
 * their password from Account would otherwise leave that emailed link live as an
 * account-takeover credential until its TTL. password_reset_tokens has RLS ON
 * keyed to app.user_id, which withTenant already bound, so the UPDATE is scoped
 * to this user's own rows (the explicit user_id predicate is belt-and-suspenders).
 * This mirrors the reset path, where auth_reset_password (migration 0016) burns
 * the same siblings — both password-mutation paths now converge on a clean slate.
 * Returns true when exactly one user row was rewritten, false otherwise.
 * Never log either hash or the token (hard rule 6).
 */
export async function rotatePasswordAndRevokeOthers(
  userId: string,
  expectedHash: string,
  newPasswordHash: string,
  keepTokenHash?: string,
): Promise<boolean> {
  return withTenant(userId, async (tx) => {
    // Serialize against a concurrent forgotten-password reset for this user. The
    // reset resolver (auth_reset_password, migration 0016) locks the token row
    // THEN the users row under this exact advisory key; this path locks the users
    // row then the token rows (the burn below). Without a shared lock the two
    // orders form a cycle and Postgres aborts one with a 40P01 deadlock instead
    // of deterministically letting one password operation win (full-delta review
    // P2). Taking the SAME per-user advisory xact lock FIRST makes whichever
    // operation acquires it run to commit before the other touches any row. The
    // key MUST match 0016's pg_advisory_xact_lock(hashtext('auth_reset_password'),
    // hashtext(uid::text)); the ::uuid::text cast normalizes to the same canonical
    // form the resolver hashes.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('auth_reset_password'), hashtext(${userId}::uuid::text))`,
    )
    // Refuse to set a real hash on a tombstoned account (resurrection race).
    // Deletion takes this SAME lock, so the check cannot race a
    // not-yet-committed deletion; the CAS below is a second backstop (the erased
    // sentinel never equals a caller-verified expectedHash).
    if (!(await userIsLiveForIssuance(tx, userId))) return false
    const updated = await tx.execute<{ id: string }>(
      sql`UPDATE users SET password_hash = ${newPasswordHash}
          WHERE id = ${userId} AND password_hash = ${expectedHash}
          RETURNING id`,
    )
    // CAS miss: a concurrent rotation already moved the hash. Roll back (revoke
    // nothing) and tell the caller the current password is now stale.
    if (updated.rows.length !== 1) return false
    if (keepTokenHash === undefined) {
      await tx.execute(sql`DELETE FROM user_sessions WHERE user_id = ${userId}`)
    } else {
      await tx.execute(
        sql`DELETE FROM user_sessions
            WHERE user_id = ${userId} AND token_hash <> ${keepTokenHash}`,
      )
    }
    // Invalidate any outstanding reset links so a password change leaves no
    // stale takeover credential (full-delta review P2). RLS + explicit user_id.
    await tx.execute(
      sql`UPDATE password_reset_tokens SET consumed_at = now()
          WHERE user_id = ${userId} AND consumed_at IS NULL`,
    )
    return true
  })
}
