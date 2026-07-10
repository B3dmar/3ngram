// SPDX-License-Identifier: Apache-2.0
// Forgotten-password reset. The apps->core->db layer: the REST
// routes call requestPasswordReset()/resetPassword() and stay thin; all DB
// access goes through the narrow packages/db reset-token wrappers.
//
// Token scheme (mirrors the session/api-key scheme): the reset token
// is 32 bytes of CSPRNG entropy, base64url-encoded. The SERVER STORES ONLY ITS
// SHA-256 HASH — the plaintext is handed to the delivery channel (email link)
// once and never persisted. A stolen DB therefore yields no usable tokens.
// SHA-256 (not argon2id) is correct here: the input is high-entropy random, so
// there is no dictionary to defend against and the lookup must be a fast indexed
// equality.
//
// Two no-enumeration disciplines:
// - requestPasswordReset() returns void for BOTH a known and an unknown email
//   (the caller ALWAYS responds 200) — a missing account mints no token but is
//   indistinguishable to the client. The optional returned plaintext is for the
//   dev-only echo path; it is undefined for an unknown email.
// - resetPassword() throws a single InvalidResetTokenError for an unknown,
//   expired, OR already-consumed token — the caller maps every failure to one
//   uniform response.
//
// Never log the token, its hash, the email, or either password (hard rule 6).
import { createHash, randomBytes } from 'node:crypto'
import {
  getUserByEmail,
  insertPasswordResetToken,
  peekResetToken,
  resetPasswordAtomic,
} from '@3ngram/db'
import { hashPassword } from './password.js'
import { assertPasswordNotBreached, type PasswordBreachCheckOptions } from './password-breach.js'

const TOKEN_BYTES = 32

/** No-op breach options — the default when a caller opts out of the screen. */
const BREACH_DISABLED: PasswordBreachCheckOptions = { enabled: false }
const MS_PER_MINUTE = 60 * 1000

/**
 * Thrown by {@link resetPassword} when the presented token is unknown, expired,
 * or already consumed (single-use replay). The transport maps it to one uniform
 * response so a caller can never distinguish the three failure modes — a
 * consumed/expired token leaks nothing about whether it ever existed.
 */
export class InvalidResetTokenError extends Error {
  constructor() {
    super('reset token is invalid or expired')
    this.name = 'InvalidResetTokenError'
  }
}

/** sha256(token) hex — the only form of the token the DB ever sees. */
function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Mint a single-use reset token for the account owning `email`, if any. For a
 * known email: generates a CSPRNG token, stores ONLY its SHA-256 hash with the
 * supplied TTL, and returns the plaintext so the caller can hand it to the
 * delivery channel (email link) or, in dev only, echo it. For an unknown email:
 * mints nothing and returns undefined — the caller still responds 200, so the
 * two paths are indistinguishable (no account enumeration).
 *
 * `ttlMinutes` is supplied by the transport (it owns the env contract via
 * loadEnv) so core stays free of a config dependency and the TTL is a single,
 * validated boundary value. The plaintext is returned at most once and is never
 * persisted; never log it (hard rule 6).
 */
export async function requestPasswordReset(
  email: string,
  ttlMinutes: number,
): Promise<string | undefined> {
  const user = await getUserByEmail(email)
  if (user === undefined) return undefined

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + ttlMinutes * MS_PER_MINUTE)
  await insertPasswordResetToken(user.id, { tokenHash: hashResetToken(token), expiresAt })
  return token
}

/**
 * Consume a reset token and set a new password atomically, revoking EVERY
 * session the user holds AND burning EVERY other outstanding reset token for the
 * user. The whole operation is ONE serialized DB transaction
 * (resetPasswordAtomic → migrations/0016 `auth_reset_password`, extended by 0020):
 * consume the presented token, rotate the password, revoke all sessions AND all
 * issued agent credentials (OAuth access+refresh tokens and API keys),
 * and purge sibling tokens behind a per-user advisory lock. Exactly one reset can
 * take effect; an
 * unknown, expired, already-consumed, or race-losing token resolves to no user
 * and throws {@link InvalidResetTokenError} — a single uniform failure (no
 * enumeration of which tokens ever existed) and no partial write.
 *
 * Why atomic and not the previous consume + read-hash + rotate triple: that split
 * was non-atomic, so a second live reset link could be consumed in the race
 * window (escaping the sibling purge) and then rotate the freshly-reset password
 * after reading the new hash — a stale sibling acting as an account-takeover
 * credential. There is deliberately NO old-password check: a reset
 * bypasses it (the user forgot the password), and authority is holding a valid,
 * unconsumed token under the per-user lock. ALL sessions AND ALL agent tokens
 * (OAuth + API keys) are revoked because a forgotten-password reset implies the
 * account may be compromised — no device stays logged in and no previously issued
 * agent credential keeps working (a stolen token must not survive recovery).
 *
 * The new password is argon2-hashed HERE; only the hash crosses into the DB (the
 * plaintext never persists). A cheap read-only peek rejects an invalid token
 * BEFORE the argon2id hash so a bogus token cannot burn CPU/memory on this
 * unauthenticated route (DoS hardening; the per-IP limiter fails open
 * on store errors). The peek is advisory — resetPasswordAtomic's under-lock
 * re-check stays the sole authority, so a token consumed in the gap between peek
 * and the atomic call simply yields a later undefined and the same uniform
 * error. Never log the token or either password (hard rule 6).
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  breach: PasswordBreachCheckOptions = BREACH_DISABLED,
): Promise<void> {
  const tokenHash = hashResetToken(token)
  if ((await peekResetToken(tokenHash)) === undefined) throw new InvalidResetTokenError()

  // Screen the new password AFTER the cheap token peek (a bogus token never
  // triggers an outbound breach query, matching the peek-before-argon2 DoS
  // hardening) and BEFORE rotation (research R3). A breached password throws
  // PasswordBreachedError; the transport maps it to a generic validation failure.
  await assertPasswordNotBreached(newPassword, breach)

  const newHash = await hashPassword(newPassword)
  const userId = await resetPasswordAtomic(tokenHash, newHash)
  if (userId === undefined) throw new InvalidResetTokenError()
}
