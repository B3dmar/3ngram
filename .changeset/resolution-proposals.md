---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
---

Add resolution proposals, the session closer's mid band (issue #229). On the typed-judgment path, a briefed commitment judged plausibly completed (0.5 ≤ p < 0.9) is staged in the new `resolution_proposals` table instead of being resolved. The table (migration 0043) has RLS and FORCE RLS, holds one open proposal per commitment, has tenant-composite foreign keys to the memory and the session run, and is included in the export. `review_proposals` lists the new kind (output V3): `resolutionProposals` appears only when it is non-empty, `counts`/`totals` gain a `resolution` key, and accept/reject return `applied_resolution`/`rejected_resolution`. Accepting resolves the commitment through the shipped resolve path, recorded as the reviewer. The input and the tool description are unchanged. Self-hosters need the usual migration step.
