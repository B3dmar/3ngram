// SPDX-License-Identifier: Apache-2.0
// OAuth AS provider policy — isolated from Postgres by
// mocking the narrow db helpers (the established core-test seam, cf.
// oauth.test.ts / oauth-clients.test.ts). The mocks record EXACTLY what core
// asked the db layer to persist, so hash-at-rest, the 60s code TTL, the
// consume-then-verify ordering, and the rotation contract are all asserted
// against the same rows the real tables would hold.
import { createHash } from 'node:crypto'
import { clientIdMetadataDocumentSchema } from '@3ngram/schema'
import { exportJWK, generateKeyPair } from 'jose'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OAuthJwk, OAuthVerifyConfig } from '../src/auth/oauth.js'

const consumeOauthCode = vi.fn()
const insertOauthCode = vi.fn()
const insertOauthTokenPair = vi.fn()
const rotateOauthRefreshToken = vi.fn()
const resolveOauthToken = vi.fn()
const getClientByClientId = vi.fn()
const registerClient = vi.fn()
vi.mock('@3ngram/db', () => ({
  consumeOauthCode,
  insertOauthCode,
  insertOauthTokenPair,
  rotateOauthRefreshToken,
  resolveOauthToken,
  getClientByClientId,
  registerClient,
}))

const { createOAuthServerProvider, OAuthGrantError, resolveRegisteredRedirectUri } = await import(
  '../src/auth/oauth-provider.js'
)
const { authenticateClientCredentials, hashClientSecret } = await import(
  '../src/auth/oauth-clients.js'
)
const { verifyAccessToken } = await import('../src/auth/oauth.js')

const ISSUER = 'https://api.3ngram.test/'
const RESOURCE = 'https://api.3ngram.test/mcp'
const USER_ID = '11111111-1111-1111-1111-111111111111'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const s256Challenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url')

const CLIENT = {
  client_id: 'client-1',
  client_id_issued_at: 1765000000,
  client_name: 'Test Client',
  redirect_uris: ['https://client.example/cb'],
  token_endpoint_auth_method: 'none' as const,
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
}

const VERIFIER = 'a'.repeat(43)

let config: OAuthVerifyConfig

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = {
    ...(await exportJWK(privateKey)),
    ...(await exportJWK(publicKey)),
    kty: 'RSA',
    alg: 'RS256',
    kid: 'k1',
  } as OAuthJwk
  config = { issuer: ISSUER, resource: RESOURCE, keys: [jwk] }
})

beforeEach(() => {
  vi.clearAllMocks()
  // Default: issuance succeeds (user is live). The account-lifecycle guard
  // (insertOauthTokenPair -> boolean) is exercised explicitly where it matters.
  insertOauthTokenPair.mockResolvedValue(true)
})

function provider(resolveLimits?: Parameters<typeof createOAuthServerProvider>[1]) {
  return createOAuthServerProvider(config, resolveLimits)
}

describe('authorize', () => {
  function makeRedirectSpy() {
    return { redirect: vi.fn((_status: number, _url: string) => {}) }
  }

  it('stores a HASHED single-use code with a 60s TTL and redirects with code+state', async () => {
    insertOauthCode.mockResolvedValue(undefined)
    const res = makeRedirectSpy()
    const before = Date.now()
    await provider().authorize(
      CLIENT,
      {
        userId: USER_ID,
        codeChallenge: s256Challenge(VERIFIER),
        redirectUri: 'https://client.example/cb',
        redirectUriSupplied: true,
        scopes: ['memory:read'],
        state: 'xyz',
      },
      res,
    )
    expect(insertOauthCode).toHaveBeenCalledTimes(1)
    const [userId, row] = insertOauthCode.mock.calls[0] as [string, Record<string, unknown>]
    expect(userId).toBe(USER_ID)
    expect(row.clientId).toBe('client-1')
    expect(row.scope).toBe('memory:read')
    expect(row.redirectUriSupplied).toBe(true)
    expect(row.codeChallenge).toBe(s256Challenge(VERIFIER))
    // ≤60s TTL, bounded by the wall clock around the call.
    const after = Date.now()
    const expiresMs = (row.expiresAt as Date).getTime()
    expect(expiresMs).toBeGreaterThan(before)
    expect(expiresMs).toBeLessThanOrEqual(after + 60_000)
    const [status, location] = res.redirect.mock.calls[0] as [number, string]
    expect(status).toBe(302)
    const url = new URL(location)
    expect(url.origin + url.pathname).toBe('https://client.example/cb')
    expect(url.searchParams.get('state')).toBe('xyz')
    expect(url.searchParams.get('iss')).toBe(ISSUER)
    const code = url.searchParams.get('code') as string
    // The code value in the redirect is NEVER at rest — only its sha256 is.
    expect(row.codeHash).toBe(sha256(code))
    expect(row.codeHash).not.toBe(code)
  })

  it('defaults an omitted scope to the full two-scope grant', async () => {
    insertOauthCode.mockResolvedValue(undefined)
    await provider().authorize(
      CLIENT,
      {
        userId: USER_ID,
        codeChallenge: s256Challenge(VERIFIER),
        redirectUri: CLIENT.redirect_uris[0] as string,
        redirectUriSupplied: false,
      },
      makeRedirectSpy(),
    )
    const [, row] = insertOauthCode.mock.calls[0] as [string, Record<string, unknown>]
    expect(row.scope).toBe('memory:read memory:write')
    expect(row.redirectUriSupplied).toBe(false)
  })

  it('omits iss for an HTTP development issuer', async () => {
    insertOauthCode.mockResolvedValue(undefined)
    const res = makeRedirectSpy()
    const insecureConfig = {
      ...config,
      issuer: 'http://127.0.0.1:3000/',
      resource: 'http://127.0.0.1:3000/mcp',
    }
    await createOAuthServerProvider(insecureConfig).authorize(
      CLIENT,
      {
        userId: USER_ID,
        codeChallenge: s256Challenge(VERIFIER),
        redirectUri: CLIENT.redirect_uris[0] as string,
        redirectUriSupplied: false,
      },
      res,
    )
    const [, location] = res.redirect.mock.calls[0] as [number, string]
    expect(new URL(location).searchParams.has('iss')).toBe(false)
  })
})

describe('exchangeAuthorizationCode (consume-then-verify)', () => {
  // Default fixture: redirect_uri was OMITTED at /authorize (resolved from the
  // single registered URI), so omission at token is permitted (RFC 6749 §4.1.3).
  const consumed = {
    userId: USER_ID,
    clientId: 'client-1',
    redirectUri: 'https://client.example/cb',
    redirectUriSupplied: false,
    codeChallenge: s256Challenge(VERIFIER),
    scope: 'memory:read memory:write',
  }

  it('returns a bearer pair and stores BOTH tokens hashed', async () => {
    consumeOauthCode.mockResolvedValue(consumed)
    insertOauthTokenPair.mockResolvedValue(true)
    const tokens = await provider().exchangeAuthorizationCode(
      CLIENT,
      'the-code',
      VERIFIER,
      'https://client.example/cb',
    )
    expect(consumeOauthCode).toHaveBeenCalledExactlyOnceWith(sha256('the-code'))
    expect(tokens.token_type).toBe('bearer')
    expect(tokens.expires_in).toBe(3600)
    expect(tokens.scope).toBe('memory:read memory:write')
    const [userId, access, refresh] = insertOauthTokenPair.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(userId).toBe(USER_ID)
    expect(access.kind).toBe('access')
    expect(access.tokenHash).toBe(sha256(tokens.access_token))
    expect(refresh.kind).toBe('refresh')
    // CLIENT advertises refresh_token, so one must be issued (see the
    // suppression case below for a client that does not).
    if (tokens.refresh_token === undefined) throw new Error('expected a refresh_token')
    expect(refresh.tokenHash).toBe(sha256(tokens.refresh_token))
    // The minted access token verifies against the same config (iss/aud/sig).
    resolveOauthToken.mockResolvedValue({
      userId: USER_ID,
      clientId: 'client-1',
      kind: 'access',
      scope: tokens.scope,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const verified = await verifyAccessToken(tokens.access_token, config)
    expect(verified.ok).toBe(true)
  })

  // Issue #86: the token route rejects a refresh EXCHANGE from a client whose
  // advertised grants exclude refresh_token, so issuing one at the code
  // exchange handed out a credential that was inert on arrival — and nothing in
  // the response said so. Issuance now matches what the AS will honour.
  it('issues NO refresh token to a client that never advertised the grant', async () => {
    consumeOauthCode.mockResolvedValue(consumed)
    insertOauthTokenPair.mockResolvedValue(true)
    const codeOnlyClient = { ...CLIENT, grant_types: ['authorization_code'] }

    const tokens = await provider().exchangeAuthorizationCode(
      codeOnlyClient,
      'the-code',
      VERIFIER,
      'https://client.example/cb',
    )

    // The access token is unaffected — this narrows the response, not the grant.
    expect(tokens.access_token).toEqual(expect.any(String))
    expect(tokens.token_type).toBe('bearer')
    expect(tokens.refresh_token).toBeUndefined()
    // And no refresh row is persisted: a hash nobody holds can never be
    // presented or rotated, so writing it would be dead state.
    const [, access, refresh] = insertOauthTokenPair.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown> | undefined,
    ]
    expect(access.kind).toBe('access')
    expect(refresh).toBeUndefined()
  })

  it('validates and forwards the active-client cap on authorization-code issuance', async () => {
    consumeOauthCode.mockResolvedValue(consumed)
    const limits = vi.fn().mockResolvedValue({ maxActiveMcpClients: 2 })

    await provider(limits).exchangeAuthorizationCode(CLIENT, 'the-code', VERIFIER)

    expect(limits).toHaveBeenCalledExactlyOnceWith(USER_ID)
    expect(insertOauthTokenPair.mock.calls[0]?.[3]).toBe(2)
  })

  it('fails closed on an invalid injected active-client cap', async () => {
    consumeOauthCode.mockResolvedValue(consumed)
    const limits = vi.fn().mockResolvedValue({ maxActiveMcpClients: Number.NaN })

    await expect(
      provider(limits).exchangeAuthorizationCode(CLIENT, 'the-code', VERIFIER),
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(insertOauthTokenPair).not.toHaveBeenCalled()
  })

  it('rejects an unknown/expired/replayed code (resolver returns no row)', async () => {
    consumeOauthCode.mockResolvedValue(undefined)
    await expect(provider().exchangeAuthorizationCode(CLIENT, 'gone', VERIFIER)).rejects.toThrow(
      OAuthGrantError,
    )
    expect(insertOauthTokenPair).not.toHaveBeenCalled()
  })

  it('rejects a PKCE verifier mismatch AFTER consuming (the code is burned)', async () => {
    consumeOauthCode.mockResolvedValue(consumed)
    await expect(
      provider().exchangeAuthorizationCode(CLIENT, 'the-code', 'b'.repeat(43)),
    ).rejects.toThrow('invalid_grant')
    expect(consumeOauthCode).toHaveBeenCalledTimes(1)
    expect(insertOauthTokenPair).not.toHaveBeenCalled()
  })

  it('rejects a missing verifier (PKCE is mandatory, public clients included)', async () => {
    consumeOauthCode.mockResolvedValue(consumed)
    await expect(provider().exchangeAuthorizationCode(CLIENT, 'the-code')).rejects.toThrow(
      'invalid_grant',
    )
  })

  it('rejects a code bound to ANOTHER client', async () => {
    consumeOauthCode.mockResolvedValue({ ...consumed, clientId: 'client-2' })
    await expect(
      provider().exchangeAuthorizationCode(CLIENT, 'the-code', VERIFIER),
    ).rejects.toThrow('invalid_grant')
  })

  it('rejects a redirect_uri that differs from the one bound at authorize', async () => {
    consumeOauthCode.mockResolvedValue(consumed)
    await expect(
      provider().exchangeAuthorizationCode(
        CLIENT,
        'the-code',
        VERIFIER,
        'https://client.example/cb/extra',
      ),
    ).rejects.toThrow('invalid_grant')
  })

  it('PERMITS an OMITTED redirect_uri when it was OMITTED at authorize (RFC 6749 §4.1.3)', async () => {
    // The single-registered-URI flow lets a client OMIT redirect_uri at
    // /authorize; the stored value is the RESOLVED one (redirectUriSupplied =
    // false), so omitting it at token is permitted and tokens mint.
    consumeOauthCode.mockResolvedValue(consumed)
    const tokens = await provider().exchangeAuthorizationCode(CLIENT, 'the-code', VERIFIER)
    expect(typeof tokens.access_token).toBe('string')
    expect(insertOauthTokenPair).toHaveBeenCalledTimes(1)
  })

  it('REJECTS an OMITTED redirect_uri when it was SUPPLIED at authorize (RFC 6749 §4.1.3)', async () => {
    // redirectUriSupplied = true means the client sent redirect_uri at
    // /authorize, so RFC 6749 §4.1.3 REQUIRES it at token — omitting it is
    // invalid_grant, and the code (already burned) cannot be retried.
    consumeOauthCode.mockResolvedValue({ ...consumed, redirectUriSupplied: true })
    await expect(
      provider().exchangeAuthorizationCode(CLIENT, 'the-code', VERIFIER),
    ).rejects.toThrow('invalid_grant')
    expect(insertOauthTokenPair).not.toHaveBeenCalled()
  })

  it('PERMITS a MATCHING redirect_uri when it was SUPPLIED at authorize (RFC 6749 §4.1.3)', async () => {
    consumeOauthCode.mockResolvedValue({ ...consumed, redirectUriSupplied: true })
    const tokens = await provider().exchangeAuthorizationCode(
      CLIENT,
      'the-code',
      VERIFIER,
      'https://client.example/cb',
    )
    expect(typeof tokens.access_token).toBe('string')
    expect(insertOauthTokenPair).toHaveBeenCalledTimes(1)
  })

  it('rejects issuance on a deleted account (insert refused under the lifecycle lock)', async () => {
    // The code consumes fine, but the account was deleted in the race window:
    // insertOauthTokenPair takes the account-lifecycle lock, sees the deletion
    // tombstone, and returns false WITHOUT inserting. The provider maps that to
    // the uniform invalid_grant — no live credential is resurrected, and the
    // already-burned code cannot be retried.
    consumeOauthCode.mockResolvedValue(consumed)
    insertOauthTokenPair.mockResolvedValue(false)
    await expect(
      provider().exchangeAuthorizationCode(
        CLIENT,
        'the-code',
        VERIFIER,
        'https://client.example/cb',
      ),
    ).rejects.toThrow('invalid_grant')
    expect(consumeOauthCode).toHaveBeenCalledTimes(1)
    expect(insertOauthTokenPair).toHaveBeenCalledTimes(1)
  })

  it('rejects a foreign resource indicator with invalid_target (RFC 8707)', async () => {
    await expect(
      provider().exchangeAuthorizationCode(
        CLIENT,
        'the-code',
        VERIFIER,
        undefined,
        new URL('https://other.example/mcp'),
      ),
    ).rejects.toThrow('invalid_target')
    expect(consumeOauthCode).not.toHaveBeenCalled()
  })
})

describe('exchangeRefreshToken (one-time rotation)', () => {
  const liveRefresh = {
    userId: USER_ID,
    clientId: 'client-1',
    kind: 'refresh',
    scope: 'memory:read',
    expiresAt: new Date(Date.now() + 86_400_000),
  }

  it('rotates: revokes the predecessor by hash and carries the scope unchanged', async () => {
    resolveOauthToken.mockResolvedValue(liveRefresh)
    rotateOauthRefreshToken.mockResolvedValue(true)
    const tokens = await provider().exchangeRefreshToken(CLIENT, 'refresh-1')
    expect(tokens.scope).toBe('memory:read')
    const [userId, predecessorHash, access, refresh] = rotateOauthRefreshToken.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(userId).toBe(USER_ID)
    expect(predecessorHash).toBe(sha256('refresh-1'))
    expect(access.tokenHash).toBe(sha256(tokens.access_token))
    if (tokens.refresh_token === undefined) throw new Error('expected a rotated refresh_token')
    expect(refresh.tokenHash).toBe(sha256(tokens.refresh_token))
    expect(tokens.refresh_token).not.toBe('refresh-1')
  })

  it('forwards the active-client cap to refresh rotation', async () => {
    resolveOauthToken.mockResolvedValue(liveRefresh)
    rotateOauthRefreshToken.mockResolvedValue(true)
    const limits = vi.fn().mockResolvedValue({ maxActiveMcpClients: 1 })

    await provider(limits).exchangeRefreshToken(CLIENT, 'refresh-1')

    expect(limits).toHaveBeenCalledExactlyOnceWith(USER_ID)
    expect(rotateOauthRefreshToken.mock.calls[0]?.[4]).toBe(1)
  })

  it('rejects a revoked/rotated refresh token (resolver filters it out)', async () => {
    resolveOauthToken.mockResolvedValue(undefined)
    await expect(provider().exchangeRefreshToken(CLIENT, 'reused')).rejects.toThrow('invalid_grant')
    expect(rotateOauthRefreshToken).not.toHaveBeenCalled()
  })

  it('rejects an ACCESS token presented as a refresh token', async () => {
    resolveOauthToken.mockResolvedValue({ ...liveRefresh, kind: 'access' })
    await expect(provider().exchangeRefreshToken(CLIENT, 'not-refresh')).rejects.toThrow(
      'invalid_grant',
    )
  })

  it('rejects a refresh token bound to ANOTHER client', async () => {
    resolveOauthToken.mockResolvedValue({ ...liveRefresh, clientId: 'client-2' })
    await expect(provider().exchangeRefreshToken(CLIENT, 'stolen')).rejects.toThrow('invalid_grant')
  })

  // Issue #86: the token route gates the refresh GRANT, so this path is
  // normally unreachable for a code-only client. It becomes reachable if the
  // client's advertised grants are narrowed (a re-fetched CIMD document)
  // between issuance and rotation — rotating would then revoke the predecessor
  // and mint no successor, silently ending the session. Fail closed instead.
  it('rejects rotation for a client whose advertised grants no longer include refresh_token', async () => {
    resolveOauthToken.mockResolvedValue(liveRefresh)
    const codeOnlyClient = { ...CLIENT, grant_types: ['authorization_code'] }
    await expect(provider().exchangeRefreshToken(codeOnlyClient, 'refresh-1')).rejects.toThrow(
      'invalid_grant',
    )
    expect(rotateOauthRefreshToken).not.toHaveBeenCalled()
  })

  it('fails closed when a concurrent rotation already revoked the predecessor', async () => {
    resolveOauthToken.mockResolvedValue(liveRefresh)
    rotateOauthRefreshToken.mockResolvedValue(false)
    await expect(provider().exchangeRefreshToken(CLIENT, 'raced')).rejects.toThrow('invalid_grant')
  })

  it('narrows the scope to a requested subset of the original grant (RFC 6749 §6)', async () => {
    resolveOauthToken.mockResolvedValue({
      ...liveRefresh,
      scope: 'memory:read memory:write',
    })
    rotateOauthRefreshToken.mockResolvedValue(true)
    const tokens = await provider().exchangeRefreshToken(CLIENT, 'refresh-1', ['memory:read'])
    expect(tokens.scope).toBe('memory:read')
    const [, , access] = rotateOauthRefreshToken.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(access.scope).toBe('memory:read')
  })

  it('rejects a requested scope outside the original grant (no escalation)', async () => {
    resolveOauthToken.mockResolvedValue(liveRefresh) // granted: memory:read only
    await expect(
      provider().exchangeRefreshToken(CLIENT, 'refresh-1', ['memory:read', 'memory:write']),
    ).rejects.toThrow('invalid_grant')
    expect(rotateOauthRefreshToken).not.toHaveBeenCalled()
  })

  it('carries the full grant when no scope is requested', async () => {
    resolveOauthToken.mockResolvedValue({
      ...liveRefresh,
      scope: 'memory:read memory:write',
    })
    rotateOauthRefreshToken.mockResolvedValue(true)
    const tokens = await provider().exchangeRefreshToken(CLIENT, 'refresh-1')
    expect(tokens.scope).toBe('memory:read memory:write')
  })
})

describe('resolveRegisteredRedirectUri (byte-exact)', () => {
  const client = { redirect_uris: ['https://client.example/cb'] }

  it('accepts the exact registered URI', () => {
    expect(resolveRegisteredRedirectUri(client, 'https://client.example/cb')).toBe(
      'https://client.example/cb',
    )
  })

  it.each([
    ['a path suffix', 'https://client.example/cb/extra'],
    ['a query suffix', 'https://client.example/cb?x=1'],
    ['a different port', 'https://client.example:8443/cb'],
  ])('rejects %s', (_label, uri) => {
    expect(resolveRegisteredRedirectUri(client, uri)).toBeUndefined()
  })

  it('falls back to a SINGLE registered URI when none is presented', () => {
    expect(resolveRegisteredRedirectUri(client, undefined)).toBe('https://client.example/cb')
    expect(
      resolveRegisteredRedirectUri(
        { redirect_uris: ['https://a.example/cb', 'https://b.example/cb'] },
        undefined,
      ),
    ).toBeUndefined()
  })
})

// RFC 8252 §7.3: a native client binds an EPHEMERAL loopback port, so the AS
// MUST allow any port at request time. Claude Code registers via a CIMD
// document whose redirect_uris carry NO port and then asks for
// http://localhost:<ephemeral>/callback — byte-exact matching 400s it.
describe('resolveRegisteredRedirectUri (RFC 8252 loopback ports)', () => {
  it.each([
    ['localhost gains a port', 'http://localhost/callback', 'http://localhost:53421/callback'],
    ['127.0.0.1 gains a port', 'http://127.0.0.1/callback', 'http://127.0.0.1:53421/callback'],
    ['[::1] gains a port', 'http://[::1]/callback', 'http://[::1]:53421/callback'],
    // The registration naming a port does not PIN it (RFC 8252: any port).
    [
      'a registered port changes',
      'http://localhost:3000/callback',
      'http://localhost:4000/callback',
    ],
    [
      'a query matches exactly',
      'http://localhost/callback?x=1',
      'http://localhost:53421/callback?x=1',
    ],
    [
      'a query matches exactly on a low port',
      'http://localhost/callback?x=1',
      'http://localhost:1/callback?x=1',
    ],
    // A percent-encoded path is a plain URI character sequence: it keys like any
    // other and gets the same port relaxation (nothing is decoded on either side).
    [
      'a percent-encoded path gains a port',
      'http://localhost/caf%C3%A9',
      'http://localhost:5000/caf%C3%A9',
    ],
    // An absent path IS `/` to the parser, on both sides.
    ['a path-less registration gains a port', 'http://localhost', 'http://localhost:5000'],
    [
      'a path-less registration meets a rooted request',
      'http://localhost',
      'http://localhost:5000/',
    ],
  ])('accepts and returns the requested URI when %s', (_label, registered, requested) => {
    expect(resolveRegisteredRedirectUri({ redirect_uris: [registered] }, requested)).toBe(requested)
  })

  it.each([
    // Each loopback host is its own host — never cross-matched.
    ['localhost vs 127.0.0.1', 'http://localhost/callback', 'http://127.0.0.1:53421/callback'],
    ['127.0.0.1 vs localhost', 'http://127.0.0.1/callback', 'http://localhost:53421/callback'],
    ['localhost vs [::1]', 'http://localhost/callback', 'http://[::1]:53421/callback'],
    // The relaxation is the PORT only — path, query and scheme stay exact.
    ['a different path', 'http://localhost/callback', 'http://localhost:53421/other'],
    ['an added query', 'http://localhost/callback', 'http://localhost:53421/callback?x=1'],
    ['a dropped query', 'http://localhost/callback?x=1', 'http://localhost:53421/callback'],
    ['a fragment', 'http://localhost/callback', 'http://localhost:53421/callback#f'],
    ['a dot-segment path', 'http://localhost/callback', 'http://localhost:53421/x/../callback'],
    ['smuggled userinfo', 'http://localhost/callback', 'http://evil@localhost:53421/callback'],
    ['an authority-less scheme form', 'http://localhost/callback', 'http:localhost/callback'],
    // A backslash terminates the authority for the WHATWG parser but not for a
    // raw slice: the 302 would go to /@evil.com/callback, a path nobody
    // registered. The REQUESTED side is never shape-validated, so the character
    // policy is applied to it here (the registered side gets it at the schema
    // boundary — see 'a schema-invalid registration' below).
    [
      'a backslash authority terminator',
      'http://localhost/callback',
      'http://localhost\\@evil.com/callback',
    ],
    ['a space in the path', 'http://localhost/callback', 'http://localhost:53421/call back'],
    // LEGACY oauth_clients rows predate the schema's character refine, and DCR
    // is open registration — so the same rule guards the REGISTERED side, or a
    // clean request would relax onto a row whose parsed path is /@evil.com/cb.
    // Such a row keeps byte-exact matching; it gains nothing and loses nothing.
    [
      'a legacy registered URI containing a backslash',
      'http://localhost\\@evil.com/callback',
      'http://localhost:53421/callback',
    ],
    [
      'a legacy registered URI containing non-ASCII',
      'http://localhost/caf\u00e9',
      'http://localhost:5000/caf\u00e9',
    ],
    // Percent-encoding is how a client presents anything outside the URI
    // grammar; the RAW form of the same path is not the same URI.
    [
      'a raw non-ASCII path against its encoded registration',
      'http://localhost/caf%C3%A9',
      'http://localhost:5000/caf\u00e9',
    ],
    // A query with NO path: `?` also terminates the authority, so the key can
    // never collapse a query-carrying URI onto a path-less registration.
    ['a query on a path-less registration', 'http://localhost', 'http://localhost:5000?evil=1'],
    ['a query on a rooted registration', 'http://localhost/', 'http://localhost:5000?evil=1'],
    // Port relaxation is loopback-HTTP only.
    ['https on a loopback host', 'https://localhost/callback', 'https://localhost:8443/callback'],
    ['a non-loopback http host', 'http://app.example/callback', 'http://app.example:8080/callback'],
    ['https elsewhere', 'https://example.com/callback', 'https://example.com:8443/callback'],
  ])('rejects %s', (_label, registered, requested) => {
    expect(resolveRegisteredRedirectUri({ redirect_uris: [registered] }, requested)).toBeUndefined()
  })

  // The live Claude Code CIMD document (client_id =
  // https://claude.ai/oauth/claude-code-client-metadata) as fetched in prod.
  const CLAUDE_CODE_CIMD = {
    client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none' as const,
  }

  it('accepts the ephemeral port Claude Code actually presents', () => {
    expect(resolveRegisteredRedirectUri(CLAUDE_CODE_CIMD, 'http://localhost:53421/callback')).toBe(
      'http://localhost:53421/callback',
    )
    expect(resolveRegisteredRedirectUri(CLAUDE_CODE_CIMD, 'http://127.0.0.1:8129/callback')).toBe(
      'http://127.0.0.1:8129/callback',
    )
    expect(
      resolveRegisteredRedirectUri(CLAUDE_CODE_CIMD, 'http://localhost:53421/evil'),
    ).toBeUndefined()
  })

  // The consent POST re-resolves using the hidden redirect_uri field, which
  // carries the ALREADY-RESOLVED (ported) URI — resolution must be idempotent
  // or the second hop 400s.
  it('re-resolves its own output (the consent POST round-trip)', () => {
    const resolved = resolveRegisteredRedirectUri(
      CLAUDE_CODE_CIMD,
      'http://localhost:53421/callback',
    )
    expect(resolved).toBeDefined()
    expect(resolveRegisteredRedirectUri(CLAUDE_CODE_CIMD, resolved)).toBe(resolved)
  })

  // A legacy row loses only the RELAXATION, never the registration: the exact
  // URI still resolves through the byte-exact branch ahead of the matcher.
  it('still resolves a legacy registered URI presented byte-exactly', () => {
    const legacy = 'http://localhost/caf\u00e9'
    expect(resolveRegisteredRedirectUri({ redirect_uris: [legacy] }, legacy)).toBe(legacy)
  })

  // No such row can be created any more — the character policy is DEFINED at
  // the schema boundary, and both registration paths compose it.
  it('rejects a schema-invalid registration at the boundary', () => {
    expect(
      clientIdMetadataDocumentSchema.safeParse({
        client_id: 'https://client.example/oauth/client.json',
        client_name: 'Backslash Client',
        redirect_uris: ['http://localhost\\@evil.com/callback'],
      }).success,
    ).toBe(false)
  })

  // An IPv6-only native client can bind no loopback literal but `[::1]`. The
  // matcher's `[::1]` branch is only reachable if the SCHEMA boundary lets such
  // a document register in the first place, so parse a real CIMD document here
  // rather than hand-rolling a client object past that boundary.
  it('matches an ephemeral port for an IPv6-loopback CIMD registration', () => {
    const document = clientIdMetadataDocumentSchema.parse({
      client_id: 'https://client.example/oauth/client.json',
      client_name: 'IPv6-only Client',
      redirect_uris: ['http://[::1]/callback'],
    })
    expect(document.redirect_uris).toEqual(['http://[::1]/callback'])
    expect(resolveRegisteredRedirectUri(document, 'http://[::1]:53421/callback')).toBe(
      'http://[::1]:53421/callback',
    )
    // Still its own host: an IPv4 loopback request does not match it.
    expect(
      resolveRegisteredRedirectUri(document, 'http://127.0.0.1:53421/callback'),
    ).toBeUndefined()
  })

  // The REQUESTED (ported) URI is what the code carries, so the byte-exact
  // token-endpoint comparison sees the same value the client presents there.
  it('carries the ported URI through authorize into the token exchange', async () => {
    const ported = resolveRegisteredRedirectUri(
      CLAUDE_CODE_CIMD,
      'http://localhost:53421/callback',
    ) as string
    insertOauthCode.mockResolvedValue(undefined)
    const res = { redirect: vi.fn((_status: number, _url: string) => {}) }
    const client = { ...CLIENT, ...CLAUDE_CODE_CIMD }
    await provider().authorize(
      client,
      {
        userId: USER_ID,
        codeChallenge: s256Challenge(VERIFIER),
        redirectUri: ported,
        redirectUriSupplied: true,
      },
      res,
    )
    const [, row] = insertOauthCode.mock.calls[0] as [string, Record<string, unknown>]
    expect(row.redirectUri).toBe(ported)
    const [, location] = res.redirect.mock.calls[0] as [number, string]
    expect(new URL(location).host).toBe('localhost:53421')

    consumeOauthCode.mockResolvedValue({
      userId: USER_ID,
      clientId: client.client_id,
      redirectUri: row.redirectUri,
      redirectUriSupplied: true,
      codeChallenge: s256Challenge(VERIFIER),
      scope: 'memory:read memory:write',
    })
    const tokens = await provider().exchangeAuthorizationCode(client, 'the-code', VERIFIER, ported)
    expect(tokens.token_type).toBe('bearer')
    await expect(
      provider().exchangeAuthorizationCode(
        client,
        'the-code',
        VERIFIER,
        'http://localhost:9/callback',
      ),
    ).rejects.toBeInstanceOf(OAuthGrantError)
  })
})

describe('authenticateClientCredentials (custom client auth — hashes at rest)', () => {
  const baseRow = {
    clientId: 'client-1',
    clientName: 'Test Client',
    redirectUris: ['https://client.example/cb'],
    registrationMethod: 'dynamic_registration',
    createdAt: new Date('2026-06-10T12:00:00Z'),
  }

  it('authenticates a public client without a secret (PKCE is its auth)', async () => {
    getClientByClientId.mockResolvedValue({
      ...baseRow,
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: null,
    })
    const client = await authenticateClientCredentials('client-1', undefined)
    expect(client?.client_id).toBe('client-1')
    expect(client).not.toHaveProperty('client_secret')
  })

  it('authenticates a confidential client by comparing SHA-256 hashes', async () => {
    getClientByClientId.mockResolvedValue({
      ...baseRow,
      tokenEndpointAuthMethod: 'client_secret_post',
      clientSecretHash: hashClientSecret('the-secret'),
    })
    const client = await authenticateClientCredentials('client-1', 'the-secret')
    expect(client?.client_id).toBe('client-1')
    expect(client).not.toHaveProperty('client_secret')
    expect(client).not.toHaveProperty('clientSecretHash')
  })

  it.each([
    ['a wrong secret', 'wrong-secret'],
    ['a missing secret', undefined],
  ])('rejects a confidential client with %s', async (_label, secret) => {
    getClientByClientId.mockResolvedValue({
      ...baseRow,
      tokenEndpointAuthMethod: 'client_secret_post',
      clientSecretHash: hashClientSecret('the-secret'),
    })
    expect(await authenticateClientCredentials('client-1', secret)).toBeUndefined()
  })

  it('rejects an unknown client_id', async () => {
    getClientByClientId.mockResolvedValue(undefined)
    expect(await authenticateClientCredentials('nope', 'any')).toBeUndefined()
  })

  it('enforces the registered channel: post-registered secret over Basic is rejected', async () => {
    getClientByClientId.mockResolvedValue({
      ...baseRow,
      tokenEndpointAuthMethod: 'client_secret_post',
      clientSecretHash: hashClientSecret('the-secret'),
    })
    expect(
      await authenticateClientCredentials('client-1', 'the-secret', 'client_secret_basic'),
    ).toBeUndefined()
  })

  it('accepts the registered channel: basic-registered secret over Basic succeeds', async () => {
    getClientByClientId.mockResolvedValue({
      ...baseRow,
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecretHash: hashClientSecret('the-secret'),
    })
    const client = await authenticateClientCredentials(
      'client-1',
      'the-secret',
      'client_secret_basic',
    )
    expect(client?.client_id).toBe('client-1')
  })
})
