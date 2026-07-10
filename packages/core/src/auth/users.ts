// SPDX-License-Identifier: Apache-2.0
// User provisioning plus the verified/unverified insertion seam
// shared by operator-created users and self-serve signup. Provisioning callers
// invoke createUser(); public signup goes through createUnverifiedUser-style
// semantics inside the email-verification flow.
//
// This is the apps->core->db layer: validate at the one boundary
// (userCredentialsSchema), hash here, persist through the narrow packages/db
// admin helper. No pool access leaks into core (check-db-access.sh enforces).
//
// Never log email or password.
import { getUserPasswordHashById, insertUser, updateUserPassword } from '@3ngram/db'
import { userCredentialsSchema } from '@3ngram/schema'
import { hashPassword, verifyPassword } from './password.js'

export interface ProvisionedUser {
  id: string
  email: string
}

/**
 * Thrown by {@link changePassword} when the supplied current password does not
 * match the stored hash (or the user id resolves to no row). The transport maps
 * it to a uniform 401 — the change-password endpoint never distinguishes a wrong
 * password from a missing user, so it leaks nothing (mirrors the login 401).
 */
export class InvalidCurrentPasswordError extends Error {
  constructor() {
    super('current password is incorrect')
    this.name = 'InvalidCurrentPasswordError'
  }
}

/**
 * Provision a new user from raw credentials. Validates the email+password
 * pair, hashes with argon2id, and inserts the identity. A duplicate email
 * surfaces as {@link DuplicateEmailError} from packages/db — callers decide
 * whether that is a 409 (REST) or a CLI error (re-exported from this package
 * as `DuplicateEmailError`).
 */
async function createUserWithVerificationState(
  email: string,
  password: string,
  emailVerifiedAt: Date | null,
): Promise<ProvisionedUser> {
  const credentials = userCredentialsSchema.parse({ email, password })
  const passwordHash = await hashPassword(credentials.password)
  const row = await insertUser(credentials.email, passwordHash, { emailVerifiedAt })
  return { id: row.id, email: row.email }
}

export async function createUser(email: string, password: string): Promise<ProvisionedUser> {
  return createUserWithVerificationState(email, password, new Date())
}

export async function createUnverifiedUser(
  email: string,
  password: string,
): Promise<ProvisionedUser> {
  return createUserWithVerificationState(email, password, null)
}

/**
 * Re-verify a user's CURRENT password read-only and return the stored hash on
 * success (the verified hash is the compare-and-swap predicate for the in-place
 * UPDATE that follows). Throws {@link InvalidCurrentPasswordError} for a wrong
 * password OR a user id with no row, so the transport returns a uniform 401 with
 * no enumeration. This is the verify seam shared by changePassword() and the
 * atomic rotate-and-revoke path: verification is read-only and MUST run before
 * any write, so a failed credential check never mutates state. `users` is the
 * pre-tenant system table (no RLS), so the read uses the id-keyed admin helper.
 * Never log the password or the hash (hard rule 6).
 */
export async function verifyCurrentPasswordHash(
  userId: string,
  currentPassword: string,
): Promise<string> {
  const storedHash = await getUserPasswordHashById(userId)
  if (storedHash === undefined || !(await verifyPassword(storedHash, currentPassword))) {
    throw new InvalidCurrentPasswordError()
  }
  return storedHash
}

/**
 * Rotate an authenticated user's password. The caller supplies the
 * already-authenticated user id (bound by the auth middleware), the current
 * password to re-verify, and the new password (both shape-validated at the one
 * boundary, changePasswordInputSchema). Fetches the stored hash via the id-keyed
 * admin helper, verifies the current password with the shared argon2id
 * verifyPassword, hashes the new password, and persists in place.
 *
 * A wrong current password — or a user id with no row — throws
 * {@link InvalidCurrentPasswordError} so the transport returns a uniform 401
 * with no enumeration. The persist step is a compare-and-swap keyed by the
 * just-verified hash: if a concurrent rotation already moved the hash between
 * the read and the write (TOCTOU), the swap matches zero rows and this throws
 * the same error rather than silently clobbering the other write. `users` is the
 * pre-tenant system table (no RLS), so this stays OUTSIDE withTenant() like
 * createUser. Never log either password or the hash (hard rule 6).
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const storedHash = await verifyCurrentPasswordHash(userId, currentPassword)
  const newHash = await hashPassword(newPassword)
  const swapped = await updateUserPassword(userId, storedHash, newHash)
  if (!swapped) {
    throw new InvalidCurrentPasswordError()
  }
}
