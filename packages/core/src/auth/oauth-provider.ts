// SPDX-License-Identifier: Apache-2.0
// OAuth authorization-server provider: the
// authorization-code + PKCE policy behind /oauth/authorize + /oauth/token.
// Structurally assignable to the legacy auth package's `OAuthServerProvider`
// while DCR remains a compatibility fallback (the types are mirrored locally
// so core has no transport SDK dependency; apps/server pins assignability).
//
// Grant mechanics:
// - authorize: mint a 32-byte CSPRNG code, store its SHA-256 hash (the code
//   value never touches the DB — token_hash pattern) PKCE-bound with a 60s TTL,
//   302 back to the byte-exact registered redirect_uri with state preserved.
// - exchangeAuthorizationCode: CONSUME-THEN-VERIFY — the atomic
//   auth_consume_oauth_code resolver burns the code first (single-use under
//   concurrency), THEN client binding, PKCE S256, and redirect_uri are checked.
//   A failed exchange can never be retried; every failure is the uniform
//   invalid_grant (no oracle).
// - exchangeRefreshToken: one-time rotation — the predecessor is revoked in
//   the same transaction that inserts the successor pair (rotated_from chain);
//   reuse of a rotated/revoked refresh token fails closed.
//
// Failures are thrown as OAuthGrantError with an RFC 6749 error code; the
// transport maps them to the SDK's typed errors (a generic Error
// becomes the opaque 500). Never log or embed token/code/secret material in
// errors (hard rule 6).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  consumeOauthCode,
  insertOauthCode,
  insertOauthTokenPair,
  type NewOauthToken,
  resolveOauthToken,
  rotateOauthRefreshToken,
} from '@3ngram/db'
import { type LimitsResolver, resolveResourceLimits } from '../budget/index.js'
import {
  MEMORY_READ_SCOPE,
  MEMORY_WRITE_SCOPE,
  type OAuthVerifyConfig,
  parseScopes,
  signAccessToken,
  verifyAccessToken,
} from './oauth.js'
import {
  type OAuthClientInformation,
  type OAuthClientsStore,
  oauthClientsStore,
} from './oauth-clients.js'

/** Access tokens live ≤1h; refresh tokens 30 days; codes 60s. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600
const CODE_TTL_MS = 60_000
const TOKEN_BYTES = 32

/** An omitted scope grants the full v1 pair (two scopes only). */
const DEFAULT_SCOPE = `${MEMORY_READ_SCOPE} ${MEMORY_WRITE_SCOPE}`

/** RFC 6749 error codes the provider can fail with; the route maps to SDK errors. */
export type OAuthGrantFailure =
  | 'invalid_grant'
  | 'invalid_client'
  | 'invalid_target'
  | 'invalid_token'

/** A typed grant failure — the message is the code, never request material. */
export class OAuthGrantError extends Error {
  readonly code: OAuthGrantFailure
  constructor(code: OAuthGrantFailure) {
    super(code)
    this.name = 'OAuthGrantError'
    this.code = code
  }
}

/** RFC 6749 §5.1 token response — structural mirror of the SDK `OAuthTokens`. */
export interface OAuthTokenResponse {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  scope: string
  refresh_token: string
}

/**
 * Parameters for issuing a code. Mirrors the SDK `AuthorizationParams` PLUS
 * the authenticated userId — the SDK leaves user interaction to the provider;
 * here the consent transport authenticates first and passes the subject in
 * (a strict subtype, so the SDK-shape compile pin still holds).
 */
export interface AuthorizeCodeGrant {
  userId: string
  codeChallenge: string
  redirectUri: string
  /**
   * RFC 6749 §4.1.3: did the client SUPPLY redirect_uri at /authorize (vs. it
   * being RESOLVED from a single registered URI)? The transport must pass the
   * presence of the request param — when false, redirectUri is the resolved
   * value and the token endpoint MAY accept an omitted redirect_uri.
   */
  redirectUriSupplied: boolean
  scopes?: string[]
  state?: string
}

/** The one Response capability authorize uses — express.Response satisfies it. */
export interface RedirectCapable {
  redirect(status: number, url: string): void
}

/** RFC 9207 requires an HTTPS issuer in authorization responses. */
export function supportsAuthorizationResponseIssuer(issuer: string): boolean {
  return new URL(issuer).protocol === 'https:'
}

/**
 * Build an OAuth authorization response without drifting the issuer parameter
 * from authorization-server metadata. HTTP loopback development remains
 * available, but cannot claim RFC 9207 support.
 */
export function buildAuthorizationResponseUrl(
  redirectUri: string,
  issuer: string,
  params: { code?: string; error?: string; state?: string },
): string {
  const url = new URL(redirectUri)
  if (params.code !== undefined) url.searchParams.set('code', params.code)
  if (params.error !== undefined) url.searchParams.set('error', params.error)
  if (params.state !== undefined) url.searchParams.set('state', params.state)
  if (supportsAuthorizationResponseIssuer(issuer)) url.searchParams.set('iss', issuer)
  return url.href
}

/** Structural mirror of the SDK `AuthInfo` the bearer middleware consumes. */
export interface VerifiedTokenInfo {
  token: string
  clientId: string
  scopes: string[]
  expiresAt?: number
}

/** Structural mirror of the legacy auth package's provider (compile-pinned in apps/server). */
export interface OAuthServerProviderShape {
  clientsStore: OAuthClientsStore
  /** PKCE is verified INSIDE exchangeAuthorizationCode (consume-then-verify). */
  skipLocalPkceValidation: boolean
  authorize(
    client: OAuthClientInformation,
    params: AuthorizeCodeGrant,
    res: RedirectCapable,
  ): Promise<void>
  challengeForAuthorizationCode(client: OAuthClientInformation, code: string): Promise<string>
  exchangeAuthorizationCode(
    client: OAuthClientInformation,
    code: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokenResponse>
  exchangeRefreshToken(
    client: OAuthClientInformation,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokenResponse>
  verifyAccessToken(token: string): Promise<VerifiedTokenInfo>
}

/** sha256(value) hex — the only at-rest form of codes and tokens (hard rule 6). */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** RFC 7636 §4.6: S256 — base64url(sha256(verifier)) must equal the stored challenge. */
function pkceChallengeMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const stored = Buffer.from(challenge)
  return computed.length === stored.length && timingSafeEqual(computed, stored)
}

/**
 * RFC 8707: a presented resource indicator must name OUR resource exactly
 * (URL-normalized compare) — tokens are only ever minted with aud = the
 * configured resource, so a mismatched ask is invalid_target, never a token.
 */
function assertResourceMatches(resource: URL | undefined, expected: string): void {
  if (resource === undefined) return
  if (resource.href !== new URL(expected).href) throw new OAuthGrantError('invalid_target')
}

/**
 * Resolve the effective redirect URI for an authorization request: a presented
 * value must BYTE-EXACTLY match a registered one (no
 * wildcards, no path-prefix or query relaxation, no loopback port games); an
 * omitted value is only valid when exactly one URI is registered. undefined =
 * reject (the transport 400s WITHOUT redirecting — never to an unvetted URI).
 */
export function resolveRegisteredRedirectUri(
  client: Pick<OAuthClientInformation, 'redirect_uris'>,
  requested: string | undefined,
): string | undefined {
  if (requested !== undefined) {
    return client.redirect_uris.includes(requested) ? requested : undefined
  }
  return client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined
}

interface MintedTokenPair {
  response: OAuthTokenResponse
  accessRow: NewOauthToken
  refreshRow: NewOauthToken
}

/** Mint an access JWT + opaque refresh token; rows carry hashes only. */
async function buildTokenPair(
  userId: string,
  clientId: string,
  scope: string,
  config: OAuthVerifyConfig,
): Promise<MintedTokenPair> {
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000)
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000)
  const accessToken = await signAccessToken({ userId, scope, expiresAt: accessExpiresAt }, config)
  const refreshToken = randomBytes(TOKEN_BYTES).toString('base64url')
  return {
    response: {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope,
      refresh_token: refreshToken,
    },
    accessRow: {
      tokenHash: sha256Hex(accessToken),
      kind: 'access',
      clientId,
      scope,
      expiresAt: accessExpiresAt,
    },
    refreshRow: {
      tokenHash: sha256Hex(refreshToken),
      kind: 'refresh',
      clientId,
      scope,
      expiresAt: refreshExpiresAt,
    },
  }
}

/**
 * Build the provider over a resolved OAuth config (the transport owns the env
 * boundary via loadOAuthConfig, core stays config-free — verifyAccessToken
 * precedent). Stateless: safe to construct per request.
 */
export function createOAuthServerProvider(
  config: OAuthVerifyConfig,
  resolveLimits?: LimitsResolver,
): OAuthServerProviderShape {
  return {
    clientsStore: oauthClientsStore,
    skipLocalPkceValidation: true,

    async authorize(client, params, res) {
      const code = randomBytes(TOKEN_BYTES).toString('base64url')
      const scope =
        params.scopes !== undefined && params.scopes.length > 0
          ? params.scopes.join(' ')
          : DEFAULT_SCOPE
      await insertOauthCode(params.userId, {
        codeHash: sha256Hex(code),
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        redirectUriSupplied: params.redirectUriSupplied,
        codeChallenge: params.codeChallenge,
        scope,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      })
      res.redirect(
        302,
        buildAuthorizationResponseUrl(params.redirectUri, config.issuer, {
          code,
          ...(params.state === undefined ? {} : { state: params.state }),
        }),
      )
    },

    async challengeForAuthorizationCode(): Promise<string> {
      // skipLocalPkceValidation: true — PKCE is verified inside
      // exchangeAuthorizationCode AFTER the atomic consume, so a non-consuming
      // challenge lookup (which RLS rightly makes impossible pre-tenant) is
      // never needed. Reaching this is a programming bug.
      throw new Error('PKCE is verified in exchangeAuthorizationCode (consume-then-verify)')
    },

    async exchangeAuthorizationCode(client, code, codeVerifier, redirectUri, resource) {
      assertResourceMatches(resource, config.resource)
      const consumed = await consumeOauthCode(sha256Hex(code))
      if (consumed === undefined) throw new OAuthGrantError('invalid_grant') // unknown/expired/replayed
      // The code is burned; every check below fails closed with no retry.
      if (consumed.clientId !== client.client_id) throw new OAuthGrantError('invalid_grant')
      if (
        codeVerifier === undefined ||
        !pkceChallengeMatches(codeVerifier, consumed.codeChallenge)
      ) {
        throw new OAuthGrantError('invalid_grant')
      }
      // RFC 6749 §4.1.3: redirect_uri is REQUIRED at token ONLY IF it was
      // supplied at /authorize. The single-registered-URI flow
      // (resolveRegisteredRedirectUri) lets a client OMIT redirect_uri at
      // /authorize, in which case consumed.redirectUri is the RESOLVED value —
      // consumed.redirectUriSupplied distinguishes the two:
      //  - supplied-at-authorize  ⇒ the token request MUST present the IDENTICAL
      //    redirect_uri; omitting it (or differing) is invalid_grant.
      //  - omitted-at-authorize   ⇒ the token request MAY omit it; if present it
      //    must still match the resolved value (no smuggling a different URI).
      if (consumed.redirectUriSupplied && redirectUri === undefined) {
        throw new OAuthGrantError('invalid_grant')
      }
      if (redirectUri !== undefined && redirectUri !== consumed.redirectUri) {
        throw new OAuthGrantError('invalid_grant')
      }
      const pair = await buildTokenPair(consumed.userId, client.client_id, consumed.scope, config)
      // insertOauthTokenPair serializes against account deletion (account-lifecycle
      // lock) and returns false when the user is a deletion tombstone — refuse to
      // mint on a deleted account (resurrection race). The code is
      // already burned, so this fails closed as the uniform invalid_grant.
      const { maxActiveMcpClients } = await resolveResourceLimits(resolveLimits, consumed.userId)
      const issued = await insertOauthTokenPair(
        consumed.userId,
        pair.accessRow,
        pair.refreshRow,
        maxActiveMcpClients,
      )
      if (!issued) throw new OAuthGrantError('invalid_grant')
      return pair.response
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      assertResourceMatches(resource, config.resource)
      const resolved = await resolveOauthToken(sha256Hex(refreshToken))
      // The resolver filters revoked + expired, so a rotated (= revoked)
      // predecessor never resolves — reuse fails closed right here.
      if (resolved === undefined || resolved.kind !== 'refresh') {
        throw new OAuthGrantError('invalid_grant')
      }
      if (resolved.clientId !== client.client_id) throw new OAuthGrantError('invalid_grant')
      // RFC 6749 §6: a requested scope MUST be a subset of the original grant —
      // it can only narrow, never broaden. Intersect the ask with the granted
      // scope (a requested scope outside the grant is invalid_grant, no
      // escalation); an omitted scope carries the full grant over unchanged.
      const grantedScopes = parseScopes(resolved.scope)
      let scope = resolved.scope
      if (scopes !== undefined) {
        const requested = scopes.filter((s) => s.length > 0)
        if (requested.some((s) => !grantedScopes.has(s))) {
          throw new OAuthGrantError('invalid_grant')
        }
        scope = requested.join(' ')
      }
      const pair = await buildTokenPair(resolved.userId, client.client_id, scope, config)
      const { maxActiveMcpClients } = await resolveResourceLimits(resolveLimits, resolved.userId)
      const rotated = await rotateOauthRefreshToken(
        resolved.userId,
        sha256Hex(refreshToken),
        pair.accessRow,
        pair.refreshRow,
        maxActiveMcpClients,
      )
      // A concurrent rotation won the revoke UPDATE: this exchange loses, atomically.
      if (!rotated) throw new OAuthGrantError('invalid_grant')
      return pair.response
    },

    async verifyAccessToken(token) {
      const result = await verifyAccessToken(token, config)
      if (!result.ok) throw new OAuthGrantError('invalid_token')
      return {
        token,
        clientId: result.token.clientId,
        scopes: [...parseScopes(result.token.scope)],
        expiresAt: Math.floor(result.token.expiresAt.getTime() / 1000),
      }
    },
  }
}
