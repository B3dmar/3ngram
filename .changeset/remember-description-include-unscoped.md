---
"@3ngram/server": patch
---

Correct the `remember` tool description, which had gone stale after the combined selector shipped (issue #71). It asserted flatly that "a memory written with a NULL project never matches a project filter", which stopped being true once the `scope_project` selector gained `includeUnscoped: true` — `briefing` and `handoff` were updated at the time; `remember` was missed, so the write surface was telling agents the opposite of what the read surface does.

The description now distinguishes the two cases precisely: the bare `project` selector is still never widened, and only `scope_project` with `includeUnscoped: true` opts NULL-project memories back in. It also drops a dangling `(issue #244)` citation, which referenced an internal tracker item that means nothing to a reader of the public tool surface.

Tool descriptions are standing context on every MCP connection, so the regenerated surfaces (`docs/reference/tools.mdx`, `eval/fixtures/transport-surfaces.json`) and the recorded transport-cost floors move with it: +13 surface tokens, +104 per-task uncached, +26 per-task cache-effective.
