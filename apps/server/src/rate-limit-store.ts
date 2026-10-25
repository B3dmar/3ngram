// SPDX-License-Identifier: Apache-2.0
// Resolve the rate-limiter backing store once at boot (#315). Env validation
// already refuses an implicit memory store in production; this re-checks it
// (defence in depth) so no code path makes memory a silent production default.
import { loadEnv, loadRateLimitStoreConfig, log } from '@3ngram/config'
import type { Redis } from 'ioredis'
import type { RateLimitStore } from './middleware/rate-limit.js'
import { resolveRedis } from './redis.js'

export class MemoryRateLimitStoreInProductionError extends Error {
  override name = 'MemoryRateLimitStoreInProductionError'
}

/**
 * Pick the store from RATE_LIMIT_STORE (unset: redis iff REDIS_URL, else
 * memory). `redis` is the already-resolved client, if any; it is reused so the
 * process dials Redis at most once.
 */
export function resolveRateLimitStore(redis: Redis | undefined): RateLimitStore {
  const { kind, explicit } = loadRateLimitStoreConfig()
  const production = loadEnv().NODE_ENV === 'production'
  let store: RateLimitStore
  if (kind === 'redis') {
    const client = redis ?? resolveRedis()
    // Unreachable after env validation; fail closed rather than fall back.
    if (client === undefined) throw new Error('rate-limit: redis store selected without REDIS_URL')
    store = { kind: 'redis', client }
  } else if (kind === 'postgres') {
    store = { kind: 'postgres' }
  } else {
    if (production && !explicit) {
      throw new MemoryRateLimitStoreInProductionError(
        'rate-limit: in-memory store refused in production; set RATE_LIMIT_STORE=postgres or REDIS_URL',
      )
    }
    if (production) {
      log().warn(
        { store: 'memory' },
        'rate-limit: in-memory store in production (per-replica buckets; single replica only)',
      )
    }
    store = { kind: 'memory' }
  }
  log().info({ store: store.kind }, 'rate-limit: store resolved')
  return store
}
