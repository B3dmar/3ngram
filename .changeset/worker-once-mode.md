---
"@3ngram/worker": minor
"@3ngram/core": patch
"@3ngram/config": patch
---

Add a one-shot worker entrypoint, `node dist/once.js <consolidation|surfacing|gc-clients>`, for cron-style schedulers (#315). It runs one pass without Redis, closes the database pool, and exits 0 on success, 1 on failure, or 2 for an unknown job. The resident BullMQ worker (`node dist/index.js`) stays the default. `@3ngram/core` re-exports `closeDb`, and `@3ngram/config/otel` adds `flushObservability` to drain Sentry events before a deliberate exit.
