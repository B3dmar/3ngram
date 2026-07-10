// SPDX-License-Identifier: Apache-2.0
// Narrow admin helpers for the PRE-TENANT system tables (docs/concepts/data-model.mdx).
//
// `users` is a true system table (no user_id, no RLS) — withTenant() cannot
// apply because the identity must be inserted/looked up BEFORE any tenant
// context exists. These helpers keep pool access inside packages/db (the only
// package allowed to touch Postgres; scripts/check-db-access.sh enforces it)
// while exposing a deliberately tiny surface for identity creation, lookup, and
// credential updates. Nothing here bypasses RLS for user-owned tables.
//
// `app_user` is granted SELECT/INSERT/UPDATE on `users` directly (no resolver needed
// since there is no RLS to defeat) — scripts/provision-roles.sql.
import { and, eq, sql } from 'drizzle-orm'
import { getAdminDb } from './client.js'
import { isUniqueViolation } from './pg-errors.js'
import { users } from './schema/identity.js'

export interface UserRow {
  id: string
  email: string
  emailVerifiedAt: Date | null
  passwordHash: string
}

export interface InsertUserOptions {
  /** Defaults to now for operator-provisioned users; signup passes null. */
  emailVerifiedAt?: Date | null
}

/**
 * Thrown when {@link insertUser} hits the `users_email_unique` constraint.
 * Callers map this to a domain-level conflict without inspecting pg internals.
 */
export class DuplicateEmailError extends Error {
  constructor() {
    super('email already registered')
    this.name = 'DuplicateEmailError'
  }
}

/**
 * Insert a new identity. Email uniqueness is enforced by the DB constraint;
 * a collision surfaces as {@link DuplicateEmailError} rather than a raw pg
 * error so the conflict stays a typed boundary.
 */
export async function insertUser(
  email: string,
  passwordHash: string,
  options: InsertUserOptions = {},
): Promise<UserRow> {
  const emailVerifiedAt =
    options.emailVerifiedAt === undefined ? new Date() : options.emailVerifiedAt
  try {
    const [row] = await getAdminDb()
      .insert(users)
      .values({ email, emailVerifiedAt, passwordHash })
      .returning({
        id: users.id,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        passwordHash: users.passwordHash,
      })
    if (!row) throw new Error('insertUser returned no row')
    return row
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateEmailError()
    throw error
  }
}

/** Fetch one identity by email, or undefined when none exists. */
export async function getUserByEmail(email: string): Promise<UserRow | undefined> {
  const [row] = await getAdminDb()
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  return row
}

/**
 * Fetch ONLY the stored password hash for one user by id, or undefined when no
 * such user exists (workstream change-password). This is the verify
 * seam for the authenticated change-password flow: the caller already holds the
 * authenticated user id (bound by the auth middleware) and needs the credential
 * material to re-check the current password.
 *
 * Why a dedicated helper: getUserIdentityById (users-read.ts) deliberately OMITS
 * password_hash (hard rule 6 — no credential material on the /me read path), and
 * there is no getUserById. `users` is the PRE-TENANT system table (no RLS), so
 * this reads via the admin handle like its siblings — keyed by primary key, so it
 * returns at most the caller's own hash, never an enumeration seam. The hash is
 * the only column selected; the email is not, to keep the surface minimal.
 */
export async function getUserPasswordHashById(userId: string): Promise<string | undefined> {
  const [row] = await getAdminDb()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.passwordHash
}

/**
 * Replace the password hash for an unverified self-serve signup retry. This is
 * intentionally narrower than updateUserPassword(): the caller is not
 * authenticated yet, so the write must stop the instant email_verified_at is
 * set. The expected-hash predicate preserves compare-and-swap behavior for
 * concurrent signup retries; returning false means the caller must re-read the
 * account state before deciding whether to mint a verification token.
 */
export interface SignupEmailVerificationToken {
  tokenHash: string
  clientProofHash: string
  expiresAt: Date
}

export async function insertUnverifiedUserWithEmailVerificationToken(
  email: string,
  passwordHash: string,
  token: SignupEmailVerificationToken,
): Promise<UserRow> {
  try {
    const result = await getAdminDb().execute<{ user_id: string }>(
      sql`SELECT user_id FROM auth_create_unverified_signup(${email}, ${passwordHash}, ${token.tokenHash}, ${token.clientProofHash}, ${token.expiresAt})`,
    )
    const userId = result.rows[0]?.user_id
    if (userId === undefined) throw new Error('auth_create_unverified_signup returned no row')
    return { id: userId, email, emailVerifiedAt: null, passwordHash }
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateEmailError()
    throw error
  }
}

export async function retryUnverifiedSignupWithEmailVerificationToken(
  userId: string,
  expectedHash: string,
  passwordHash: string,
  token: SignupEmailVerificationToken,
): Promise<boolean> {
  const result = await getAdminDb().execute<{ retried: boolean }>(
    sql`SELECT auth_retry_unverified_signup(${userId}, ${expectedHash}, ${passwordHash}, ${token.tokenHash}, ${token.clientProofHash}, ${token.expiresAt}) AS retried`,
  )
  return result.rows[0]?.retried === true
}

/**
 * Compare-and-swap one user's password hash, keyed by id AND the expected
 * current hash (workstream change-password). UPDATE-in-place, NOT
 * append-and-supersede: `users` is a system identity table, not memory data —
 * hard rule 1 governs memory rows, and a credential rotation that left the old
 * hash live would be a security defect. `users` is pre-tenant (no RLS), so this
 * uses the admin handle like insertUser; withTenant() does not apply here.
 *
 * The `expectedHash` predicate closes the change-password TOCTOU window: two
 * concurrent valid rotations both verify the same old hash, but only the first
 * matches the WHERE clause — the second updates zero rows and the caller treats
 * that as a stale current password. Returns true when exactly one row was
 * written, false when the predicate did not match. Never log the hash (rule 6).
 */
export async function updateUserPassword(
  userId: string,
  expectedHash: string,
  passwordHash: string,
): Promise<boolean> {
  const rows = await getAdminDb()
    .update(users)
    .set({ passwordHash })
    .where(and(eq(users.id, userId), eq(users.passwordHash, expectedHash)))
    .returning({ id: users.id })
  return rows.length === 1
}

/**
 * Enumerate every tenant's user id (workstream F). The background
 * worker fans its per-tenant scans out over this list; each tenant's actual data
 * access then runs inside withTenant(userId) under RLS. `users` is the
 * pre-tenant system table (no RLS of its own), so this legitimately reads via
 * the admin handle — the ONLY id-enumeration seam, deliberately tiny and
 * content-free (ids only; hard rule 6). Ordered for a stable, resumable fan-out.
 */
export async function listTenantIds(): Promise<string[]> {
  const rows = await getAdminDb().select({ id: users.id }).from(users).orderBy(users.id)
  return rows.map((r) => r.id)
}
