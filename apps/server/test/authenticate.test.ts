// SPDX-License-Identifier: Apache-2.0
// authenticate middleware — header parsing + 401 contract, isolated from the DB
// by mocking the core resolver. Valid/expired/garbage token paths.
import { runWithContext } from '@3ngram/config'
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

const authenticateToken = vi.fn<(token: string) => Promise<string | undefined>>()
vi.mock('@3ngram/core/auth', () => ({ authenticateToken }))

const { authenticate } = await import('../src/middleware/authenticate.js')

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; body: unknown }
}

const reqWith = (authHeader?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader : undefined),
  }) as unknown as Request

/** Drives the middleware inside a request scope, then drains the async chain. */
async function run(req: Request, res: Response): Promise<ReturnType<typeof vi.fn>> {
  const next = vi.fn()
  runWithContext({ requestId: 'test', surface: 'rest' }, () => {
    authenticate(req, res, next as unknown as NextFunction)
  })
  // authenticate resolves via a .then() chain; flush a few microtask turns so
  // the resolver settles before assertions (no real timers involved).
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return next
}

afterEach(() => vi.clearAllMocks())

describe('authenticate middleware', () => {
  it('binds req.userId and calls next for a valid token', async () => {
    authenticateToken.mockResolvedValue('11111111-1111-1111-1111-111111111111')
    const req = reqWith('Bearer good-token')
    const res = mockRes()
    const next = await run(req, res)
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.userId).toBe('11111111-1111-1111-1111-111111111111')
    expect(res.statusCode).toBe(0)
  })

  it('binds req.userId and calls next for a lowercase bearer scheme', async () => {
    authenticateToken.mockResolvedValue('11111111-1111-1111-1111-111111111111')
    const req = reqWith('bearer good-token')
    const res = mockRes()
    const next = await run(req, res)
    expect(next).toHaveBeenCalledTimes(1)
    expect(authenticateToken).toHaveBeenCalledWith('good-token')
    expect(req.userId).toBe('11111111-1111-1111-1111-111111111111')
    expect(res.statusCode).toBe(0)
  })

  it('401s an expired/unknown token (resolver returns undefined)', async () => {
    authenticateToken.mockResolvedValue(undefined)
    const res = mockRes()
    await run(reqWith('Bearer expired-token'), res)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('401s a garbage (non-Bearer) Authorization header without hitting the resolver', async () => {
    const res = mockRes()
    await run(reqWith('Basic Zm9vOmJhcg=='), res)
    expect(res.statusCode).toBe(401)
    expect(authenticateToken).not.toHaveBeenCalled()
  })

  it('401s a missing Authorization header', async () => {
    const res = mockRes()
    await run(reqWith(undefined), res)
    expect(res.statusCode).toBe(401)
    expect(authenticateToken).not.toHaveBeenCalled()
  })
})
