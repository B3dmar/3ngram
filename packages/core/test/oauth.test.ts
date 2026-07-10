// SPDX-License-Identifier: Apache-2.0
// OAuth resource-server verification — signature + claim checks isolated from the
// DB by mocking the db revocation resolver. Real RS256 keys (jose) so the JWKS
// path is exercised end-to-end; the revocation path is stubbed. Covers the
// acceptance matrix: valid 200, wrong aud, wrong iss (incl. trailing-slash
// variants passing), expired, nbf, unknown kid, malformed, revoked.
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OAuthJwk, OAuthVerifyConfig } from '../src/auth/oauth.js'

const resolveOauthToken = vi.fn<(hash: string) => Promise<Record<string, unknown> | undefined>>()
vi.mock('@3ngram/db', () => ({ resolveOauthToken }))

const {
  verifyAccessToken,
  derivePublicJwks,
  rotateKeyArray,
  assertSigningKeysUsable,
  signAccessToken,
} = await import('../src/auth/oauth.js')

const ISSUER = 'https://api.3ngram.test/'
const RESOURCE = 'https://api.3ngram.test/mcp'

interface TestKey {
  jwk: OAuthJwk
  privateKey: CryptoKey
}

async function makeKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const pubJwk = await exportJWK(publicKey)
  const privJwk = await exportJWK(privateKey)
  const jwk = { ...privJwk, ...pubJwk, kty: 'RSA', alg: 'RS256', kid } as OAuthJwk
  return { jwk, privateKey }
}

let current: TestKey
let old: TestKey
let foreign: TestKey
let config: OAuthVerifyConfig

beforeAll(async () => {
  current = await makeKey('current-kid')
  old = await makeKey('old-kid')
  foreign = await makeKey('foreign-kid')
  config = { issuer: ISSUER, resource: RESOURCE, keys: [current.jwk, old.jwk] }
})

async function sign(
  key: TestKey,
  opts: { iss?: string; aud?: string; exp?: string | number; nbf?: number; kid?: string } = {},
): Promise<string> {
  const signer = new SignJWT({ scope: 'memory:read' })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? key.jwk.kid })
    .setSubject('11111111-1111-1111-1111-111111111111')
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? RESOURCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
  if (opts.nbf !== undefined) signer.setNotBefore(opts.nbf)
  return signer.sign(key.privateKey)
}

const liveGrant = {
  userId: '11111111-1111-1111-1111-111111111111',
  clientId: 'client-x',
  kind: 'access',
  scope: 'memory:read',
  expiresAt: new Date(Date.now() + 3_600_000),
}

afterEach(() => vi.clearAllMocks())

describe('verifyAccessToken', () => {
  it('accepts a valid token and returns the resolved grant (200 path)', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const token = await sign(current)
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.token.userId).toBe(liveGrant.userId)
      expect(result.token.clientId).toBe('client-x')
      expect(result.token.scope).toBe('memory:read')
    }
  })

  it('accepts a token signed by an OLD key still in the array (kid select, rotation)', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const token = await sign(old)
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(true)
  })

  it('rejects a wrong audience (RFC 8707 strict aud)', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const token = await sign(current, { aud: 'https://other.example/mcp' })
    const result = await verifyAccessToken(token, config)
    expect(result).toEqual({ ok: false, reason: 'invalid_token' })
    expect(resolveOauthToken).not.toHaveBeenCalled()
  })

  it('rejects a wrong issuer', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const token = await sign(current, { iss: 'https://evil.example/' })
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(false)
    expect(resolveOauthToken).not.toHaveBeenCalled()
  })

  it('accepts trailing-slash issuer variants on both sides (S4 normalization)', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    // token iss has NO trailing slash; config issuer HAS one — must still match.
    const token = await sign(current, { iss: 'https://api.3ngram.test' })
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(true)
  })

  it('rejects an expired token', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const token = await sign(current, { exp: Math.floor(Date.now() / 1000) - 60 })
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(false)
  })

  it('rejects a not-yet-valid token (nbf in the future)', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const token = await sign(current, { nbf: Math.floor(Date.now() / 1000) + 3600 })
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(false)
  })

  it('rejects a token signed by an unknown key (kid not in JWKS)', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const token = await sign(foreign)
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(false)
  })

  it('rejects a malformed token', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const result = await verifyAccessToken('not.a.jwt', config)
    expect(result).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('rejects a signature-valid but REVOKED token (resolver returns undefined)', async () => {
    resolveOauthToken.mockResolvedValue(undefined)
    const token = await sign(current)
    const result = await verifyAccessToken(token, config)
    expect(result).toEqual({ ok: false, reason: 'invalid_token' })
    expect(resolveOauthToken).toHaveBeenCalledTimes(1)
  })

  it('rejects a token whose grant is a refresh kind, not access', async () => {
    resolveOauthToken.mockResolvedValue({ ...liveGrant, kind: 'refresh' })
    const token = await sign(current)
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(false)
  })

  it('propagates a resolver throw (caller maps to 503)', async () => {
    resolveOauthToken.mockRejectedValue(new Error('db down'))
    const token = await sign(current)
    await expect(verifyAccessToken(token, config)).rejects.toThrow('db down')
  })
})

describe('derivePublicJwks', () => {
  it('exposes only public fields — never private material', () => {
    const jwks = derivePublicJwks(config.keys)
    expect(jwks.keys).toHaveLength(2)
    for (const key of jwks.keys) {
      expect(key.kty).toBe('RSA')
      expect(key.alg).toBe('RS256')
      expect(key.use).toBe('sig')
      expect(typeof key.kid).toBe('string')
      expect(typeof key.n).toBe('string')
      expect(typeof key.e).toBe('string')
      for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
        expect(key).not.toHaveProperty(priv)
      }
    }
  })

  it('produces keys that actually verify a token signed by the matching private key', async () => {
    const jwks = derivePublicJwks([current.jwk])
    const pub = jwks.keys[0]
    if (pub === undefined) throw new Error('expected a public key')
    const verifyKey = await importJWK(pub, 'RS256')
    const token = await sign(current)
    const { jwtVerify } = await import('jose')
    await expect(jwtVerify(token, verifyKey)).resolves.toBeDefined()
  })
})

describe('rotateKeyArray', () => {
  it('puts the new key at the front and keeps existing keys behind it', () => {
    const rotated = rotateKeyArray(foreign.jwk, [current.jwk, old.jwk])
    expect(rotated.map((k) => k.kid)).toEqual(['foreign-kid', 'current-kid', 'old-kid'])
  })

  it('bootstraps the first key into an empty array', () => {
    const rotated = rotateKeyArray(current.jwk, [])
    expect(rotated).toEqual([current.jwk])
  })
})

describe('assertSigningKeysUsable', () => {
  // The exact failure case: a JWK that passes SHAPE
  // validation (every required field non-empty) but is NOT usable RSA key
  // material. Before this gate it booted and served an unusable JWKS, failing
  // only at the first token verify.
  const SHAPE_VALID_BUT_UNUSABLE: OAuthJwk = {
    kty: 'RSA',
    kid: 'broken-kid',
    alg: 'RS256',
    n: 'x',
    e: 'AQAB',
    d: 'y',
  }

  it('accepts structurally + cryptographically valid RS256 keys', async () => {
    await expect(assertSigningKeysUsable([current.jwk, old.jwk])).resolves.toBeUndefined()
  })

  it('fails fast on shape-valid but unusable key material (the #104 n:"x" case)', async () => {
    await expect(assertSigningKeysUsable([SHAPE_VALID_BUT_UNUSABLE])).rejects.toThrow(
      /kid=broken-kid/,
    )
  })

  it('fails on the first unusable key even when a valid key precedes it', async () => {
    await expect(assertSigningKeysUsable([current.jwk, SHAPE_VALID_BUT_UNUSABLE])).rejects.toThrow(
      /kid=broken-kid/,
    )
  })

  it('never leaks private key material in the error (hard rule 6)', async () => {
    // Distinctive private fields (vs the degenerate "x"/"y" above, which are
    // substrings of ordinary words) so a substring check is meaningful.
    const sentinel: OAuthJwk = {
      kty: 'RSA',
      kid: 'sentinel-kid',
      alg: 'RS256',
      n: 'NSENTINEL_PUBLIC_MODULUS',
      e: 'AQAB',
      d: 'DSENTINEL_PRIVATE_EXPONENT',
    }
    const error = await assertSigningKeysUsable([sentinel]).catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).not.toContain(sentinel.d)
    expect(error.message).not.toContain(sentinel.n)
  })
})

describe('signAccessToken (OAuth AS A2)', () => {
  it('mints a token verifyAccessToken accepts — same claim set, FIRST key signs', async () => {
    resolveOauthToken.mockResolvedValue(liveGrant)
    const token = await signAccessToken(
      {
        userId: liveGrant.userId,
        scope: 'memory:read memory:write',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      config,
    )
    // kid header names the FIRST key in the array (the rotation contract).
    const header = JSON.parse(Buffer.from(token.split('.')[0] as string, 'base64url').toString())
    expect(header).toMatchObject({ alg: 'RS256', kid: 'current-kid' })
    // iss is the config issuer string VERBATIM (S4 finding 3).
    const payload = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString())
    expect(payload.iss).toBe(ISSUER)
    expect(payload.aud).toBe(RESOURCE)
    expect(payload.sub).toBe(liveGrant.userId)
    expect(payload.scope).toBe('memory:read memory:write')
    const result = await verifyAccessToken(token, config)
    expect(result.ok).toBe(true)
  })

  it('throws on an empty key array instead of minting unverifiable tokens', async () => {
    await expect(
      signAccessToken(
        { userId: liveGrant.userId, scope: 'memory:read', expiresAt: new Date(Date.now() + 1000) },
        { issuer: ISSUER, resource: RESOURCE, keys: [] },
      ),
    ).rejects.toThrow(/no signing key/)
  })
})
