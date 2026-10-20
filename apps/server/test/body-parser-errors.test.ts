// SPDX-License-Identifier: Apache-2.0
// express.json() rejects a request body before any route runs. Each rejection
// is a client error with a stable code, never the generic 500 (issue #301):
// malformed JSON or a corrupt gzip body -> 400, over the 100 KB default limit
// -> 413, unsupported content encoding -> 415. The app-level parser sits in front of both metered
// transports, so /mcp and /api/v1 are covered by the same handler.
import type { Server } from 'node:http'
import { resetEnvCache } from '@3ngram/config'
import { afterEach, describe, expect, it } from 'vitest'
import type { RateLimiterMiddleware } from '../src/middleware/rate-limit.js'

const passThrough: RateLimiterMiddleware = (_req, _res, next) => next()

interface Harness {
  server: Server
  baseUrl: string
}

async function startApp(): Promise<Harness> {
  resetEnvCache()
  const { createApp } = await import('../src/app.js')
  const server = createApp({
    apiKeyLimiter: passThrough,
    authLimiter: passThrough,
    signupLimiter: passThrough,
    resendVerificationLimiter: passThrough,
    verifyEmailLimiter: passThrough,
    forgotPasswordLimiter: passThrough,
    resetPasswordLimiter: passThrough,
    mcpLimiter: passThrough,
    oauthLimiter: passThrough,
    registerLimiter: passThrough,
  }).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function stopApp(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((err) => (err === undefined ? resolve() : reject(err)))
  })
}

const JSON_HEADERS = { 'content-type': 'application/json' }
// Comfortably over body-parser's 100 KB default limit.
const OVERSIZED_BODY = JSON.stringify({ content: 'x'.repeat(200_000) })
let current: Harness | undefined

afterEach(async () => {
  if (current !== undefined) {
    await stopApp(current)
    current = undefined
  }
  resetEnvCache()
})

describe('rejected request bodies (#301)', () => {
  it('413 payload_too_large for an oversized body on /mcp', async () => {
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, accept: 'application/json, text/event-stream' },
      body: OVERSIZED_BODY,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
  })

  it('413 payload_too_large for an oversized body on a REST route', async () => {
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/api/v1/memories`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: OVERSIZED_BODY,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
  })

  it('415 unsupported_media_type for an unsupported content encoding', async () => {
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'content-encoding': 'bogus' },
      body: '{}',
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported_media_type' })
  })

  it('400 invalid_request for a corrupt gzip body', async () => {
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'content-encoding': 'gzip' },
      body: 'this is not gzip',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_request' })
  })

  it('400 invalid_request for a malformed JSON body (unchanged contract)', async () => {
    current = await startApp()
    const res = await fetch(`${current.baseUrl}/auth/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{ not valid json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_request' })
  })
})
