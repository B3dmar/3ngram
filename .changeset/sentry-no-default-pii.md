---
"@3ngram/config": patch
---

Pin Sentry `sendDefaultPii` off on the engine observability init. That is the 10.x opt-out: no user info, HTTP bodies, database query data, or genAI inputs and outputs.
