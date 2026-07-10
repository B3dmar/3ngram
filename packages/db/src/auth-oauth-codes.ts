// SPDX-License-Identifier: Apache-2.0
// Typed wrappers over the oauth_codes authorization-code path (docs/concepts/data-model.mdx;
// single-use, <=60s TTL, PKCE-bound).
//
// Two access disciplines, matching the table's RLS posture (mirrors
// auth-sessions.ts):
// - insertOauthCode(): a tenant-scoped write — the consent POST just verified
//   the user's credentials, so the INSERT runs through withTenant(userId) and
//   the oauth_codes RLS WITH CHECK enforces user_id == app.user_id.
// - consumeOauthCode(): a PRE-TENANT, ATOMIC single-use consumption — the
//   token endpoint must resolve a presented code hash to its grant BEFORE any
//   tenant context exists. It goes through the SECURITY DEFINER
//   `auth_consume_oauth_code` resolver (migrations/0003_auth_resolvers.sql),
//   which marks the code used and returns its grant in ONE statement — a
//   replayed, expired, or unknown code returns no row, so single-use holds
//   under concurrency without any app-side locking.
//
// Only the SHA-256 hash of the code ever reaches this layer (hard rule 6;
// mirrors the oauth_tokens token_hash pattern) — core mints and hashes.
import { sql } from 'drizzle-orm'
import { getAdminDb, withTenant } from './client.js'
import { guardCredentialIssuance } from './credential-guard.js'
import { oauthCodes } from './schema/identity.js'

/** Insert shape: core supplies the pre-hashed code and the ≤60s expiry. */
export interface NewOauthCode {
  codeHash: string
  clientId: string
  redirectUri: string
  /** RFC 6749 §4.1.3: was redirect_uri present in the /authorize request? */
  redirectUriSupplied: boolean
  codeChallenge: string
  scope: string
  expiresAt: Date
}

/** The grant an atomically consumed (now burned) code resolves to. */
export interface ConsumedOauthCode {
  userId: string
  clientId: string
  redirectUri: string
  /** RFC 6749 §4.1.3: was redirect_uri present in the /authorize request? */
  redirectUriSupplied: boolean
  codeChallenge: string
  scope: string
}

/** Persist a PKCE-bound single-use code for an already-authenticated user. */
export async function insertOauthCode(userId: string, code: NewOauthCode): Promise<void> {
  await withTenant(userId, async (tx) => {
    // Refuse to mint an exchangeable code on a tombstoned account (the exchange
    // itself is also guarded, but minting nothing closes the window earlier).
    await guardCredentialIssuance(tx, userId)
    await tx.insert(oauthCodes).values({ ...code, userId })
  })
}

/**
 * Atomically consume a code by its hash: marks it used and returns the grant,
 * or undefined when the hash is unknown, already used (replay), or expired —
 * the resolver's UPDATE ... WHERE used_at IS NULL guarantees exactly one
 * winner. PKCE verification happens in core AFTER consumption (consume-then-
 * verify): a failed exchange burns the code, it can never be retried.
 */
export async function consumeOauthCode(codeHash: string): Promise<ConsumedOauthCode | undefined> {
  const result = await getAdminDb().execute<{
    user_id: string
    client_id: string
    redirect_uri: string
    redirect_uri_supplied: boolean
    code_challenge: string
    scope: string
  }>(sql`SELECT user_id, client_id, redirect_uri, redirect_uri_supplied, code_challenge, scope
         FROM auth_consume_oauth_code(${codeHash})`)
  const row = result.rows[0]
  if (!row) return undefined
  return {
    userId: row.user_id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    redirectUriSupplied: row.redirect_uri_supplied,
    codeChallenge: row.code_challenge,
    scope: row.scope,
  }
}
