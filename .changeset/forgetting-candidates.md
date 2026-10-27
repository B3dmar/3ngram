---
"@3ngram/db": minor
---

Add the forgetting pass's candidate reads (docs/concepts/forgetting-pass.mdx, "Candidate query"). Nothing calls them yet: the pass ships later, default off.

- **`staleSingles`** uses briefing's stale predicate over the whole tenant, most stale first. It skips a memory that has an open retention proposal, or a verdict newer than its last change. A conflict verdict counts for both sides.
- **`newerNeighbours`** lists up to N newer live memories of the same type and scope beside each single, nearest first. It overfetches from the index and keeps the nearest N, because the iterative HNSW scan can return slightly out of order.
- **`conflictPairs`** pairs two live memories of the same type, scope and project at or above a similarity floor, oriented newer first, with pairs whose older side is stale ranked first. It skips pairs that already have an edge, a consolidation proposal, an open retention proposal on either side, or a verdict newer than both memories' last change.

Every read cuts content to the caller's limit. Types, windows, floors and caps are the caller's policy.
