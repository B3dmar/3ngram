---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': patch
'@3ngram/server': patch
---

Native writes accept optional `sessionRunId` and stamp `{ sessionRunId }` on audit events. Import still rejects the key. Unknown run ids fail the write; an explicitly closed row succeeds unattributed; a stale lease resurrects then attaches. Omitted id uses the single leased-open session for the project.
