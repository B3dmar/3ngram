---
"@3ngram/db": minor
"@3ngram/core": minor
---

Add the `rate_limits` system table (migration 0039, no RLS; `provision-roles.sql` grants the runtime role SELECT, INSERT, UPDATE and DELETE on it) and `createPostgresRateLimiter`, a `rate-limiter-flexible` Postgres limiter over that table, re-exported from `@3ngram/core`. It runs no DDL at runtime, sends every query unnamed so it works behind a transaction-mode pooler, runs one expired-row sweeper per process, and has no in-memory fallback. Nothing uses it yet. Refs #315.
