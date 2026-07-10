// SPDX-License-Identifier: Apache-2.0
// getCurrentUser(): the /me identity policy surface.
//
// apps -> core -> db layering (hard rule 5): thin policy over the db keyed
// identity lookup, wrapped in withTenant (hard rule 3). The userId is already
// authenticated (apiKeyAuth or the session-bearer path bound req.userId), so an
// absent row is an INVARIANT VIOLATION, not a client error — the user just
// authenticated as this id. It surfaces as a generic 500 (a typed throw the REST
// guard catches), never a 404.
//
// Observability (hard rule 6): the email is PII-adjacent and is NEVER logged
// here; callers log the id hash only. This module logs nothing.
import { getUserIdentityById, type UserIdentityRow, withTenant } from '@3ngram/db'

export type { UserIdentityRow } from '@3ngram/db'

/**
 * Fetch the authenticated user's id + email. The userId is already verified by
 * the auth middleware, so a missing row means the identity was deleted mid-
 * request — an invariant violation surfaced as a throw (generic 500), not a 404.
 * Runs inside withTenant(): the keyed lookup returns at most the caller's own
 * identity.
 *
 * @param userId  The authenticated tenant (req.userId).
 * @throws when the just-authenticated identity no longer exists (invariant break).
 */
export async function getCurrentUser(userId: string): Promise<UserIdentityRow> {
  const row = await withTenant(userId, (tx) => getUserIdentityById(tx, userId))
  if (row === undefined) throw new Error('authenticated user not found')
  return row
}
