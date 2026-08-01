---
"@3ngram/db": patch
---

Add caller-bound `user_id` predicates to all ten tenant-table reads in the account data export (memories, facts, commitments, scopes, memory_edges, memory_events, consolidation_proposals, user_budgets, llm_usage, user_profile_attributes) as a second tenant-isolation layer alongside RLS (defense in depth). The user-profile read is now keyed on `user_id` instead of a bare limit. Result sets are unchanged while RLS functions.
