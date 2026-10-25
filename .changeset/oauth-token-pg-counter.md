---
"@3ngram/server": minor
---

The `/oauth/token` progressive-delay failure counter now follows `RATE_LIMIT_STORE` (#315): Redis keeps its MULTI INCR+EXPIRE counter, Postgres uses the sliding-window counter on `rate_limits`, and the per-process Map is used only for the memory store. Threshold, backoff cap and the 900 s sliding window are unchanged, and store errors still fail open with a warning. `oauthTokenRouter` takes `rateLimitStore` in place of `redis`, and `setExchangeFailureStore` replaces `setExchangeFailureRedis`. Closes #315.
