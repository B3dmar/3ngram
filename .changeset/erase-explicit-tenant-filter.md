---
"@3ngram/db": patch
---

Give every statement in `eraseAccountData` an explicit `user_id` predicate (#494). Row-level security stays the primary tenant boundary; the predicate makes an erasure run on a connection that bypasses RLS (a table owner, a migration, an operator script) still touch only the target account. No behaviour change for the self-serve path, which runs as the NOBYPASSRLS runtime role.
