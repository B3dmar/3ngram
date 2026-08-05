---
"@3ngram/server": patch
"@3ngram/core": patch
"@3ngram/db": patch
"@3ngram/schema": patch
"@3ngram/config": patch
"@3ngram/llm": patch
---

Raise the supported Node floor to 24 (Active LTS). Node 22 entered maintenance on 2025-10-21 and receives security fixes only; Node 24 has been Active LTS since 2025-10-28. `engines.node` moves to `>=24`, CI and the release workflow test on 24, and the server image base moves to `node:24-bookworm-slim`.
