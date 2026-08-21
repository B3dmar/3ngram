---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': patch
'@3ngram/server': patch
'@3ngram/sdk': minor
---

Native writes accept optional `sessionRunId` and stamp `{ sessionRunId }` on audit events. Import still rejects the key. Unknown run ids fail the write; an explicitly closed row succeeds unattributed and is never resurrected; a stale lease resurrects then attaches, and a successful attach refreshes the lease. Omitted id uses the single leased-open session for the project. `POST /api/v1/memories/:id/archive` gains an optional body carrying the same field, and the SDK's `resolve()` takes an optional `{ sessionRunId }`.
