---
"@3ngram/db": minor
"@3ngram/core": minor
---

Add `incrementWindowCounter`, `readWindowCounter` and `deleteWindowCounter`: a sliding-window counter on the `rate_limits` table, re-exported from `@3ngram/core`. Each increment is one atomic upsert that slides the expiry forward, matching the Redis `INCR` + `EXPIRE` semantics of the /oauth/token failure counter; an expired row restarts at 1. Nothing uses it yet. Refs #315.
