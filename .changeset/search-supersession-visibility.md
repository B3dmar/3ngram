---
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/schema": minor
"@3ngram/server": minor
"@3ngram/eval": minor
---

Fix `search` to demote every superseded predecessor, and label demoted hits.

The supersession tier-penalty in `search` only fired for a `supersedes` edge — a revision recorded with the `updates` edge kind closed its predecessor's validity exactly the same way, but escaped the ranking demotion entirely, so a superseded row could still outrank its live successor. The penalty now applies whenever a row has an incoming `supersedes` or `updates` edge, matching the existing `CLOSES_PREDECESSOR` convention used elsewhere for the same two edge kinds.

Search hits (both MCP and REST, full and compact projections) now also carry a `superseded: boolean` flag, so a caller can tell a demoted result from a current one instead of inferring it from score alone. Ranking stays supersession-*aware*, never supersession-*filtered*: a demoted row is still returned, just ranked below its successor and now labeled as such.
