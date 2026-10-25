---
"@3ngram/config": minor
"@3ngram/worker": patch
---

`loadEnv` and `parseEnv` take an optional `{ role: 'server' | 'worker' }`. The worker now validates its env as role `worker`, which skips the server-only production requirements: `OAUTH_JWKS` (the worker signs no tokens) and `REDIS_URL` (only the server's rate limiter needs it; the resident BullMQ worker still fails at boot without it). `BASE_URL`, `LOG_HASH_SALT` and the `DATABASE_URL` checks still apply. With no argument, `loadEnv()` behaves as before (server role), and asking for a different role once the env is resolved throws. Closes #204, refs #315.
