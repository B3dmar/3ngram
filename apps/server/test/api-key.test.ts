// SPDX-License-Identifier: Apache-2.0
// apiKeyAuth middleware — header parsing + status contract, isolated from the DB
// by mocking the core resolver. Covers the 200 / 401 / 503 contract, the
// best-effort last_used_at fire-and-forget, and coexistence shape with the
// Bearer authenticate middleware (both bind req.userId identically).
import { runWithContext } from '@3ngram/config'
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

const authenticateApiKey = vi.fn<(key: string) => Promise<string | undefined>>()
const touchApiKeyLastUsed = vi.fn<(userId: string, key: string) => Promise<void>>()
vi.mock('@3ngram/core/auth', () => ({ authenticateApiKey, touchApiKeyLastUsed }))

const { apiKeyAuth } = await import('../src/middleware/api-key.js')

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

const reqWith = (apiKey?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'x-api-key' ? apiKey : undefined),
  }) as unknown as Request

async function run(req: Request, res: Response): Promise<ReturnType<typeof vi.fn>> {
  const next = vi.fn()
  runWithContext({ requestId: 'test', surface: 'rest' }, () => {
    apiKeyAuth(req, res, next as unknown as NextFunction)
  })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return next
}

afterEach(() => vi.clearAllMocks())

describe('apiKeyAuth middleware', () => {
  it('binds req.userId and calls next for a valid key', async () => {
    authenticateApiKey.mockResolvedValue('11111111-1111-1111-1111-111111111111')
    touchApiKeyLastUsed.mockResolvedValue()
    const req = reqWith('3ng_abc_secret')
    const res = mockRes()
    const next = await run(req, res)
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.userId).toBe('11111111-1111-1111-1111-111111111111')
    expect(res.statusCode).toBe(0)
  })

  it('fires a best-effort last_used_at update on success', async () => {
    authenticateApiKey.mockResolvedValue('11111111-1111-1111-1111-111111111111')
    touchApiKeyLastUsed.mockResolvedValue()
    await run(reqWith('3ng_abc_secret'), mockRes())
    expect(touchApiKeyLastUsed).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      '3ng_abc_secret',
    )
  })

  it('a failed last_used_at update does not break the request', async () => {
    authenticateApiKey.mockResolvedValue('11111111-1111-1111-1111-111111111111')
    touchApiKeyLastUsed.mockRejectedValue(new Error('db down'))
    const res = mockRes()
    const next = await run(reqWith('3ng_abc_secret'), res)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(0)
  })

  it('401s an unknown/revoked key (resolver returns undefined)', async () => {
    authenticateApiKey.mockResolvedValue(undefined)
    const res = mockRes()
    await run(reqWith('3ng_abc_revoked'), res)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled()
  })

  it('401s a missing X-API-Key header without hitting the resolver', async () => {
    const res = mockRes()
    await run(reqWith(undefined), res)
    expect(res.statusCode).toBe(401)
    expect(authenticateApiKey).not.toHaveBeenCalled()
  })

  it('503s (not 500) when the resolver throws — caught locally', async () => {
    authenticateApiKey.mockRejectedValue(new Error('resolver unavailable'))
    const res = mockRes()
    const next = await run(reqWith('3ng_abc_secret'), res)
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'service_unavailable' })
    // critically: the error is NOT forwarded to next() (which would become a 500)
    expect(next).not.toHaveBeenCalled()
  })
})
