// SPDX-License-Identifier: Apache-2.0
// The single ioredis client, constructed once at boot from REDIS_URL and injected
// into the rate limiters. Mirrors the resolveGateway seam in
// app.ts: tests inject nothing (the limiters fall back to RateLimiterMemory), so
// NO real Redis is ever required in CI.
//
// The client is shared with the BullMQ workers (ioredis is
// BullMQ-compatible), so it lives at the app root rather than inside the limiter
// module. REDIS_URL is a credential — it is never logged (hard rule 6); only the
// connection lifecycle (lazy connect, retry) is observable.
import { loadEnv, log } from '@3ngram/config'
import { Redis } from 'ioredis'

/**
 * Construct the boot Redis client iff REDIS_URL is set, else undefined ("not
 * configured" — the limiters then use an in-memory store). Lazy-connect so import
 * never blocks on a network dial; a redacted error is logged on connection
 * failure and the limiter's fail-open path keeps the API serving. The URL is
 * passed straight into ioredis and never echoed.
 */
export function resolveRedis(): Redis | undefined {
  const { REDIS_URL } = loadEnv()
  if (REDIS_URL === undefined) return undefined
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    // Do not let a single command hang forever when Redis is unreachable; the
    // limiter then sees a store error and fails open.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  })
  client.on('error', (err: Error) => {
    // The connection string is a credential; log the error NAME only.
    log().warn({ err: err.name }, 'redis: client error')
  })
  return client
}
