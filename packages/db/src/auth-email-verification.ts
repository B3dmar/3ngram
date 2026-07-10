// SPDX-License-Identifier: Apache-2.0
// Typed wrappers over the email_verification_tokens single-use path (signup).
//
// This mirrors auth-reset-tokens.ts: token minting is a tenant-scoped write
// through withTenant(userId), while the verify endpoint is pre-tenant and uses
// a narrow SECURITY DEFINER resolver to consume the token, mark the user
// verified, and burn sibling verification links atomically.
import { sql } from 'drizzle-orm'
import { getAdminDb, withTenant } from './client.js'
import { guardCredentialIssuance } from './credential-guard.js'
import { emailVerificationTokens } from './schema/identity.js'

export interface NewEmailVerificationToken {
  tokenHash: string
  clientProofHash: string
  expiresAt: Date
}

export async function insertEmailVerificationToken(
  userId: string,
  token: NewEmailVerificationToken,
): Promise<void> {
  await withTenant(userId, async (tx) => {
    // Uniform with the other credential minters: refuse on a
    // tombstoned account. (A verification token only sets email_verified_at, not
    // a login credential, so this is defense-in-depth rather than a live vector.)
    await guardCredentialIssuance(tx, userId)
    await tx.insert(emailVerificationTokens).values({ ...token, userId })
  })
}

/**
 * Resend the verification link: supersede the caller's prior link and
 * mint a fresh one, but ONLY when an UNCONSUMED token already exists for this
 * user with the SAME `clientProofHash` ("proof continuity"). Delegates to the
 * `auth_resend_email_verification` SECURITY DEFINER resolver (0021), which takes
 * the same per-user `auth_verify_email` advisory lock as the create/retry/verify
 * mutators and re-checks live + verified state UNDER the lock before minting.
 * That serialization is the fix for the Codex P1: the prior bare CTE
 * took no lock, so a resend racing a signup retry could observe a token the
 * retry had already consumed and mint a fresh link bound to the stale proof —
 * verifying the account under the competing signup's password (takeover).
 * Pre-tenant like peek/verify (the resolver scopes by user_id). Returns true
 * iff a fresh token was minted.
 *
 * Proof continuity is the security boundary, and it closes three holes at once
 * because the resend mints a token but does NOT touch the password the token
 * verifies into:
 *   - Account takeover (P1): if a second signup from another browser replaced
 *     the unverified password + token (the retry path CONSUMES the old token),
 *     the original browser's proof no longer matches any UNCONSUMED token, so a
 *     resend with that stale proof mints nothing — it cannot re-activate a link
 *     that would verify the account under someone else's password.
 *   - Griefing: a public resend with a proof that never owned a live token
 *     matches nothing — it neither burns the victim's link nor mints anything.
 *   - Verify race: the resolver's under-lock verified gate means a resend that
 *     races verification finds the account verified (its tokens consumed) and
 *     mints nothing — no verification link outlives verification.
 */
export async function replaceEmailVerificationTokens(
  userId: string,
  token: NewEmailVerificationToken,
): Promise<boolean> {
  const result = await getAdminDb().execute<{ minted: boolean }>(
    sql`SELECT auth_resend_email_verification(${userId}, ${token.tokenHash}, ${token.clientProofHash}, ${token.expiresAt}) AS minted`,
  )
  return result.rows[0]?.minted === true
}

export async function peekEmailVerificationToken(
  tokenHash: string,
  clientProofHash: string,
): Promise<string | undefined> {
  const result = await getAdminDb().execute<{ user_id: string }>(
    sql`SELECT user_id FROM auth_peek_email_verification_token(${tokenHash}, ${clientProofHash})`,
  )
  return result.rows[0]?.user_id
}

export async function verifyEmailTokenAtomic(
  tokenHash: string,
  clientProofHash: string,
): Promise<string | undefined> {
  const result = await getAdminDb().execute<{ user_id: string }>(
    sql`SELECT user_id FROM auth_verify_email(${tokenHash}, ${clientProofHash})`,
  )
  return result.rows[0]?.user_id
}
