---
"@3ngram/db": patch
---

Fix the migrator's `provision-roles.sql` execution: run it over the pg simple query protocol (a plain-string `client.query`) instead of `db.execute(sql.raw(...))`, which uses the extended protocol and rejects the file's `DO $$…$$` block and multi-statement body. The migrator now also substitutes the runtime role from `RUNTIME_DB_ROLE` (default `app_user`) so a re-provisioned NOBYPASSRLS role is granted correctly, and the `ALTER ROLE … NOBYPASSRLS` re-assertion is tolerant of managed Postgres (Neon) where the provisioning role lacks privilege to change BYPASSRLS.
