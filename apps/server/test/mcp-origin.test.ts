// SPDX-License-Identifier: Apache-2.0
// Origin validation on /mcp (issue #101) — the 2026-07-28 Streamable HTTP MUST.
//
// Two levels, because two different things can break:
//   1. the middleware's decision (allow on absent, allow on allowlisted, 403 otherwise), and
//   2. its POSITION in the /mcp chain — a correct decision mounted after auth
//      would still let a foreign origin consume a rate-limit point, and a
//      middleware that rejects on ABSENT Origin would break every real client.
//
// The allowlist is driven through the REAL @3ngram/config loader rather than a
// mock: normalization is the part most likely to regress, and a mock would
// assert the middleware against a fiction.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import type { NextFunction, Request, Response } from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { mcpOriginValidation } from '../src/middleware/mcp-origin.js'

const ALLOWED = 'https://app.3ngram.test'
const EXTRA = 'http://localhost:6274'

/** A minimal Express double: only what the middleware actually touches. */
function fakeExchange(origin?: string) {
  const req = { header: (name: string) => (name === 'origin' ? origin : undefined) } as Request
  const json = vi.fn()
  const status = vi.fn(() => ({ json }) as unknown as Response)
  const res = { status, json } as unknown as Response
  const next = vi.fn() as unknown as NextFunction
  return { req, res, next, status, json }
}

describe('mcpOriginValidation decision', () => {
  const originalEnv = { ...process.env }

  beforeAll(() => {
    process.env.WEB_APP_URL = ALLOWED
    process.env.MCP_ALLOWED_ORIGINS = EXTRA
    resetEnvCache()
  })

  afterAll(() => {
    process.env = { ...originalEnv }
    resetEnvCache()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('allows a request with NO Origin header', () => {
    // THE regression that would hurt: Claude Desktop, the CLI, and agent
    // runtimes send no Origin. The spec's MUST is conditional on the header
    // being PRESENT, so absence must pass through untouched.
    const { req, res, next, status } = fakeExchange(undefined)
    mcpOriginValidation(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(status).not.toHaveBeenCalled()
  })

  it('allows an allowlisted Origin from either source', () => {
    for (const origin of [ALLOWED, EXTRA]) {
      const { req, res, next, status } = fakeExchange(origin)
      mcpOriginValidation(req, res, next)
      expect(next).toHaveBeenCalledOnce()
      expect(status).not.toHaveBeenCalled()
    }
  })

  it('allows an allowlisted Origin spelled with different case or a default port', () => {
    for (const origin of ['HTTPS://APP.3NGRAM.TEST', 'https://app.3ngram.test:443']) {
      const { req, res, next, status } = fakeExchange(origin)
      mcpOriginValidation(req, res, next)
      expect(next).toHaveBeenCalledOnce()
      expect(status).not.toHaveBeenCalled()
    }
  })

  it('rejects a foreign Origin with 403 and never calls next()', () => {
    const { req, res, next, status, json } = fakeExchange('https://evil.example')
    mcpOriginValidation(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(403)
    // A transport-level rejection: no request id to echo, since the body was
    // never trusted as a JSON-RPC message.
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ jsonrpc: '2.0', id: null, error: expect.anything() }),
    )
  })

  it('rejects a malformed or literal-null Origin', () => {
    for (const origin of ['null', 'not a url', '']) {
      const { req, res, next, status } = fakeExchange(origin)
      mcpOriginValidation(req, res, next)
      expect(next).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(403)
      vi.clearAllMocks()
    }
  })

  it('never echoes the rejected Origin value back to the client', () => {
    // The header is attacker-controlled; reflecting it would turn a 403 into a
    // reflection surface (hard rule 6 posture).
    const { req, res, next, json } = fakeExchange('https://evil.example/<script>')
    mcpOriginValidation(req, res, next)
    expect(JSON.stringify(json.mock.calls[0])).not.toContain('evil.example')
  })
})

describe('mcpOriginValidation position in the /mcp chain', () => {
  const originalEnv = { ...process.env }
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    process.env.WEB_APP_URL = ALLOWED
    resetEnvCache()
    server = createApp().listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err === undefined ? resolve() : reject(err)))
    })
    process.env = { ...originalEnv }
    resetEnvCache()
  })

  const call = (origin?: string) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin === undefined ? {} : { origin }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

  it('rejects a foreign Origin BEFORE authentication runs', async () => {
    // 403 rather than 401 on an unauthenticated request is the proof of
    // ordering: the origin check fired first, so a foreign caller never reaches
    // the bearer verifier and never spends a rate-limit point.
    const response = await call('https://evil.example')
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ jsonrpc: '2.0', id: null })
  })

  it('lets a request with no Origin through to authentication', async () => {
    // 401, not 403: the middleware passed it on and oauthBearerAuth answered.
    const response = await call(undefined)
    expect(response.status).toBe(401)
  })

  it('lets an allowlisted Origin through to authentication', async () => {
    const response = await call(ALLOWED)
    expect(response.status).toBe(401)
  })
})
