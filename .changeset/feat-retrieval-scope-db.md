---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

Per-user retrieval-scope policy store (issue #47, layer 1 of 3): a new `user_retrieval_policy` table (one optional row per user; RLS + FORCE, tenant-isolation policy, Zod-derived mode and consistency CHECKs) with `getRetrievalPolicy`/`upsertRetrievalPolicy` accessors under `withTenant()`. The policy is included in account portability exports and reset to the inert `off` state during tombstone-style account erasure. The schema contract lands in a bounded `retrieval-scope` module: the `set_retrieval_default` `configure_scope` action variant composed onto the shipped action union, the `retrieval_default_set` output variant, and the additive `describe_environment` `retrievalScopePolicy` report field. Storage + contracts only; read-path enforcement remains in the stacked core layer.
