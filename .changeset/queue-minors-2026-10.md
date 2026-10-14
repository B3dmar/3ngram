---
"@3ngram/worker": patch
---

Bump the worker's queue stack: `bullmq` from 5.78.0 to 5.81.5, the newest 5.x release, and `ioredis` from 5.10.1 to 5.11.1, the version bullmq 5.81.5 pins and `@3ngram/server` already runs, so the lockfile now carries one ioredis copy. Both are past the 7-day release-age cooldown. The retry, terminal-removal and custom job id checks the worker's comments cite are unchanged in 5.81.5; the range adds blocking-connection recovery after a Redis or Sentinel disconnect, `upsertJobScheduler` fixes for `every` offsets and same-id re-upserts (the worker's schedulers use `pattern`), and fails, rather than requeues, a stalled job whose scheduler was removed. Since 5.81.2 BullMQ drops connection errors that no `error` listener receives, so the worker's Queue and Worker now register one each and log only the error name and queue name at `warn`: never the error object or its message, which can quote stored job data.
