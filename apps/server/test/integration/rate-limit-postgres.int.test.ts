// SPDX-License-Identifier: Apache-2.0
// RATE_LIMIT_STORE=postgres end to end (#315): the in-process app over the
// REAL runtime role writes limiter buckets and the /oauth/token failure
// counter to the migration-created rate_limits table.
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { contentDigest } from '@3ngram/config'
import { closeDb } from '@3ngram/core'
import { createFakeGateway } from '@3ngram/llm'
import { afterAll, describe, expect, it } from 'vitest'
import { closePools, ownerPool } from '../../../../packages/db/test/integration/helpers.js'
import { type AppOptions, createApp } from '../../src/app.js'
import { createRateLimiter, ipKey } from '../../src/middleware/rate-limit.js'

const gateway = createFakeGateway()
const servers: Server[] = []
const testPrefix = `t-${randomUUID()}`

async function listen(options: AppOptions): Promise<string> {
  const server = createApp({ gateway, rateLimitStore: { kind: 'postgres' }, ...options }).listen(0)
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return `http://127.0.0.1:${address.port}`
}

async function countRows(pattern: string): Promise<number> {
  const { rows } = await ownerPool.query<{ n: string }>(
    'SELECT count(*) AS n FROM rate_limits WHERE key LIKE $1',
    [pattern],
  )
  return Number(rows[0]?.n)
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (s) => new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve()))),
    ),
  )
  await ownerPool.query(
    "DELETE FROM rate_limits WHERE key LIKE $1 OR key LIKE 'edge:ip:%' OR key LIKE 'oauth:%'",
    [`${testPrefix}%`],
  )
  await closeDb()
  await closePools()
})

describe('RATE_LIMIT_STORE=postgres through the app (runtime role, real DB)', () => {
  it('writes the edge per-IP bucket to rate_limits', async () => {
    const baseUrl = await listen({})
    await fetch(`${baseUrl}/no-such-route`)
    expect(await countRows('edge:ip:%')).toBeGreaterThan(0)
  })

  it('returns 429 with Retry-After once a postgres bucket is spent', async () => {
    const edgeLimiter = createRateLimiter({
      points: 2,
      duration: 60,
      keyPrefix: testPrefix,
      keyResolver: ipKey,
      store: { kind: 'postgres' },
    })
    const baseUrl = await listen({ edgeLimiter })
    const statuses: number[] = []
    let retryAfter: string | null = null
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/no-such-route`)
      statuses.push(res.status)
      retryAfter = res.headers.get('retry-after')
    }
    expect(statuses[2]).toBe(429)
    expect(statuses.slice(0, 2)).not.toContain(429)
    expect(Number(retryAfter)).toBeGreaterThan(0)
  })

  it('records a failed /oauth/token exchange in the window counter', async () => {
    const baseUrl = await listen({})
    const clientId = `nope-${randomUUID()}`
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // Schema-valid but for an unknown client, so client auth fails.
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: 'x',
        code_verifier: 'a'.repeat(43),
        redirect_uri: 'https://client.example/cb',
      }).toString(),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await countRows(`oauth:exchange-failure:${contentDigest(clientId)}`)).toBe(1)
  })
})
