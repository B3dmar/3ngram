---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
---

Add a per-tenant judgment opt-in (issue #225). The new table `user_judgment_policy` (migration 0042) has RLS and FORCE RLS, and its runtime grant is SELECT/INSERT/UPDATE. Core adds `isJudgmentEnabled`, `getJudgmentPolicy` and `setJudgmentPolicy`, and REST adds `GET` and `PUT /api/v1/settings/judgment`. The default is `off`, and there is no MCP surface. Account erasure resets the opt-in to `off`, and the account export includes it as `judgmentPolicy`. Nothing reads the opt-in yet. Each change appends a content-free `audit_log` row (`settings.judgment.set`, mode only) as a consent record.

Self-hosters need the usual migration step. It creates the table and re-runs `provision-roles.sql`, which grants `app_user` access to it.
