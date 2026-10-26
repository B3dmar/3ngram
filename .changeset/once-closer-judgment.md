---
"@3ngram/worker": patch
---

The one-shot `session-sweep` (`node dist/once.js session-sweep`) now gives its closers the Jev judgment gateway when `JEV_API_KEY` and `JEV_MODEL` are set, as the resident worker does. Before this, the one-shot build dropped it, so tenants opted in to typed judgment (#225, #229) silently fell back to the `complete()` path on a cron schedule. Both worker modes now build the closer's gateway and budget with one shared function (`src/closer-deps.ts`).
