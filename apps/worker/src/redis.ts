// SPDX-License-Identifier: Apache-2.0
// The worker's OWN ioredis connection.
//
// This is NOT apps/server/src/redis.ts. That client is tuned for the rate
// limiter — maxRetriesPerRequest:1, lazyConnect, enableOfflineQueue:false — so a
// dead Redis fails the limiter OPEN without hanging a request. BullMQ has the
// OPPOSITE requirement: it REQUIRES maxRetriesPerRequest:null on the connection
// it blocks on (BRPOPLPUSH / blocking reads), and refuses to start otherwise.
// Sharing the server's client would either break BullMQ or weaken the limiter,
// so the worker constructs its own.
//
// REDIS_URL is schema-validated by @3ngram/config (prod-required there). It is a
// credential — never logged (hard rule 6); only the connection lifecycle (error
// name, close) is observable.
import { loadEnv, log } from '@3ngram/config'
import { Redis } from 'ioredis'

/**
 * Thrown at boot when the worker has no REDIS_URL. Unlike the server (where the
 * limiter falls back to an in-memory store), the worker has NOTHING to do
 * without a queue backend — BullMQ is its entire reason to exist — so a missing
 * URL is a hard, fail-fast boot error, not a degraded mode.
 */
export class MissingRedisUrlError extends Error {
  constructor() {
    super('REDIS_URL is required to run the background worker (BullMQ has no in-memory mode)')
    this.name = 'MissingRedisUrlError'
  }
}

/**
 * Construct the worker's BullMQ-compatible ioredis client from REDIS_URL.
 *
 * maxRetriesPerRequest:null is MANDATORY for BullMQ (its blocking commands must
 * not be aborted by ioredis's per-request retry cap). enableReadyCheck:false is
 * BullMQ's recommended setting against managed Redis providers that disable the
 * INFO command. The URL is passed straight into ioredis and never echoed; only
 * the error NAME is logged.
 *
 * @throws {@link MissingRedisUrlError} when REDIS_URL is unset.
 */
export function createRedis(): Redis {
  const { REDIS_URL } = loadEnv()
  if (REDIS_URL === undefined) throw new MissingRedisUrlError()
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })
  client.on('error', (err: Error) => {
    // The connection string is a credential; log the error NAME only.
    log().warn({ err: err.name }, 'worker: redis client error')
  })
  return client
}
