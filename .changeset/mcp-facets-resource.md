---
"@3ngram/server": minor
"@3ngram/schema": minor
"@3ngram/core": minor
"@3ngram/db": minor
---

New MCP resource `threengram://facets` (issue #168): an agent or host can read the tenant's live scope and project names as `{ scopes, projects }` without already knowing them and without a new tool. It is the same payload as REST `GET /api/v1/memories/facets`, the one entry `resources/list` now returns (the memory template stays unlisted, so the corpus is still not enumerable), and it caches `private` with a 60-second TTL because the inventory changes as memories are filed, moved and superseded. The `resources/list` catalog entry itself caches `public` like the other catalogs. `describe_environment` inlines the same inventory as `facets` for hosts that never surface resources to the model, capped at `MAX_INLINE_FACET_LABELS` (50) labels per array in ascending order, with `truncated: { scopes, projects }` flagging a capped list; the resource and REST facets stay complete. `scopes` lists scopes that hold live memories; a registered scope with none is reported by `configure_scope list`, not here. A read-only token may read it; the tenant comes from the verified token and read access is asserted before the read. New exports: `describeEnvironmentOutputV4Schema`, `environmentFacetsSchema` and `MAX_INLINE_FACET_LABELS` (`@3ngram/schema`), an optional per-array `limit` on `listMemoryFacets` (`@3ngram/db`), and the `facets` field (`InlineFacets`) on core's `EnvironmentReport`. No `list_projects` tool; the tool description is unchanged.
