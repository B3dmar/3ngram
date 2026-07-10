// SPDX-License-Identifier: Apache-2.0
// oauthBearerAuth middleware — header parsing + RFC 6750/RFC 9728 status/
// challenge contract, isolated from crypto + DB by mocking core
// verifyAccessToken and the config loader. Covers 200 / 401 (bare +
// invalid_token, both carrying the RFC 9728 resource_metadata pointer) / 503,
// the WWW-Authenticate header, and the req.userId binding shape shared with
// the C2/C3 middlewares.
import { runWithContext } from '@3ngram/config'
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

const verifyAccessToken =
  vi.fn<
    (
      token: string,
      config: unknown,
    ) => Promise<{ ok: boolean; token?: { userId: string; scope?: string } }>
  >()
// parseScopes is the REAL implementation: the middleware parses the verified
// token's `scope` claim through it, and the binding shape (empty set when the
// claim is absent) is part of the contract under test.
vi.mock('@3ngram/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/core/auth')>()
  return { verifyAccessToken, parseScopes: actual.parseScopes }
})
// The resource is a REAL URL: challenge() derives the RFC 9728 resource_metadata
// pointer from it, and that derivation is part of the contract under test.
vi.mock('@3ngram/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@3ngram/config')>()
  return {
    ...actual,
    loadOAuthConfig: () => ({
      issuer: 'https://rs.test/',
      resource: 'https://rs.test/mcp',
      keys: [],
    }),
  }
})

/** The RFC 9728 well-known URL every 401 challenge must advertise. */
const RESOURCE_METADATA_URL = 'https://rs.test/.well-known/oauth-protected-resource/mcp'

const { oauthBearerAuth } = await import('../src/middleware/oauth-bearer.js')

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value
      return this
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as unknown as Response & {
    statusCode: number
    body: unknown
    headers: Record<string, string>
  }
}

const reqWith = (authHeader?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader : undefined),
  }) as unknown as Request

async function run(req: Request, res: Response): Promise<ReturnType<typeof vi.fn>> {
  const next = vi.fn()
  runWithContext({ requestId: 'test', surface: 'rest' }, () => {
    oauthBearerAuth(req, res, next as unknown as NextFunction)
  })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return next
}

afterEach(() => vi.clearAllMocks())

const UID = '11111111-1111-1111-1111-111111111111'

describe('oauthBearerAuth middleware', () => {
  it('binds req.userId + parsed scopes and calls next for a valid token', async () => {
    verifyAccessToken.mockResolvedValue({
      ok: true,
      token: { userId: UID, scope: 'memory:read memory:write' },
    })
    const req = reqWith('Bearer good.jwt.token')
    const res = mockRes()
    const next = await run(req, res)
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.userId).toBe(UID)
    expect(req.oauthScopes).toEqual(['memory:read', 'memory:write'])
    expect(res.statusCode).toBe(0)
  })

  it('FAILS CLOSED: a token with no scope claim binds an empty scope set', async () => {
    verifyAccessToken.mockResolvedValue({ ok: true, token: { userId: UID } })
    const req = reqWith('Bearer good.jwt.token')
    const res = mockRes()
    const next = await run(req, res)
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.oauthScopes).toEqual([])
  })

  it('accepts a lowercase bearer scheme (PR #95 case-insensitive)', async () => {
    verifyAccessToken.mockResolvedValue({ ok: true, token: { userId: UID } })
    const req = reqWith('bearer good.jwt.token')
    const res = mockRes()
    const next = await run(req, res)
    expect(next).toHaveBeenCalledTimes(1)
    expect(verifyAccessToken).toHaveBeenCalledWith('good.jwt.token', expect.anything())
  })

  it('401s a missing header with a bare challenge (no error param) + resource_metadata', async () => {
    const res = mockRes()
    await run(reqWith(undefined), res)
    expect(res.statusCode).toBe(401)
    expect(res.headers['WWW-Authenticate']).toBe(
      `Bearer realm="mcp", resource_metadata="${RESOURCE_METADATA_URL}"`,
    )
    expect(res.body).toEqual({ error: 'unauthorized' })
    expect(verifyAccessToken).not.toHaveBeenCalled()
  })

  it('401s a non-Bearer header without hitting the verifier', async () => {
    const res = mockRes()
    await run(reqWith('Basic Zm9vOmJhcg=='), res)
    expect(res.statusCode).toBe(401)
    expect(verifyAccessToken).not.toHaveBeenCalled()
  })

  it('401s an invalid token with error="invalid_token" + resource_metadata (RFC 9728 §5.1)', async () => {
    verifyAccessToken.mockResolvedValue({ ok: false })
    const res = mockRes()
    await run(reqWith('Bearer expired.or.bad'), res)
    expect(res.statusCode).toBe(401)
    expect(res.headers['WWW-Authenticate']).toBe(
      'Bearer realm="mcp", error="invalid_token", ' +
        'error_description="The access token is invalid", ' +
        `resource_metadata="${RESOURCE_METADATA_URL}"`,
    )
    expect(res.body).toEqual({ error: 'invalid_token' })
  })

  it('503s (not 500) when the verifier throws — caught locally, not forwarded', async () => {
    verifyAccessToken.mockRejectedValue(new Error('jwks unreachable'))
    const res = mockRes()
    const next = await run(reqWith('Bearer some.jwt'), res)
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'service_unavailable' })
    expect(next).not.toHaveBeenCalled()
  })
})
