---
"@3ngram/server": minor
"@3ngram/config": minor
---

`RATE_LIMIT_STORE=redis|postgres|memory` selects the server's rate-limiter store (#315). `postgres` backs every limiter with the `rate_limits` table on `DATABASE_URL`, and production then accepts a missing `REDIS_URL`. `redis` requires `REDIS_URL` and `postgres` requires `DATABASE_URL` in every environment. Unset keeps today's behaviour: Redis when `REDIS_URL` is set, in-memory outside production, a validation error in production. `memory` in production is an explicit single-replica opt-in that logs a boot warning; the server also refuses an implicit memory store in production at boot. `createRateLimiter` takes `store` in place of `redis`. Refs #315.
