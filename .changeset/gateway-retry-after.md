---
"@3ngram/llm": patch
---

`GatewayRequestError` now carries `retryAfterMs`, the provider's `Retry-After` header in milliseconds (delta-seconds or an HTTP date), so a caller can wait out a 429 instead of guessing. The message and `status` are unchanged; the header is the only new thing read, never the response body.
