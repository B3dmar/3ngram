---
'@3ngram/db': minor
---

db: add the `fact_proposals` staging table (migration 0031)

A staging area so extracted facts are human-reviewed before becoming queryable
truth. Candidates land in `fact_proposals` with a `proposed` status and only
reach `facts` once accepted, which keeps the structured projection something a
reader can trust without re-checking its source.

Shape follows the shipped memory tables: explicit `user_id`, a tenant-qualified
composite FK `(user_id, memory_id)` → `memories`, `user_id`-leading indexes, a
`tenant_isolation` policy with the NULLIF guard, and FORCE row level security so
a wrong-role connection fails closed. A partial unique index allows one open
proposal per `(memory, subject, predicate, value)` while still permitting
re-proposal after a rejection, and the status/memory-type CHECKs are generated
from the `@3ngram/schema` enums rather than restated in SQL.

`fact_proposals` is a sibling of `consolidation_proposals`, not a new mode on
it: every shipped database object is left byte-identical. Grants are
SELECT/INSERT/UPDATE only — a decision flips a status, it never deletes a row.

Deploy note: creating the composite foreign key takes a brief lock on
`memories`, so on a busy database the migration can queue behind a long-running
transaction. Run it with a `lock_timeout` and retry rather than letting it
block writes.
