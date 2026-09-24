---
"@3ngram/db": patch
"@3ngram/worker": patch
---

Consolidation no longer re-proposes a settled pair. `findSimilarPairs` now excludes any candidate pair that already carries a proposal (proposed, applied or rejected) or a materialized edge, in either orientation. A rejection is final for that pair and an applied `extends`/`derives` edge is not proposed again on the next hourly run (issue #220).
