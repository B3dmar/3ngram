// SPDX-License-Identifier: Apache-2.0
// Typed wrapper over the oauth_tokens credential path (docs/concepts/data-model.mdx).
//
// resolveOauthToken(): a PRE-TENANT lookup — a presented access-token hash must
// resolve to a user_id BEFORE any tenant context exists. oauth_tokens has RLS
// ON, so this goes through the SECURITY DEFINER `auth_resolve_oauth_token`
// resolver (migrations/0003_auth_resolvers.sql), the one narrow audited path.
// The unscoped admin handle calls the function; the function (owned by the
// migration role) is what bypasses RLS, not us. The resolver filters
// `revoked_at IS NULL AND expires_at > now()`, so a revoked or grant-expired
// token never resolves — the RS-side revocation check.
//
// getAdminDb stays internal to this package (the barrel does not re-export it,
// audit) — callers get this narrow typed surface only.
//
// The token hash is hashed in packages/core (same SHA-256 input the issuer
// stored); it never leaves the auth layer (hard rule 6).
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { getAdminDb, lockAccountLifecycle, type TenantTx, withTenant } from './client.js'
import { userIsLiveForIssuance } from './credential-guard.js'
import { ResourceLimitExceededError } from './resource-limits.js'
import { oauthTokens } from './schema/identity.js'

/**
 * Has this user EVER been issued an OAuth token (onboarding connection
 * detection, contracts §onboarding)? True iff at least one oauth_tokens row
 * exists for the caller — the durable "an agent completed DCR + the code
 * exchange for me" signal. Counts revoked AND expired rows on purpose: the
 * onboarding step asks "did the user ever connect an agent", not "is a grant
 * live right now" (that is listClientsAuthorizedByUser). Runs through
 * withTenant(userId) so oauth_tokens RLS scopes the existence check to the
 * caller's own rows (hard rule 3) — user A can never read user B's connection
 * state. IDs/booleans only ever leave this path (hard rule 6).
 */
export async function userHasOauthToken(userId: string): Promise<boolean> {
  return withTenant(userId, async (tx) => {
    const [row] = await tx
      .select({ exists: sql<boolean>`true` })
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId))
      .limit(1)
    return row !== undefined
  })
}

/** A resolved, non-revoked, non-expired OAuth token: identity + grant metadata. */
export interface ResolvedOauthToken {
  userId: string
  clientId: string
  kind: string
  scope: string
  expiresAt: Date
}

/**
 * Resolve an access-token hash to its grant via the SECURITY DEFINER resolver.
 * Returns undefined when the hash is unknown, the token is revoked, or the grant
 * has expired (the function filters both), so a stale or revoked grant never
 * resolves. The caller (core verifyAccessToken) still checks `kind === 'access'`.
 */
export async function resolveOauthToken(
  tokenHash: string,
): Promise<ResolvedOauthToken | undefined> {
  // Raw `execute` rows bypass drizzle's column type mapping, so expires_at
  // arrives as a string from pg; coerce to Date at the boundary to honour the
  // typed wrapper contract (user_id/client_id/kind/scope are already strings).
  const result = await getAdminDb().execute<{
    user_id: string
    client_id: string
    kind: string
    scope: string
    expires_at: string
  }>(sql`SELECT user_id, client_id, kind, scope, expires_at
         FROM auth_resolve_oauth_token(${tokenHash})`)
  const row = result.rows[0]
  if (!row) return undefined
  return {
    userId: row.user_id,
    clientId: row.client_id,
    kind: row.kind,
    scope: row.scope,
    expiresAt: new Date(row.expires_at),
  }
}

// --- OAuth AS: issuance + refresh rotation. Tenant-scoped
// writes — the user just authenticated (consent POST) or was resolved from the
// presented refresh token, so each runs through withTenant(userId) and the
// oauth_tokens RLS WITH CHECK enforces user_id == app.user_id. ---

/** Insert shape: core supplies the pre-hashed token (hard rule 6) and TTL. */
export interface NewOauthToken {
  tokenHash: string
  kind: 'access' | 'refresh'
  clientId: string
  scope: string
  expiresAt: Date
}

/** Live client ids, newest grant/rotation first with a stable id tiebreak. */
async function liveClientRecency(
  tx: TenantTx,
  userId: string,
): Promise<Array<{ clientId: string; lastIssuedAt: Date }>> {
  const lastIssuedAt = sql<Date>`max(${oauthTokens.createdAt})`
  const rows = await tx
    .select({ clientId: oauthTokens.clientId, lastIssuedAt })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.userId, userId),
        isNull(oauthTokens.revokedAt),
        sql`${oauthTokens.expiresAt} > now()`,
      ),
    )
    .groupBy(oauthTokens.clientId)
    .orderBy(desc(lastIssuedAt), asc(oauthTokens.clientId))
  return rows.map((row) => ({ ...row, lastIssuedAt: new Date(row.lastIssuedAt) }))
}

async function assertClientCanBeIssued(
  tx: TenantTx,
  userId: string,
  clientId: string,
  maxActiveMcpClients: number | undefined,
): Promise<void> {
  if (maxActiveMcpClients === undefined) return
  const activeClients = await liveClientRecency(tx, userId)
  const isActive = activeClients.some((client) => client.clientId === clientId)
  if (isActive) {
    const retainedClients = activeClients.slice(0, maxActiveMcpClients)
    if (
      activeClients.length <= maxActiveMcpClients ||
      retainedClients.some((client) => client.clientId === clientId)
    ) {
      return
    }
    throw new ResourceLimitExceededError('active_mcp_clients')
  }
  if (activeClients.length >= maxActiveMcpClients) {
    throw new ResourceLimitExceededError('active_mcp_clients')
  }
}

async function assertClientCanRotate(
  tx: TenantTx,
  userId: string,
  clientId: string,
  maxActiveMcpClients: number | undefined,
): Promise<void> {
  if (maxActiveMcpClients === undefined) return
  const retainedClients = (await liveClientRecency(tx, userId)).slice(0, maxActiveMcpClients)
  if (!retainedClients.some((client) => client.clientId === clientId)) {
    throw new ResourceLimitExceededError('active_mcp_clients')
  }
}

/**
 * Persist a freshly minted access token — and its refresh token when one was
 * issued — in one transaction, serialized against account deletion by the
 * account-lifecycle advisory lock.
 * Returns false WITHOUT inserting when the user is a deletion tombstone — the
 * caller maps that to invalid_grant, so a code-exchange that raced a deletion
 * never resurrects a live credential on the deleted account.
 *
 * `refresh` is undefined for a client that never advertised the refresh_token
 * grant. Storing a hash for a token no client was ever handed would leave a row
 * that can never be presented and never rotated, so it is simply not written.
 */
export async function insertOauthTokenPair(
  userId: string,
  access: NewOauthToken,
  refresh: NewOauthToken | undefined,
  maxActiveMcpClients?: number,
): Promise<boolean> {
  return withTenant(userId, async (tx) => {
    await lockAccountLifecycle(tx, userId)
    if (!(await userIsLiveForIssuance(tx, userId))) return false
    await assertClientCanBeIssued(tx, userId, access.clientId, maxActiveMcpClients)
    const rows = [{ ...access, userId }]
    if (refresh !== undefined) rows.push({ ...refresh, userId })
    await tx.insert(oauthTokens).values(rows)
    return true
  })
}

/**
 * One-time refresh rotation (rotating, one-time-use), atomically:
 * revoke the predecessor (UPDATE ... WHERE revoked_at IS NULL — exactly one
 * winner under concurrency) and insert the successor pair, the new refresh
 * carrying rotated_from = predecessor id (the partial unique index on
 * rotated_from is the schema-level backstop against a double rotation).
 * Returns false — nothing inserted — when the predecessor was already revoked
 * or rotated, so reuse of a rotated refresh token fails closed.
 *
 * Also serialized against account deletion by the account-lifecycle advisory
 * lock and gated on the deletion marker: a rotation that races a
 * deletion either commits-then-gets-revoked-by-deletion, or runs after it and is
 * refused here — so it cannot resurrect a live credential on a deleted account.
 */
export async function rotateOauthRefreshToken(
  userId: string,
  predecessorHash: string,
  access: NewOauthToken,
  refresh: NewOauthToken,
  maxActiveMcpClients?: number,
): Promise<boolean> {
  return withTenant(userId, async (tx) => {
    await lockAccountLifecycle(tx, userId)
    if (!(await userIsLiveForIssuance(tx, userId))) return false
    await assertClientCanRotate(tx, userId, access.clientId, maxActiveMcpClients)
    const revoked = await tx
      .update(oauthTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(oauthTokens.tokenHash, predecessorHash),
          eq(oauthTokens.kind, 'refresh'),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .returning({ id: oauthTokens.id })
    const predecessor = revoked[0]
    if (predecessor === undefined) return false
    await tx.insert(oauthTokens).values([
      { ...access, userId },
      { ...refresh, userId, rotatedFrom: predecessor.id },
    ])
    return true
  })
}
