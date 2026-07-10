// SPDX-License-Identifier: Apache-2.0
// RFC 7591 dynamic client registration policy. The apps->core->db
// layer: the /oauth/register route stays
// thin; this module owns id/secret minting, hashing, and the response shape.
//
// Secret scheme (mirrors api-keys.ts): a confidential client's secret is 32
// bytes of CSPRNG entropy, base64url-encoded; the DB stores ONLY its SHA-256
// hex hash. SHA-256 (not argon2id) is correct because the input is
// high-entropy random — there is no dictionary to defend against. The
// unique-indexed client_id plays the api_keys.prefix role: lookup is a fast
// indexed equality, then a hash compare (the token-endpoint auth path). The
// plaintext secret is returned exactly ONCE in the 201 body and never logged
// (hard rule 6). Public clients ('none') get no secret and a NULL hash —
// together with the schema's auth-method enum this satisfies the 0005 DB
// CHECKs by construction, so they can never surface as raw pg failures.
//
// 30-day client GC is explicitly DEFERRED:
// secrets do not expire. RFC 7591 §3.2.1 makes client_secret_expires_at
// REQUIRED whenever a client_secret is issued, with 0 meaning "never expires" —
// so the 201 body carries client_secret_expires_at: 0 alongside the secret,
// while getClient (no secret in that shape) omits the member.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  type AuthorizedClient,
  getClientByClientId,
  listClientsAuthorizedByUser,
  type OAuthClientRow,
  registerClient,
  revokeClientForUser,
  updateLastUsedAt,
} from '@3ngram/db'
import type { ClientRegistrationInput, TokenEndpointAuthMethod } from '@3ngram/schema'

const CLIENT_SECRET_BYTES = 32

/**
 * RFC 7591 client information — structurally assignable to the MCP SDK 1.29
 * `OAuthClientInformationFull` (client_id + redirect_uris required, the rest
 * optional). Declared locally because packages/core does not depend on
 * @modelcontextprotocol/sdk (the lockfile is frozen — hard rule 7); the
 * apps/server contract test pins the assignability at compile time.
 */
export interface OAuthClientInformation {
  client_id: string
  client_id_issued_at: number
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: TokenEndpointAuthMethod
  /** Echoed per RFC 7591 §3.2.1 (strict clients validate it) — what the AS actually grants. */
  grant_types: string[]
  response_types: string[]
  client_secret?: string
  /** Present iff client_secret is (RFC 7591 §3.2.1); always 0 = never expires (GC deferred). */
  client_secret_expires_at?: number
}

/**
 * Structural mirror of the SDK's `OAuthRegisteredClientsStore` getClient member
 * — the AS hands {@link oauthClientsStore} to mcpAuthRouter unchanged.
 * `registerClient` is deliberately NOT implemented on the store: the SDK's
 * permissive RFC 7591 metadata schema would bypass the packages/schema
 * redirect-URI policy (hard rule 2 — one validation boundary), so DCR is served
 * exclusively by POST /oauth/register; the SDK router consequently does not
 * mount its own /register handler.
 */
export interface OAuthClientsStore {
  getClient(clientId: string): Promise<OAuthClientInformation | undefined>
}

/** sha256(secret) hex — the only form of a client secret the DB ever sees. */
export function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** RFC 7591 client_name is optional but the column is NOT NULL: default to the first redirect host. */
function defaultClientName(redirectUris: string[]): string {
  const first = redirectUris[0]
  return first === undefined ? 'unnamed-client' : new URL(first).hostname
}

// What the AS actually grants every client (authorization_code +
// PKCE with rotating refresh tokens). Echoed in the DCR 201 AND getClient per
// RFC 7591 §3.2.1 — a strict client may validate the echo against what it
// requested, so it must name refresh_token now that the server issues them.
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const
const RESPONSE_TYPES = ['code'] as const

/** Map a stored row to the RFC 7591 information shape — never the hash, never a secret. */
function toClientInformation(row: OAuthClientRow): OAuthClientInformation {
  return {
    client_id: row.clientId,
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    client_name: row.clientName,
    redirect_uris: row.redirectUris,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    grant_types: [...GRANT_TYPES],
    response_types: [...RESPONSE_TYPES],
  }
}

/**
 * Register a client from a schema-validated request. Mints a UUID client_id;
 * confidential methods (client_secret_post / client_secret_basic) also mint a
 * secret whose SHA-256 hash is persisted while the plaintext rides back ONCE on
 * the returned information. Public clients ('none') keep client_secret_hash
 * NULL and get client_id only.
 */
export async function registerOAuthClient(
  input: ClientRegistrationInput,
): Promise<OAuthClientInformation> {
  const confidential = input.token_endpoint_auth_method !== 'none'
  const clientSecret = confidential
    ? randomBytes(CLIENT_SECRET_BYTES).toString('base64url')
    : undefined
  const row = await registerClient({
    clientId: randomUUID(),
    clientName: input.client_name ?? defaultClientName(input.redirect_uris),
    redirectUris: input.redirect_uris,
    tokenEndpointAuthMethod: input.token_endpoint_auth_method,
    clientSecretHash: clientSecret === undefined ? null : hashClientSecret(clientSecret),
  })
  const info = toClientInformation(row)
  return clientSecret === undefined
    ? info
    : { ...info, client_secret: clientSecret, client_secret_expires_at: 0 }
}

/** The registered-clients store handed to the SDK's mcpAuthRouter. */
export const oauthClientsStore: OAuthClientsStore = {
  async getClient(clientId: string): Promise<OAuthClientInformation | undefined> {
    const row = await getClientByClientId(clientId)
    return row === undefined ? undefined : toClientInformation(row)
  },
}

/**
 * CUSTOM token-endpoint client authentication. The SDK's
 * default authenticateClient does a PLAINTEXT compare against the secret the
 * clients store returns — impossible here BY DESIGN: getClient never returns
 * secret material, only the SHA-256 hash is at rest. So the token route calls
 * this instead: hash the presented secret and compare against the stored hash
 * fetched through the internal db row (the hash never leaves db/core).
 *
 * Per the registered method: 'none' clients carry no secret —
 * they authenticate by PKCE alone (the caller enforces that the code grant
 * always has a verifier); confidential clients must present the exact secret
 * (timing-safe compare over the hashes) THROUGH THE REGISTERED CHANNEL — a
 * client registered as client_secret_basic cannot authenticate via
 * client_secret_post and vice versa (RFC 7591 §2 / RFC 8414: the advertised
 * token_endpoint_auth_method is binding). Returns the secret-free client
 * information on success, undefined on ANY failure — unknown client, missing
 * secret, wrong secret, wrong channel — so the route's uniform invalid_client
 * is no oracle.
 */
export async function authenticateClientCredentials(
  clientId: string,
  clientSecret: string | undefined,
  presentedMethod?: TokenEndpointAuthMethod,
): Promise<OAuthClientInformation | undefined> {
  const row = await getClientByClientId(clientId)
  if (row === undefined) return undefined
  if (row.tokenEndpointAuthMethod === 'none') return toClientInformation(row)
  // Enforce the registered channel: the secret must arrive over the method the
  // client registered with (when the caller can attribute the channel).
  if (presentedMethod !== undefined && presentedMethod !== row.tokenEndpointAuthMethod) {
    return undefined
  }
  if (clientSecret === undefined || row.clientSecretHash === null) return undefined
  const presented = Buffer.from(hashClientSecret(clientSecret))
  const stored = Buffer.from(row.clientSecretHash)
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return undefined
  return toClientInformation(row)
}

// --- OAuth AS: grant-scoped consent management. "The apps I
// authorized" is derived from the CALLER'S oauth_tokens (RLS-scoped in db), not
// the global oauth_clients table — so a user can list/revoke only their OWN
// grants. The routes stay thin (hard rule 5); the consent shaping lives here. ---

/** One authorized client surfaced to its owner — name + redirect host, never a secret. */
export interface AuthorizedClientView {
  clientId: string
  clientName: string
  /**
   * The registered redirect hosts (RFC 7591 redirect_uris reduced to hostnames).
   * Surfaced so the consent screen shows the redirect host,
   * not just the name, so a look-alike client name cannot phish the user.
   */
  redirectHosts: string[]
  authorizedAt: Date
}

/** Reduce a registered redirect_uri to its host; drop unparseable entries (defensive). */
function redirectHosts(redirectUris: string[]): string[] {
  const hosts = new Set<string>()
  for (const uri of redirectUris) {
    try {
      hosts.add(new URL(uri).host)
    } catch {
      // A malformed stored URI never reaches the consent screen as a raw value.
    }
  }
  return [...hosts]
}

/** Map a db AuthorizedClient to the consent view shape — host-reduced, secret-free. */
function toAuthorizedClientView(client: AuthorizedClient): AuthorizedClientView {
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectHosts: redirectHosts(client.redirectUris),
    authorizedAt: client.authorizedAt,
  }
}

/** List the clients the caller has authorized (grant-scoped consent — A3). */
export async function listAuthorizedClients(userId: string): Promise<AuthorizedClientView[]> {
  const clients = await listClientsAuthorizedByUser(userId)
  return clients.map(toAuthorizedClientView)
}

/**
 * Revoke the caller's grant for one client: kills the caller's live tokens for
 * it (the client can no longer exchange/refresh for THIS user) without touching
 * the global client row or any other user's grant. Returns true when a live
 * grant was closed, false when none matched (unknown client, not-authorized, or
 * already revoked) so the route maps both to an idempotent outcome.
 */
export async function revokeAuthorizedClient(userId: string, clientId: string): Promise<boolean> {
  const revoked = await revokeClientForUser(userId, clientId)
  return revoked > 0
}

/**
 * Best-effort last_used_at stamp on a client after a successful token exchange
 * (the 30-day-idle GC signal). oauth_clients is the global system
 * table, so this delegates to the admin-path db wrapper. The token route invokes
 * it fire-and-forget AFTER responding; it must never block the exchange and its
 * rejection is the caller's to catch + log redacted (hard rule 6).
 */
export async function touchClientLastUsed(clientId: string): Promise<void> {
  await updateLastUsedAt(clientId)
}
