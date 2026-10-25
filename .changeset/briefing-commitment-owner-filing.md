---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

Briefing commitment items now carry `owner`, `scope` and `project` (issue #261). `owner` is the recorded owner label, or `null` when none was recorded; it is never inferred from content. `scope` and the nullable `project` are the riding memory's filing, read in the same join as the rest of the item, so the MCP `briefing` tool and `GET /api/v1/briefing` let a reader label ownership and filing (including an unscoped `project: null` row under `includeUnscoped`) without reading each memory back. Counts, ordering and selector semantics are unchanged.
