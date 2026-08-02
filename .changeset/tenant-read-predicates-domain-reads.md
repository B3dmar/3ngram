---
"@3ngram/db": patch
"@3ngram/core": patch
---

Add caller-bound `user_id` predicates to the briefing, facts, and dashboard memory reads (open/overdue commitments, live-memory and stale-candidate sections, getFacts, count/list/facets, getMemoryById) as a second tenant-isolation layer alongside RLS (defense in depth). Result sets are unchanged while RLS functions.
