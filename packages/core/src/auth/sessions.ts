// SPDX-License-Identifier: Apache-2.0
// Session lifecycle. The apps->core->db layer: REST
// routes call login()/authenticateToken() and stay thin; all DB access goes
// through the narrow packages/db session wrappers.
//
// Token scheme (mirrors the api_key scheme): the bearer token is
// 32 bytes of CSPRNG entropy, base64url-encoded. The SERVER STORES ONLY ITS
// SHA-256 HASH — the plaintext is returned to the client once and never
// persisted. A stolen DB therefore yields no usable tokens. SHA-256 (not
// argon2id) is correct here: the input is high-entropy random, so there is no
// dictionary to defend against and the lookup must be a fast indexed equality.
//
// Never log the token, its hash, the password, or the email (hard rule 6).
import { createHash, randomBytes } from 'node:crypto'
import {
  getUserByEmail,
  insertSession,
  resolveSession,
  rotatePasswordAndRevokeOthers,
} from '@3ngram/db'
import { hashPassword, verifyPassword } from './password.js'
import { InvalidCurrentPasswordError, verifyCurrentPasswordHash } from './users.js'

const TOKEN_BYTES = 32
const MS_PER_HOUR = 60 * 60 * 1000

// A real argon2id hash of a throwaway secret. verifyPassword() against it on
// the unknown-user path keeps wrong-password and unknown-user timing-equivalent
// so the 401 cannot be turned into a user-enumeration oracle.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$e2lBga7zHkLZ0Vmn31bOow$f3Xri60rccjTW/QVuUQl1mvCPORxy2dYEbzjy3Xf3zI'

export class EmailNotVerifiedError extends Error {
  constructor() {
    super('email is not verified')
    this.name = 'EmailNotVerifiedError'
  }
}

/**
 * A freshly minted session — the plaintext token plus its absolute expiry.
 * `userId` identifies the authenticated subject: the OAuth consent flow
 * authenticates via login() and needs the subject to bind the
 * authorization code without a second resolve round-trip.
 */
export interface SessionGrant {
  userId: string
  token: string
  expiresAt: Date
}

/** sha256(token) hex — the only form of the token the DB ever sees. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Verify a credential pair WITHOUT minting a session. Returns the authenticated
 * subject's user id, or undefined for BOTH a wrong password and an unknown email
 * — the caller maps either to a uniform 401 (no user enumeration). The
 * unknown-user branch still runs an argon2id verify against a dummy hash so the
 * two failure paths are timing-equivalent and the 401 cannot be turned into an
 * enumeration oracle.
 *
 * This is the single source of the argon2id + timing-equalization step: both
 * login() (which adds the session INSERT) and the OAuth consent flow (which
 * needs identity confirmation but no session token) call it. The OAuth
 * consent path MUST use this rather than login() so it does not leave an orphan
 * sessions row whose plaintext token is discarded.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<string | undefined> {
  const user = await getUserByEmail(email)
  const ok = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, password)
  if (!user || !ok) return undefined
  if (user.emailVerifiedAt === null) throw new EmailNotVerifiedError()
  return user.id
}

/**
 * Authenticate a credential pair and mint a session. Returns undefined for
 * BOTH a wrong password and an unknown email — the caller maps either to a
 * uniform 401 (no user enumeration); verifyCredentials() owns the timing-safe
 * verify step.
 *
 * `ttlHours` is supplied by the transport (it owns the env contract via
 * loadEnv) so core stays free of a config dependency and the TTL is a single,
 * validated boundary value.
 */
export async function issueSession(userId: string, ttlHours: number): Promise<SessionGrant> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + ttlHours * MS_PER_HOUR)
  await insertSession(userId, hashToken(token), expiresAt)
  return { userId, token, expiresAt }
}

export async function login(
  email: string,
  password: string,
  ttlHours: number,
): Promise<SessionGrant | undefined> {
  const userId = await verifyCredentials(email, password)
  if (userId === undefined) return undefined
  return issueSession(userId, ttlHours)
}

/**
 * Resolve a bearer token to its owner's user id, or undefined when the token
 * is unknown or expired (the resolver filters expired sessions). The caller
 * binds the id into the request context; the plaintext never leaves here.
 */
export async function authenticateToken(token: string): Promise<string | undefined> {
  const session = await resolveSession(hashToken(token))
  return session?.userId
}

/**
 * Rotate an authenticated user's password AND revoke every OTHER live session,
 * keeping the one that made the request. Orchestration lives here,
 * not in the transport (hard rule 5): the route hands core the plaintext bearer
 * token of the current request; hashToken() is PRIVATE to this module, so the
 * hash is derived INSIDE core and the plaintext never leaves it.
 *
 * ATOMICITY: the password UPDATE and the session DELETE commit in ONE
 * DB transaction (rotatePasswordAndRevokeOthers, packages/db). A failure in
 * EITHER write rolls BOTH back, so we can never leave the new hash live while
 * other sessions stay valid (which the previous two-await version did when the
 * session delete failed AFTER the password commit, locking the user out of any
 * retry). The CURRENT password is verified read-only FIRST: a wrong password
 * throws {@link InvalidCurrentPasswordError} BEFORE the transaction opens, so a
 * failed rotation revokes nothing and writes nothing. The verified stored hash
 * is the compare-and-swap predicate for the in-tx UPDATE — a concurrent rotation
 * that already moved the hash matches zero rows, so the tx rolls back and we
 * throw the same uniform error (TOCTOU-safe, revoking nothing).
 *
 * Never log the token, its hash, or either password (hard rule 6).
 */
export async function changePasswordAndRevokeOthers(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentToken: string,
): Promise<void> {
  const storedHash = await verifyCurrentPasswordHash(userId, currentPassword)
  const newHash = await hashPassword(newPassword)
  const rotated = await rotatePasswordAndRevokeOthers(
    userId,
    storedHash,
    newHash,
    hashToken(currentToken),
  )
  if (!rotated) throw new InvalidCurrentPasswordError()
}
