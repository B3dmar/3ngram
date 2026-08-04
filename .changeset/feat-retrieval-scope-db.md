---
'@3ngram/schema': minor
'@3ngram/db': minor
---

Per-user retrieval-scope policy store (issue #47, layer 1 of 3): a new `user_retrieval_policy` table (one optional row per user; RLS + FORCE, tenant-isolation policy, Zod-derived mode CHECK and a mode↔scope consistency CHECK — `default` requires a scope, `require`/`off` forbid one) with `getRetrievalPolicy`/`upsertRetrievalPolicy` accessors under `withTenant()`. The schema contract lands in a bounded `retrieval-scope` module: the `set_retrieval_default` `configure_scope` action variant composed onto the shipped action union (shipped variants byte-identical, no new tool slot), the `retrieval_default_set` output variant, and the additive `describe_environment` `retrievalScopePolicy` report field. Storage + contracts only — no read-path behavior changes until the core enforcement layer.
