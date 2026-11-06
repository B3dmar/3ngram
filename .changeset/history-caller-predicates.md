---
"@3ngram/db": minor
"@3ngram/core": patch
---

Add caller-bound `user_id` predicates to all six memory history reads behind `GET /api/v1/memories/{id}/history` (inspected memory and its commitment, direct relationships, the lineage walk's seed, step and node join, lineage edges, audit events, and the creating session run) as a second tenant-isolation layer alongside RLS (defense in depth, issue #427). Direct relationships now bind to the caller instead of the inspected row's owner. Result sets are unchanged while RLS functions.

Breaking for direct `@3ngram/db` consumers: `getMemoryHistory` now takes the caller's `userId` as its second argument, `getMemoryHistory(tx, userId, memoryId)`, and binds every statement to it. Pass the same id given to `withTenant()`; a call that still uses `getMemoryHistory(tx, memoryId)` fails to compile in TypeScript, and fails at runtime in JavaScript. The `@3ngram/core` `getMemoryHistory(userId, memoryId)` signature and the REST route are unchanged.
