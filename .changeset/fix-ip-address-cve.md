---
'@3ngram/server': patch
---

Security: force transitive `ip-address` to 10.3.1 (CVE-2026-69192, HIGH — via `express-rate-limit` → `@modelcontextprotocol/server-legacy`) with a scoped pnpm override, matching the repo's advisory-fix pattern. The vulnerable 10.2.0 resolution blocked the v1.2.0 release image scan (fail-closed; nothing was published).
