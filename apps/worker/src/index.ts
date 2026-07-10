// SPDX-License-Identifier: Apache-2.0
// Worker entrypoint. Load order is a contract
// (config/otel.ts, mirrors apps/server/src/index.ts): Sentry's OTel
// auto-instrumentation must initialize BEFORE the modules it instruments load.
// Static imports are hoisted, so the queue/Redis graph (which pulls in bullmq +
// ioredis) is loaded via DYNAMIC import after initObservability().
import { loadEnv, log } from '@3ngram/config'
import { initObservability } from '@3ngram/config/otel'

initObservability()
loadEnv() // refuse-by-construction: a misconfigured process dies at boot

// Dynamic import keeps the bullmq/ioredis module graph behind initObservability
// (the entrypoint load-order contract). createRedis throws MissingRedisUrlError
// if REDIS_URL is unset — the worker has no degraded mode (BullMQ needs Redis),
// so that is a hard, fail-fast boot error.
const { createRedis } = await import('./redis.js')
const { startQueues, stopQueues } = await import('./queues.js')

const connection = createRedis()
const handles = await startQueues(connection)

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    log().info({ signal }, 'worker: shutting down')
    void stopQueues(handles)
      .then(() => connection.quit())
      .then(() => process.exit(0))
      .catch((err: Error) => {
        log().error({ err: err.name }, 'worker: shutdown failed')
        process.exit(1)
      })
  })
}
