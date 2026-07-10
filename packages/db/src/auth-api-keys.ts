// SPDX-License-Identifier: Apache-2.0
// Typed wrappers over the api_keys credential paths (docs/concepts/data-model.mdx).
//
// Two access disciplines, matching the table's RLS posture (mirrors
// auth-sessions.ts):
// - resolveApiKey(): a PRE-TENANT lookup — a presented key hash must resolve to
//   a user_id BEFORE any tenant context exists. api_keys has RLS ON, so this
//   goes through the SECURITY DEFINER `auth_resolve_api_key` resolver
//   (migrations/0003_auth_resolvers.sql), the one narrow audited path. The
//   unscoped admin handle calls the function; the function (owned by the
//   migration role) is what bypasses RLS, not us.
// - insert/list/revoke/touch: tenant-scoped reads/writes — the user_id is
//   already known (the session-authed route bound it), so each runs through
//   withTenant(userId), satisfying the api_keys RLS like any user-owned access.
//
// getAdminDb stays internal to this package (the barrel does not re-export it,
// audit) — callers get this narrow typed surface only.
//
// HASHES NEVER LEAVE THIS LAYER on a read path: listApiKeys returns name /
// prefix / timestamps only (hard rule 6) so a key_hash cannot leak to a route.
import { and, eq, sql } from 'drizzle-orm'
import { getAdminDb, withTenant } from './client.js'
import { guardCredentialIssuance } from './credential-guard.js'
import { apiKeys } from './schema/identity.js'

/** A resolved API key: the owning identity only (the resolver returns no more). */
export interface ResolvedApiKey {
  userId: string
}

/** API-key metadata safe to surface to its owner — NEVER the hash. */
export interface ApiKeyMetadata {
  id: string
  name: string
  prefix: string
  createdAt: Date
  lastUsedAt: Date | undefined
  revokedAt: Date | undefined
}

/**
 * Resolve a presented key hash to its owner via the SECURITY DEFINER resolver.
 * Returns undefined when the hash is unknown OR the key is revoked (the
 * function filters `revoked_at IS NULL`), so a revoked key never resolves.
 */
export async function resolveApiKey(keyHash: string): Promise<ResolvedApiKey | undefined> {
  const result = await getAdminDb().execute<{ user_id: string }>(
    sql`SELECT user_id FROM auth_resolve_api_key(${keyHash})`,
  )
  const row = result.rows[0]
  if (!row) return undefined
  return { userId: row.user_id }
}

/**
 * Persist a new API key for an already-authenticated user. Runs through
 * withTenant(userId): the row is a user-owned write, so the api_keys RLS WITH
 * CHECK enforces user_id == app.user_id — a forged userId fails closed. Only
 * the SHA-256 hash of the full key string is stored (the plaintext never
 * touches the DB). Returns the new row id for the issuance response.
 *
 * Serialized against account deletion (account-lifecycle lock) and refuses with
 * AccountDeletedError when the user is a deletion tombstone — a session-authed
 * issuance that raced a deletion cannot mint a live key on the deleted account
 * (resurrection race).
 */
export async function insertApiKey(
  userId: string,
  name: string,
  keyHash: string,
  prefix: string,
): Promise<{ id: string; createdAt: Date }> {
  return withTenant(userId, async (tx) => {
    await guardCredentialIssuance(tx, userId)
    const [row] = await tx
      .insert(apiKeys)
      .values({ userId, name, keyHash, prefix })
      .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt })
    if (!row) throw new Error('insertApiKey returned no row')
    return row
  })
}

/**
 * List a user's API keys (metadata only — never the hash). Runs through
 * withTenant(userId): RLS scopes the SELECT to the caller's rows, so a wrong
 * tenant transport cannot read another user's keys (exit criterion).
 */
export async function listApiKeys(userId: string): Promise<ApiKeyMetadata[]> {
  return withTenant(userId, async (tx) => {
    const rows = await tx
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? undefined,
      revokedAt: r.revokedAt ?? undefined,
    }))
  })
}

/**
 * Revoke a key the caller owns (append-and-supersede: stamps revoked_at, never
 * deletes — hard rule 1). Runs through withTenant(userId); RLS makes another
 * user's key invisible, so the UPDATE matches nothing for a wrong-tenant id.
 * Returns true when a row was revoked, false when none matched (unknown id,
 * not-owned, or already revoked).
 */
export async function revokeApiKey(userId: string, id: string): Promise<boolean> {
  return withTenant(userId, async (tx) => {
    const revoked = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), sql`${apiKeys.revokedAt} IS NULL`))
      .returning({ id: apiKeys.id })
    return revoked.length > 0
  })
}

/**
 * Best-effort last_used_at stamp after a successful resolution. Tenant-scoped
 * (the resolution just yielded the userId) so RLS still applies. Callers invoke
 * this fire-and-forget AFTER responding — it must never block the request, and
 * its rejection must be caught + logged redacted by the caller (hard rule 6).
 */
export async function touchApiKeyLastUsed(userId: string, keyHash: string): Promise<void> {
  await withTenant(userId, async (tx) => {
    await tx
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.keyHash, keyHash)))
  })
}
