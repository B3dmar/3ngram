---
'@3ngram/schema': patch
'@3ngram/db': minor
---

Add `agent_sessions` and a `memory_events` sessionRunId index (issue #166 step 2). Import payloads reject the reserved `sessionRunId` key.
