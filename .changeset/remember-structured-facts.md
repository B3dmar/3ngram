---
'@3ngram/schema': minor
'@3ngram/core': minor
---

core: accept structured facts on remember

A write can now carry the facts it asserts. `remember` takes an optional
`facts` list of `{subject, predicate, value}` triples with an optional
confidence and valid-time window, and returns their ids alongside the memory's.
The facts are persisted in the same transaction as the memory, so a claim and
its source can never be half-written.

`rememberWithFactsInputSchema` is composed BESIDE the shipped
`rememberInputSchema` rather than replacing it. That separation is what keeps
`revise` rejecting a `facts` key: facts belong to the assertion that introduced
them, and a revision appends a new memory, so silently carrying facts across
would attribute them to the wrong row.

The per-fact contract mirrors the import path minus the fields a fresh write
already knows — no `memoryId` (the memory is being written in the same call) and
no `recordedAt` (knowledge time is now, by definition). Validity is stricter
than the `facts` table alone requires: a `validTo` demands a `validFrom`, so a
window that ends but never begins is a field-level error rather than a
constraint violation later. At most 16 facts per write; an empty list is
equivalent to omitting the key, and both return no fact ids.

Transports are unchanged in this release and still reject a `facts` key at
their own boundary — core accepts it ahead of the MCP and REST surface.
