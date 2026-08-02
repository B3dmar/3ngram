---
"@3ngram/db": patch
---

Tenant-isolation hardening (defense in depth): FORCE row-level security on the twelve withTenant()-only tenant-data tables so policies also bind the table owner, re-assert NOBYPASSRLS on the runtime role on every provisioning run, and add a tenant-isolation policy to audit_log that pins tenant-bound transactions to their own rows while keeping the tenant-less system insert path open.
