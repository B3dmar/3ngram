// SPDX-License-Identifier: Apache-2.0
// Identity read for the /me dashboard surface. SQL ONLY (hard rule
// 5): the core wrapper (read/me.ts) supplies the withTenant boundary and the
// not-found policy.
//
// `users` is the pre-tenant SYSTEM table (no user_id column, no RLS — see
// schema/identity.ts). The /me read happens AFTER auth, when the user_id is
// already known, so it runs inside withTenant(userId) like any other read for
// auditability (the no-raw-db lint plugin requires a TenantTx here), and pins the
// row by primary key (id = userId). RLS does not apply to `users`, so this is a
// direct keyed lookup of the caller's own identity — never an enumeration seam.
//
// Content discipline (hard rule 6): only the id + email are read; the
// password_hash is NEVER selected here.
import { eq } from 'drizzle-orm'
import { isAccountTombstoned } from './account-delete.js'
import type { TenantTx } from './client.js'
import { users } from './schema/identity.js'

/** The authenticated identity for /me — id + email only (no credential material). */
export interface UserIdentityRow {
  id: string
  email: string
}

/**
 * Fetch the id + email for one user by id, or undefined when absent. Keyed by
 * primary key (id = userId), so it returns at most the caller's own identity.
 * The password hash is never selected.
 */
export async function getUserIdentityById(
  tx: TenantTx,
  userId: string,
): Promise<UserIdentityRow | undefined> {
  const [row] = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row
}

/**
 * The account id of a LIVE user, or undefined when the row is absent or a
 * deletion tombstone (issue #321 — describe_environment's `account.id`). The
 * row's own primary key is returned, so the id comes from the identity model
 * rather than being echoed from the caller. The email and password hash are
 * read only to recognise a tombstone ({@link isAccountTombstoned}) and never
 * leave this function.
 */
export async function getLiveAccountId(tx: TenantTx, userId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (row === undefined || isAccountTombstoned(userId, row)) return undefined
  return row.id
}
