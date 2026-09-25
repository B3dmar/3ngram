---
"@3ngram/db": patch
---

Migration `0038_memory_edges_target_idx` adds `memory_edges_target_idx (user_id, to_id, edge_type)`, so every "which edges point at this memory" lookup (search's `superseded` flag, `get_memories`' `supersededBy`, REST history's direct relationships) is index-served instead of scanning the tenant's edges; the REST history edge scan is also bound to the caller's tenant explicitly so the index applies there too. `get_memories` also resolves the successor with one lateral lookup per row instead of two correlated subselects. Measured on a 5,000-memory, 20,000-edge tenant, a 20-id `get_memories` batch drops from 51 ms and 12,328 shared buffers to 0.2 ms and under 100 (issue #240). The index is created in the migration transaction (no CONCURRENTLY), which blocks writes to `memory_edges` for the build; at current table sizes that is sub-second, the same trade-off migration 0033 made.
