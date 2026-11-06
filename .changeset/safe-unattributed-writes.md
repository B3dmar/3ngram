---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/sdk": minor
"@3ngram/server": minor
---

Accept explicit `sessionRunId: null` on native memory writes to skip session attribution without changing any session's lease, triage state, or closer eligibility. Omitted IDs retain automatic attribution; supplied IDs still require tenant ownership. This lets agents write to another authenticated account without borrowing an unrelated conversation's session.
