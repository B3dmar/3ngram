---
'@3ngram/db': minor
---

db: write structured facts atomically with the memory that asserts them

`writeMemory` takes an optional list of facts and inserts them in the SAME
transaction as the memory and its audit event, returning their ids on
`WrittenMemory.factIds`. A fact whose source memory rolled back would be an
unsourced claim in the structured projection, and a memory whose facts silently
vanished would be a claim nobody can query — neither is now representable.

Facts are written for every memory type. The commitment auto-create is an early
return in `writeMemory`, so the insert deliberately sits before it: a commitment
memory comes back with both its `commitmentId` and its `factIds`.

The column-level inserts move to a new tx-taking `insertFact`/`insertFacts` pair
that composes inside a caller's transaction, following the existing
`insertEdge` split. The import path keeps its own wrapper — the tenant
transaction and the typed not-found probe are what make it import-specific — and
now delegates the columns, so both write paths cannot drift apart. A write that
supplies no facts is unchanged down to the returned object, which omits
`factIds` entirely rather than returning an empty array.
