// SPDX-License-Identifier: Apache-2.0
// OAuth resource-server verification. The apps->core->db
// layer: the Bearer-JWT middleware calls verifyAccessToken() and stays thin; the
// signature/claim checks live here, the revocation check goes through the narrow
// packages/db oauth-token wrapper.
//
// "Strict resource server" means: RS256 only, signature against the
// LOCAL JWKS (the env key array — no upstream IdP, no proxying), iss + aud + exp
// + nbf all checked, and aud bound EXACTLY to the BASE_URL-derived resource id
// (RFC 8707). A valid signature is necessary but not sufficient: a token that
// was revoked (or whose grant expired) is rejected via the DB resolver, so a
// stolen-then-revoked token cannot outlive its revocation.
//
// Two-stage check, fail-closed at each:
//   1. JWT verify (jose): signature + RS256 + iss + aud + exp/nbf + kid select.
//   2. Revocation: the token hash must still resolve in oauth_tokens
//      (revoked_at IS NULL AND expires_at > now()), via auth_resolve_oauth_token.
//
// Never log the token, its hash, or any claim values (hard rule 6).
import { createHash, randomUUID } from 'node:crypto'
import { type ResolvedOauthToken, resolveOauthToken } from '@3ngram/db'
import { createLocalJWKSet, importJWK, type JSONWebKeySet, jwtVerify, SignJWT } from 'jose'

const RS256 = 'RS256' as const

/**
 * A private RS256 signing key in JWK form. Structurally a superset of a JWK
 * (jose validates the crypto fields at use), pinned to the fields the RS reads.
 * Defined HERE (not imported from config) so core stays decoupled from the env
 * layer — the transport reads OAUTH_JWKS and passes the values down.
 */
export interface OAuthJwk {
  kty: 'RSA'
  kid: string
  alg: 'RS256'
  n: string
  e: string
  d?: string
  [field: string]: unknown
}

/**
 * The resolved resource-server parameters verifyAccessToken needs. The transport
 * derives these from BASE_URL/OAUTH_JWKS (packages/config loadOAuthConfig) and
 * passes them in, so core never reaches into env (layering: apps -> core).
 */
export interface OAuthVerifyConfig {
  issuer: string
  resource: string
  keys: OAuthJwk[]
}

/** The public JWK fields — everything in an RSA public key, never the private set. */
const PUBLIC_JWK_FIELDS = ['kty', 'kid', 'alg', 'use', 'n', 'e'] as const

/**
 * A verified access token: the owning identity plus the grant metadata the
 * resolver returns. `userId` is bound into the request context by the caller;
 * `scope` feeds per-tool scope mapping (two scopes today).
 */
export interface VerifiedAccessToken {
  userId: string
  clientId: string
  scope: string
  expiresAt: Date
}

/**
 * The two OAuth scopes 3ngram issues ("start with two
 * `memory:read`, `memory:write`; resist scope proliferation"). `as const` so the
 * literal union is the single source of truth for both the issuer and the RS.
 */
export const MEMORY_READ_SCOPE = 'memory:read' as const
export const MEMORY_WRITE_SCOPE = 'memory:write' as const
export type MemoryScope = typeof MEMORY_READ_SCOPE | typeof MEMORY_WRITE_SCOPE

/**
 * Parse the OAuth `scope` claim (RFC 6749 §3.3: a space-delimited, case-sensitive
 * string) into a deduplicated set of granted scopes. FAIL-CLOSED by construction:
 * a missing/empty/whitespace-only claim yields an EMPTY set, so a token with no
 * scope grants nothing. Unknown tokens in the string are ignored (forward-compat),
 * not an error — enforcement asks "is scope X present", never "are all known".
 */
export function parseScopes(scope: string | undefined): ReadonlySet<string> {
  if (scope === undefined) return new Set()
  return new Set(scope.split(/\s+/).filter((s) => s.length > 0))
}

/** Why a verify failed — maps to the RFC 6750 `error` token on the 401. */
export type VerifyFailure = 'invalid_token'

/** A verify outcome: the resolved grant, or a uniform invalid_token failure. */
export type VerifyResult =
  | { ok: true; token: VerifiedAccessToken }
  | { ok: false; reason: VerifyFailure }

const failure: VerifyResult = { ok: false, reason: 'invalid_token' }

/**
 * Build the rotated key array: the freshly generated key goes to the FRONT
 * (becomes the current signing key), the existing keys keep their order behind
 * it (old keys stay valid for verification until their tokens expire). Pure + extractable so rotation logic is unit-tested independently
 * of jose's keygen ("rotation untested is rotation broken").
 */
export function rotateKeyArray(newKey: OAuthJwk, existing: OAuthJwk[]): OAuthJwk[] {
  return [newKey, ...existing]
}

/** sha256(token) hex — the only form of the token the DB ever sees (api_keys pattern). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Normalize an issuer for comparison: collapse a single trailing slash so the
 * trailing-slash variants compare equal (the SDK mints `iss` via
 * `new URL().href`, which keeps a trailing slash; a strict string compare would
 * otherwise reject an equivalent issuer). Applied to BOTH sides before compare.
 */
function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '')
}

type PublicJwk = JSONWebKeySet['keys'][number]

/**
 * Project a private RS256 JWK to its PUBLIC view: an ALLOWLIST copy of the public
 * fields only. Deriving by allowlist (not by deleting `d`/`p`/...) is fail-safe:
 * a private member that is not on the allowlist can never leak, even if the JWK
 * carries unexpected fields (never expose private material).
 * `use`/`alg` are pinned so verifiers and the JWKS endpoint see a complete key.
 */
function toPublicJwk(key: OAuthJwk): PublicJwk {
  const result: Record<string, unknown> = {}
  for (const field of PUBLIC_JWK_FIELDS) {
    const value = key[field]
    if (value !== undefined) result[field] = value
  }
  result.use = 'sig'
  result.alg = RS256
  return result as PublicJwk
}

/**
 * Derive the PUBLIC JWK set the /.well-known/jwks.json endpoint serves. Never
 * includes `d`/`p`/`q`/... — verification material only.
 */
export function derivePublicJwks(keys: OAuthJwk[]): JSONWebKeySet {
  return { keys: keys.map(toPublicJwk) }
}

/**
 * Crypto-level boot gate (fail-fast): import EVERY private
 * signing JWK as an RS256 key so a key that is structurally well-formed but
 * cryptographically unusable (e.g. n/e/d that are not valid base64url RSA
 * parameters) fails at config load, NOT at the first token verify — where it
 * would surface as a generic 401/503 with no operator signal. The env schema
 * (packages/config) validates JWK SHAPE; this validates KEY MATERIAL, the gap
 * shape validation cannot catch. Lives here (not in packages/config) because
 * jose belongs to core; the transport invokes it eagerly at boot.
 *
 * Throws naming the offending `kid` on the first unusable key. NEVER includes
 * any key material — n/e/d or the raw error — in the message (hard rule 6); the
 * underlying jose error is intentionally discarded so private fields cannot leak
 * into logs or stack traces surfaced to operators.
 */
export async function assertSigningKeysUsable(keys: OAuthJwk[]): Promise<void> {
  for (const key of keys) {
    try {
      await importJWK({ ...key, alg: RS256 }, RS256)
    } catch {
      throw new Error(
        `OAUTH_JWKS key kid=${key.kid} is not a usable RS256 private key (invalid key material)`,
      )
    }
  }
}

/** Parameters for minting one RS256 access token (OAuth AS). */
export interface SignAccessTokenParams {
  userId: string
  scope: string
  expiresAt: Date
}

/**
 * Mint an RS256 access JWT (OAuth AS). The FIRST key in
 * the array signs (the rotation contract: rotateKeyArray puts the new key at
 * the front; older keys verify only), its kid stamped in the header so the RS
 * selects it. Claims mirror exactly what verifyAccessToken checks: iss is the
 * config issuer string VERBATIM (the trailing-slash-normalized
 * loadOAuthConfig().issuer, never re-derived), aud the RFC 8707 resource,
 * sub the user, scope the space-delimited grant, iat/exp the ≤1h window
 * (short-lived access tokens). Key USABILITY is asserted at boot by
 * assertSigningKeysUsable, so an import failure here is a programming bug,
 * not an operator signal.
 *
 * jti (RFC 7519 §4.1.7) makes every mint UNIQUE: RS256 signing is
 * deterministic, so two tokens for the same subject/scope minted within the
 * same second would otherwise be byte-identical — colliding on the
 * oauth_tokens token_hash unique index (found by the conformance suite).
 */
export async function signAccessToken(
  params: SignAccessTokenParams,
  config: OAuthVerifyConfig,
): Promise<string> {
  const key = config.keys[0]
  if (key === undefined) throw new Error('OAUTH_JWKS has no signing key')
  const privateKey = await importJWK({ ...key, alg: RS256 }, RS256)
  return new SignJWT({ scope: params.scope })
    .setProtectedHeader({ alg: RS256, kid: key.kid })
    .setJti(randomUUID())
    .setIssuer(config.issuer)
    .setAudience(config.resource)
    .setSubject(params.userId)
    .setIssuedAt()
    .setExpirationTime(params.expiresAt)
    .sign(privateKey)
}

/**
 * Verify a presented Bearer access token against the local JWKS.
 * Returns a uniform invalid_token failure for ANY rejection — bad signature,
 * wrong alg, unknown kid, wrong iss, wrong aud, expired, not-yet-valid,
 * malformed, or revoked — so the 401 never becomes an oracle. A revoked token
 * passes signature verification but fails the DB resolver check.
 *
 * The JWKS set + issuer/resource come from the already-validated OAuthConfig;
 * the caller owns the env boundary (loadOAuthConfig) so core stays config-free.
 */
export async function verifyAccessToken(
  token: string,
  config: OAuthVerifyConfig,
): Promise<VerifyResult> {
  // createLocalJWKSet requires PUBLIC keys (it rejects a set with private
  // members), so build it from the public projection — verification needs n/e
  // only, never the signing material.
  const jwks = createLocalJWKSet(derivePublicJwks(config.keys))
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    const verified = await jwtVerify(token, jwks, {
      algorithms: [RS256],
      // jose normalizes neither side; compare issuer ourselves (below) so the
      // trailing-slash variants pass. aud is an exact RFC 8707 match here.
      audience: config.resource,
    })
    payload = verified.payload
  } catch {
    return failure
  }
  // Issuer: normalize both sides (trailing-slash normalization) before compare.
  if (
    typeof payload.iss !== 'string' ||
    normalizeIssuer(payload.iss) !== normalizeIssuer(config.issuer)
  ) {
    return failure
  }
  // Signature + claims are good; now the grant must still be live (not revoked,
  // not grant-expired). The resolver filters revoked_at IS NULL AND not expired.
  const resolved: ResolvedOauthToken | undefined = await resolveOauthToken(hashToken(token))
  if (resolved === undefined || resolved.kind !== 'access') return failure
  return {
    ok: true,
    token: {
      userId: resolved.userId,
      clientId: resolved.clientId,
      scope: resolved.scope,
      expiresAt: resolved.expiresAt,
    },
  }
}
