// SPDX-License-Identifier: Apache-2.0
// Rate-limiter WIRING: the app factory accepts injected
// limiters (the test seam — NO real Redis), the /auth/login per-IP limiter runs
// before the handler, and the /mcp per-user limiter runs AFTER
// oauthBearerAuth (an unauthenticated /mcp is 401'd before it can consume a
// point). Limiters are injected so the suite is deterministic and Redis-free.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRateLimiter, ipKey, userIdKey } from '../src/middleware/rate-limit.js'

let server: Server
let baseUrl: string
// Records whether the /mcp limiter middleware ever executed — it must NOT for an
// unauthenticated request (auth gates it first).
const mcpLimiterCalls = vi.fn()

beforeAll(async () => {
  process.env.BASE_URL = 'https://api.3ngram.test'
  // OAUTH_JWKS unset is fine: an unauthenticated /mcp is 401'd at the Bearer
  // guard before any token verification, which is exactly the path under test.
  resetEnvCache()
  const { createApp } = await import('../src/app.js')

  // Per-IP login limiter: 1 request / 60s so the second login is a 429.
  const authLimiter = createRateLimiter({
    points: 1,
    duration: 60,
    keyPrefix: 'test:auth:ip',
    keyResolver: ipKey,
  })
  // Per-IP /oauth/register limiter: 1 request / 60s so the second register is a
  // 429. Same construction as the production default (resolveLimiters) — only
  // the point ceiling differs, so this proves the limiter gates the route.
  const registerLimiter = createRateLimiter({
    points: 1,
    duration: 60,
    keyPrefix: 'test:oauth:register:ip',
    keyResolver: ipKey,
  })
  // Per-user MCP limiter wrapped so we can observe whether it ran.
  const inner = createRateLimiter({
    points: 100,
    duration: 60,
    keyPrefix: 'test:mcp:user',
    keyResolver: userIdKey,
  })
  const mcpLimiter = (
    req: Parameters<typeof inner>[0],
    res: Parameters<typeof inner>[1],
    next: Parameters<typeof inner>[2],
  ): void => {
    mcpLimiterCalls()
    inner(req, res, next)
  }

  // Per-IP /oauth/authorize + /oauth/token limiter: 1 request / 60s so the
  // second hit is a 429. Same construction as the production default
  // (resolveLimiters) — only the point ceiling differs.
  const oauthLimiter = createRateLimiter({
    points: 1,
    duration: 60,
    keyPrefix: 'test:oauth:as:ip',
    keyResolver: ipKey,
  })

  server = createApp({ authLimiter, mcpLimiter, registerLimiter, oauthLimiter }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
  resetEnvCache()
  delete process.env.BASE_URL
})

describe('/auth/login per-IP rate limit', () => {
  it('429s the second login from the same IP with Retry-After', async () => {
    const body = JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password-123' })
    const headers = { 'content-type': 'application/json' }
    // First request: passes the limiter, reaches the handler (a 401 for unknown
    // credentials — the point is it is NOT a 429).
    const first = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers, body })
    expect(first.status).not.toBe(429)
    // Second request from the same IP: the per-IP bucket is exhausted -> 429.
    const second = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers, body })
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await second.json()).toEqual({ error: 'rate_limited' })
  })
})

describe('/oauth/register per-IP rate limit', () => {
  it('429s the second registration from the same IP with Retry-After', async () => {
    // An invalid body: the limiter runs BEFORE the handler, so the first
    // request consumes a point and is rejected at the schema boundary (400 —
    // no DB is reached); the second is throttled before validation.
    const body = JSON.stringify({ redirect_uris: [] })
    const headers = { 'content-type': 'application/json' }
    const first = await fetch(`${baseUrl}/oauth/register`, { method: 'POST', headers, body })
    expect(first.status).toBe(400)
    const second = await fetch(`${baseUrl}/oauth/register`, { method: 'POST', headers, body })
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await second.json()).toEqual({ error: 'rate_limited' })
  })
})

describe('/oauth/authorize + /oauth/token shared per-IP rate limit', () => {
  it('429s the second OAuth AS request from the same IP with Retry-After', async () => {
    // A schema-invalid query: the limiter runs BEFORE the handler, so the
    // first request consumes the point and is rejected at the schema boundary
    // (400 — no DB is reached); the second is throttled before validation.
    const first = await fetch(`${baseUrl}/oauth/authorize?client_id=x`)
    expect(first.status).toBe(400)
    // The bucket is SHARED across the AS surface: the token endpoint 429s too.
    const second = await fetch(`${baseUrl}/oauth/token`, { method: 'POST' })
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await second.json()).toEqual({ error: 'rate_limited' })
  })
})

describe('/mcp per-user limiter ordering', () => {
  it('does NOT run the limiter for an unauthenticated request (auth gates first)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' })
    expect(res.status).toBe(401)
    // The Bearer guard rejected before the per-user limiter could consume a point.
    expect(mcpLimiterCalls).not.toHaveBeenCalled()
  })
})
