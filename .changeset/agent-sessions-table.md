---
'@3ngram/core': patch
'@3ngram/schema': patch
'@3ngram/db': minor
'@3ngram/server': patch
---

Add `agent_sessions` and a `memory_events` sessionRunId index (issue #166 step 2). Import payloads reject the reserved `sessionRunId` key. Account erasure redacts session rows in place; the GDPR export includes them.
