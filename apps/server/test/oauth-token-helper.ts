// SPDX-License-Identifier: Apache-2.0
// RS256 access-token minting helper for MCP integration tests. login.int.test.ts
// mints SESSIONS (the C2 password flow); the MCP transport is guarded by the C4
// Bearer-JWT middleware, which needs a real RS256 ACCESS token that (a) verifies
// against the test JWKS and (b) resolves in oauth_tokens (the revocation check). This helper mints one for a given user: it signs a kid-stamped
// RS256 JWT with the test private key and inserts the matching oauth_tokens row
// (owner connection, so RLS is bypassed for setup only).
//
// The keypair + issuer/resource mirror the env the test app boots with
// (BASE_URL + OAUTH_JWKS); the aud is the RFC 8707 resource id (BASE_URL+/mcp),
// the exact value the strict RS requires.
import { createHash, randomUUID } from 'node:crypto'
import { importJWK, SignJWT } from 'jose'

/**
 * Minimal structural view of the owner connection this helper needs: a single
 * parameterized `query`. Typed structurally (not via the `pg` Pool type) so this
 * test helper imports no Postgres driver — DB construction/import stays confined
 * to packages/db (db-access discipline, hard rule 3 / S3 graduation).
 */
interface QueryableOwner {
  query(text: string, values?: unknown[]): Promise<unknown>
}

/** The test deployment base URL the app boots with (issuer + resource derive from it). */
export const TEST_BASE_URL = 'https://api.3ngram.test'
/** Normalized issuer (trailing slash, matching the S4 SDK new URL().href). */
export const TEST_ISSUER = new URL(TEST_BASE_URL).href
/** RFC 8707 resource id = the MCP endpoint URL; the access-token aud. */
export const TEST_RESOURCE = `${TEST_ISSUER.replace(/\/$/, '')}/mcp`

/** A throwaway RS256 private JWK (kid k1). Public view is served at /jwks.json. */
export const TEST_PRIVATE_JWK = {
  kty: 'RSA',
  n: '2sUh3fwAEYYFKCqRi3iIgq0X2C6PnaoWqu-HmzwbhGQvKqR62LAxmt3k_pQn-KdnMJCG0yWVWq-9gde-yr2zsp4Zitt0XT_JsCnCRTyR_6C1aiFbl6FzCVR6gbxDeEz5CHDLlbsGbbTY8-k4oQc3Qm3OGOuWUWNhwXGE7-RjesEJUoaYftfxduHbkwAG_A6ENPooUJTbeze_EupWB9nSQYMdvIvmuezwbCTIbkYF1DRRoOEj_d57lY_o_OQ9l9r9TdvoUXJlAw0etZ_karQRt2fASJxFmKk3y_57GCmASh3WRB-9dw0FrdhCpZIBbUvWDSqJxAIv9j4iCOTJ6t2YRQ',
  e: 'AQAB',
  d: 'O0eoniy_XgA5XIFwb-EI6JP7vpYbT2c7_jSqw7s9X5oAF-d67EWOI39WIk_GJwBBm2zGQ-fOuUSertTlu608yL1DgZdmyC_VOJmQLU-05hZHoksItSVH9TLBgW8gvzPoVUuvNtL3cnnLQgij0iqQ5Dy52JHZ6RLrdc4Lbi-ubx_oOT9qBrRZFrXcUuPGVuwPKCFX71SU0R7G54uSILdjnT64WIhJYz7gxtIbuJJcfn9AZLptuHWlffY6iVLVhQf0MTKikTbaPR9nDpR4Ss9NUV8FxN6EOHt7fVcwH5lrCP4FjuyBs21Cl4O4qxJq_fhoaWwAN1cbmgvOZaSjkCVvHw',
  p: '-RaEcpWLPp6eDRq3k9iO2oRH4B3IGTnNMqjKbLjOTRT-PSSystx_ciSadPhVzylOMgugGgl0SGVtqWnJlg9guBGycwJqFCPM2Pkj5DCJZdbzZdMgWOATzffBuziGYH1TfkietL635HSpud9ReIOBUB-hxDZp9JTKJvpc-Gr8L5M',
  q: '4Nc9uy0ggNYLq-tPpaXwoxPysoS3aDodA39YRiQsM_CcLcrdC6buy0GNY4RhsURxiARxw7Onj4_UKoUUXxi01oN4qxah6kbA1evyjLfKVHNfrA9nItSC0VBwmIlQ2FX0To4uoexStSrC-gMe8DIWQeN3WTFuTDdGNGVKXmapD8c',
  dp: 'I7M_fnDCiVIQkw4-O3lxWA5Xgt6h3EO1jko04QpHvzKAEeFdn1cNCR4H6TXijpN7-p5B7xllyi6HXh2kX9aKZTdcHTG-ZG6RIJPsufre5nK9Zd2xqCtNi1q0MJI0aEXuHo5n-L3Q-3RhExvXwG8QrJwsAkROQVjF9HozswMaa_M',
  dq: '2h61WlIrCBGefQfo2pAi5HHDrn-l1c0avHvbzR_mafTv7lSxIE6vtis_2N1iULBPW17EZtBwq4sijqVP3_l95eThOUjZhwdgp6cgRHdAJ7FNjQPcUCPNTPY2ZSRBc73fJh41CwzSJ8L2J8jDSM2uXfknnTWhBPtSdh4ViYMaW50',
  qi: 'JyjN2QLf6OM_FG8sHWVnaVtzzZCfLQ1F2oaYTr3oKnvZP1YGEC1BkQ_jq3U6rzB8vMh7J2hITMUarYoGqf7ZojjoVIR_5nPSjJ7AgIU8p1eVK_qiAN5u5nJpEN1dEzfaJJbKHb3z3Ea3Jyg4obVMX8V9lZTZS77sK58ZZD9_2Is',
  alg: 'RS256',
  kid: 'k1',
} as const

/** The OAUTH_JWKS array (one key) the test app boots with. */
export const TEST_JWKS = JSON.stringify([TEST_PRIVATE_JWK])

/** sha256(token) hex — the form stored in oauth_tokens (matches core hashToken). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A shared client row every minted token references (created once per suite). */
export async function ensureTestClient(owner: QueryableOwner): Promise<string> {
  const clientId = `cl_test_${randomUUID()}`
  await owner.query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, 'mcp-int-test', $2, 'none')`,
    [clientId, JSON.stringify(['https://example.test/cb'])],
  )
  return clientId
}

/** Default scope grant for a minted token: both scopes (full read+write). */
export const DEFAULT_TEST_SCOPE = 'memory:read memory:write'

/**
 * Mint a valid RS256 access token for `userId` and persist its oauth_tokens row.
 * Returns the raw JWT (the Bearer value). The token verifies (signature + iss +
 * aud) AND resolves (the row exists, not revoked, not expired). The JWT `scope`
 * claim AND the stored oauth_tokens.scope carry `scope` (default: both scopes) so
 * per-tool scope enforcement reads a real grant — pass a narrower
 * value (e.g. `memory:read`) to exercise the read-only path.
 */
export async function mintAccessToken(
  owner: QueryableOwner,
  clientId: string,
  userId: string,
  scope: string = DEFAULT_TEST_SCOPE,
): Promise<string> {
  const key = await importJWK(TEST_PRIVATE_JWK, 'RS256')
  const expiresAt = new Date(Date.now() + 3_600_000)
  const token = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', kid: TEST_PRIVATE_JWK.kid })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_RESOURCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key)
  await owner.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at)
     VALUES ($1, 'access', $2, $3, $4, $5)`,
    [hashToken(token), clientId, userId, scope, expiresAt.toISOString()],
  )
  return token
}
