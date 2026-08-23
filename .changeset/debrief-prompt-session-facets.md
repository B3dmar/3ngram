---
'@3ngram/server': patch
---

`GET /api/v1/prompts/debrief` resolves `scope` and `project` from the session row when the query omits them. A caller that reconstructs the facets from its own environment cannot know a scope a tenant retrieval policy narrowed a `kind=all` briefing to, so the rendered prompt could name a scope the run was never briefed under — and an omitted `scope` on the resulting `remember` defaults to `personal`, filing the debrief outside the briefing that surfaced the work. An explicit query facet still wins; a row facet that is null renders the key absent, not `null`.
