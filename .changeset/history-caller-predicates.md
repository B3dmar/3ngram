---
"@3ngram/db": patch
"@3ngram/core": patch
---

Add caller-bound `user_id` predicates to all six memory history reads behind `GET /api/v1/memories/{id}/history` (inspected memory and its commitment, direct relationships, the lineage walk's seed, step and node join, lineage edges, audit events, and the creating session run) as a second tenant-isolation layer alongside RLS (defense in depth, issue #427). Direct relationships now bind to the caller instead of the inspected row's owner. `getMemoryHistory` in `@3ngram/db` takes the caller's `userId` after `tx`; the `@3ngram/core` function is unchanged. Result sets are unchanged while RLS functions.
