---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
'@3ngram/sdk': minor
'3ngram': minor
---

A `remember` without `scope` now lands where the account's write-scope policy says (issue #235), instead of always landing in `personal`. `configure_scope` gains a `set_write_default` action with the same shape as `set_retrieval_default`: `mode: "off"` (the default, so nothing changes until an account opts in) keeps writing `personal`, `mode: "default"` fills an omitted scope with a registered scope, and `mode: "require"` rejects an unscoped `remember` as invalid input (MCP error, REST 400 with a recovery detail) before anything is written, access- or budget-checked, or embedded. An explicit `scope` always wins. The `remember` response over MCP and REST now echoes the scope the memory was actually written to. `describe_environment` reports the effective policy as `writeScopePolicy` next to `retrievalScopePolicy`. Renaming a registry scope carries the write default along; deleting it moves the policy to `require`. Aliases are not resolved, so an alias passed to `set_write_default` is rejected as not found. New table `user_write_scope_policy` (migration 0039, RLS + FORCE RLS), included in the account export and reset by account erasure. On the native remember schema `scope` no longer carries a `personal` default, so an omitted scope survives the parse; the base remember schema used by import keeps it.
