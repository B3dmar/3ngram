// SPDX-License-Identifier: Apache-2.0
// Typed wrappers over oauth_clients — RFC 7591 registrations and CIMD
// materialized FK/display rows (confidential-client support remains DCR-only).
//
// oauth_clients is a true SYSTEM table: client resolution happens PRE-AUTH, so
// rows carry no user_id and no RLS applies (schema/identity.ts). These helpers
// therefore mirror the auth-admin.ts discipline: getAdminDb() stays internal to
// packages/db (the barrel never re-exports it). registerClient / getClientByClientId
// / updateLastUsedAt touch only the system table via that audited admin path.
//
// CONSENT IS GRANT-SCOPED, NOT CLIENT-SCOPED (A3): "the apps I
// authorized" is derived from THE CALLER'S oauth_tokens (oauth_tokens carries
// user_id + RLS), never from oauth_clients (global, no user_id). So
// listClientsAuthorizedByUser / revokeClientForUser run through withTenant()
// (hard rule 3): RLS scopes the JOIN/UPDATE to the caller's tokens, so user A
// can never see or revoke user B's grants. revoke = stamp the caller's live
// tokens revoked_at AND burn the caller's live unused codes (append-and-
// supersede, hard rule 1) — it NEVER deletes the global client row, which other
// users' grants still reference.
//
// SECRET DISCIPLINE (hard rule 6): only the SHA-256 hash of a confidential
// client's secret ever reaches this layer — core mints and hashes; the
// plaintext is returned once at registration and never persisted or logged.
// The unique-indexed client_id is the lookup key (the analogue of
// api_keys.prefix), so resolution is a fast indexed equality with the hash
// compared in core, never scanned.
//
// The 0005 CHECK constraints (auth-method enum; none => hash NULL, confidential
// => hash NOT NULL) are pre-empted upstream: the Zod enum rejects unknown
// methods at the boundary and core derives the hash from the validated method,
// so a CHECK violation here would be a programming bug, not a user error.

import type {
  ClientIdMetadataDocument,
  OAuthClientRegistrationMethod,
  TokenEndpointAuthMethod,
} from '@3ngram/schema'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getAdminDb, withTenant } from './client.js'
import { oauthClients, oauthCodes, oauthTokens } from './schema/identity.js'

/** A stored DCR registration — the hash is internal plumbing, NEVER surfaced to a transport. */
export interface OAuthClientRow {
  clientId: string
  clientName: string
  redirectUris: string[]
  tokenEndpointAuthMethod: TokenEndpointAuthMethod
  clientSecretHash: string | null
  registrationMethod: OAuthClientRegistrationMethod
  createdAt: Date
}

/** Insert shape: direct callers default to DCR; CIMD uses its dedicated upsert. */
export type NewOAuthClient = Omit<OAuthClientRow, 'createdAt' | 'registrationMethod'> & {
  registrationMethod?: OAuthClientRegistrationMethod
}

const clientColumns = {
  clientId: oauthClients.clientId,
  clientName: oauthClients.clientName,
  redirectUris: oauthClients.redirectUris,
  tokenEndpointAuthMethod: oauthClients.tokenEndpointAuthMethod,
  clientSecretHash: oauthClients.clientSecretHash,
  registrationMethod: oauthClients.registrationMethod,
  createdAt: oauthClients.createdAt,
}

/**
 * Persist a new dynamically-registered client. client_id collisions are not
 * mapped to a typed error: core mints ids from CSPRNG (UUID), so a unique
 * violation is a programming bug and may surface as the generic 500.
 */
export async function registerClient(client: NewOAuthClient): Promise<OAuthClientRow> {
  const [row] = await getAdminDb()
    .insert(oauthClients)
    .values({
      ...client,
      registrationMethod: client.registrationMethod ?? 'dynamic_registration',
    })
    .returning(clientColumns)
  if (!row) throw new Error('registerClient returned no row')
  return row
}

/**
 * Materialize validated CIMD metadata into oauth_clients. The row exists to
 * satisfy the oauth_codes/oauth_tokens foreign keys and to provide display
 * metadata for grant management; authorization policy always re-resolves the
 * cache-aware metadata document in core.
 *
 * A conflict may update only another CIMD row. It can never overwrite a DCR
 * registration, preserving the registration priority required by MCP.
 */
export async function materializeClientMetadata(
  document: ClientIdMetadataDocument,
): Promise<OAuthClientRow | undefined> {
  const [row] = await getAdminDb()
    .insert(oauthClients)
    .values({
      clientId: document.client_id,
      clientName: document.client_name,
      redirectUris: document.redirect_uris,
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: null,
      registrationMethod: 'client_id_metadata',
    })
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: {
        clientName: document.client_name,
        redirectUris: document.redirect_uris,
      },
      setWhere: eq(oauthClients.registrationMethod, 'client_id_metadata'),
    })
    .returning(clientColumns)
  return row
}

/** Fetch one registration by its unique client_id, or undefined when none exists. */
export async function getClientByClientId(clientId: string): Promise<OAuthClientRow | undefined> {
  const [row] = await getAdminDb()
    .select(clientColumns)
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1)
  return row
}

/**
 * Best-effort last_used_at stamp on a client after a successful token exchange,
 * the 30-day-idle GC signal. oauth_clients is the global
 * system table (no user_id), so this rides the audited admin path like
 * register/get above. The token route invokes it fire-and-forget AFTER
 * responding (hard rule 5 keeps that route thin): it must never block the
 * exchange and its rejection is the caller's to catch + log redacted.
 */
export async function updateLastUsedAt(clientId: string): Promise<void> {
  await getAdminDb()
    .update(oauthClients)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(oauthClients.clientId, clientId))
}

/** A client the caller has authorized — consent-UI metadata only, no secret material. */
export interface AuthorizedClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  /** Most recent grant (oauth_tokens.created_at) the caller holds for this client. */
  authorizedAt: Date
}

/**
 * The distinct clients the caller has authorized, derived from THE CALLER'S
 * live (non-revoked, unexpired) oauth_tokens — grant-scoped consent.
 * Runs through withTenant(userId): the oauth_tokens RLS scopes the JOIN to
 * the caller's rows, so user A never sees a client only user B authorized. The
 * client row is global, but it surfaces here ONLY because the caller holds a
 * token for it. Surfaces name + redirect host material for the consent screen
 * (show the redirect host, not just the name); NEVER the
 * client_secret_hash.
 */
export async function listClientsAuthorizedByUser(userId: string): Promise<AuthorizedClient[]> {
  return withTenant(userId, async (tx) => {
    const rows = await tx
      .select({
        clientId: oauthClients.clientId,
        clientName: oauthClients.clientName,
        redirectUris: oauthClients.redirectUris,
        authorizedAt: sql<Date>`max(${oauthTokens.createdAt})`.as('authorized_at'),
      })
      .from(oauthTokens)
      .innerJoin(oauthClients, eq(oauthTokens.clientId, oauthClients.clientId))
      .where(
        and(
          eq(oauthTokens.userId, userId),
          isNull(oauthTokens.revokedAt),
          // A client is "connected" only while it holds ≥1 LIVE token: a grant
          // whose tokens have all naturally expired (past the refresh TTL) is
          // dead and must not surface as a live Connected app (P2).
          sql`${oauthTokens.expiresAt} > now()`,
        ),
      )
      .groupBy(oauthClients.clientId, oauthClients.clientName, oauthClients.redirectUris)
    return rows.map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      redirectUris: r.redirectUris,
      // raw `max()` arrives as a string from pg; coerce to honour the typed contract.
      authorizedAt: new Date(r.authorizedAt),
    }))
  })
}

/**
 * Revoke the caller's grant for a client: stamp revoked_at on EVERY live token
 * (access + refresh) the caller holds for it (append-and-supersede, hard rule 1
 * — never DELETE, never touch the global client row), AND burn any LIVE unused
 * authorization code the caller still holds for it. The code burn closes a
 * revoke-bypass (P2): a concurrent/previous /authorize can leave a live,
 * unused oauth_code that consumeOauthCode would otherwise exchange into FRESH
 * tokens AFTER the user disconnected. Stamping used_at = now() mirrors single-
 * use consumption (auth_consume_oauth_code), so the resolver's
 * `WHERE used_at IS NULL` finds no winner and the exchange fails.
 *
 * Both writes run in the SAME withTenant(userId) transaction: oauth_tokens and
 * oauth_codes both carry user_id + tenantPolicy() RLS, so the UPDATE/burn can
 * only ever touch the CALLER'S rows — user B's grant (and B's live code) for
 * the same client survive untouched (hard rule 3, no tenant-isolation weakening).
 * Returns the count of tokens revoked (0 = no live token grant; a code-only
 * grant is still burned).
 */
export async function revokeClientForUser(userId: string, clientId: string): Promise<number> {
  return withTenant(userId, async (tx) => {
    const revoked = await tx
      .update(oauthTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(oauthTokens.userId, userId),
          eq(oauthTokens.clientId, clientId),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .returning({ id: oauthTokens.id })
    // Burn the caller's LIVE (unused, unexpired) codes for this client so a
    // pending authorization code cannot be exchanged post-revoke.
    await tx
      .update(oauthCodes)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(oauthCodes.userId, userId),
          eq(oauthCodes.clientId, clientId),
          isNull(oauthCodes.usedAt),
          sql`${oauthCodes.expiresAt} > now()`,
        ),
      )
    return revoked.length
  })
}

/**
 * Authoritative token-existence guard for the GC (data-loss defence). The 30-day
 * idle gate keys on last_used_at IS NULL, but last_used_at is best-effort
 * (updateLastUsedAt is fire-and-forget AFTER the response, and pre-existing rows
 * were never backfilled) — so a client that HAS issued tokens can still read
 * NULL and be selected for hard-DELETE, and the ON DELETE CASCADE FK
 * (oauth_tokens/oauth_codes → oauth_clients, 0000_init) would then silently
 * destroy a real user's grant. last_used_at is therefore a soft signal only; the
 * authoritative invariant is "no rows in oauth_tokens OR oauth_codes reference
 * this client".
 *
 * That existence check CANNOT be a plain `NOT EXISTS (SELECT 1 FROM oauth_tokens
 * ...)`: the GC runs as app_user (NOBYPASSRLS) with NO tenant context (a pre-auth
 * client has no user_id), and oauth_tokens/oauth_codes are RLS-protected
 * (0002_auth_rls.sql) — a tenant-less app_user sees ZERO rows, so the subquery
 * would silently match nothing and the guard would never fire. It therefore
 * delegates to the SECURITY DEFINER resolver auth_client_has_grants
 * (0014_client_has_grants_resolver.sql), which — owned by the table owner and so
 * exempt from the non-FORCED RLS — answers the cross-tenant existence question,
 * exactly like the auth_consume/auth_resolve_* resolvers. A token row is always
 * authoritative; an oauth_codes row only blocks GC while it is LIVE (unused and
 * unexpired) — an abandoned, expired code must not pin the client out of GC
 * forever. Both the scan and the delete AND this in, so a client with any live
 * or pending grant is structurally exempt regardless of last_used_at.
 */
function hasNoTokensOrCodes() {
  return sql`NOT auth_client_has_grants(${oauthClients.clientId})`
}

/**
 * GC scan helper: the client_ids of registrations
 * that have NEVER been used and were registered before `cutoff` — the 30-day
 * registered-but-never-used class. last_used_at IS NULL is the "never exchanged
 * a token" signal (updateLastUsedAt stamps it on first success); created_at <
 * cutoff is the age gate. The token-existence guard ({@link hasNoTokensOrCodes})
 * makes the predicate authoritative even when last_used_at was never stamped.
 * oauth_clients is the global system table, so this rides the admin path. IDs
 * only — the caller (core gc) logs counts (hard rule 6).
 */
export async function listGarbageCollectableClients(cutoff: Date): Promise<string[]> {
  const rows = await getAdminDb()
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(
      and(
        isNull(oauthClients.lastUsedAt),
        sql`${oauthClients.createdAt} < ${cutoff}`,
        hasNoTokensOrCodes(),
      ),
    )
  return rows.map((r) => r.clientId)
}

/**
 * Hard-delete the named idle clients (GC). This is the ONE place
 * oauth_clients rows are removed, and it is sound precisely because the input
 * set is constrained to last_used_at IS NULL: a never-used client has issued no
 * tokens, so ON DELETE CASCADE on oauth_codes/oauth_tokens removes nothing a
 * user relied on. This is NOT a memory write path (hard rule 1 governs memory
 * rows, not transient pre-auth DCR registrations). Returns the deleted count.
 *
 * The DELETE re-asserts last_used_at IS NULL AND the token-existence guard (not
 * just the id set): the scan and the delete run in the same daily pass, and a
 * client idle past `cutoff` could complete a token exchange in the window
 * between them — touchClientLastUsed would stamp last_used_at and mint live
 * access+refresh rows. Re-checking the full predicate ({@link hasNoTokensOrCodes}
 * too) inside the DELETE makes it idempotent with the scan invariant, so a
 * client that went live mid-pass — even if last_used_at was never stamped — is
 * skipped and its fresh tokens/codes are not CASCADE-orphaned (TOCTOU guard).
 */
export async function deleteClients(clientIds: string[]): Promise<number> {
  if (clientIds.length === 0) return 0
  const deleted = await getAdminDb()
    .delete(oauthClients)
    .where(
      and(
        inArray(oauthClients.clientId, clientIds),
        isNull(oauthClients.lastUsedAt),
        hasNoTokensOrCodes(),
      ),
    )
    .returning({ clientId: oauthClients.clientId })
  return deleted.length
}
