---
---

Test-only: make the US4 auth abuse-hardening harness deterministic under load (#297) — load the app once at collection time, bind the listener to the fetched loopback address, and close each request's connection.
