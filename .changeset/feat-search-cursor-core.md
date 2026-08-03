---
"@3ngram/schema": minor
"@3ngram/server": patch
---

Search cursor pagination + compact projection contracts (issue #49, layer 1 of 2): new composed `searchQueryV3Schema` in `@3ngram/schema` (own bounded module `search-cursor.ts`) adds `cursor` (opaque frozen-ordering continuation token) and `projection` (`full` default / `compact`, which omits the per-hit `content`/`contentLength`/`truncated` triple) onto the shipped `searchQueryV2Schema`; new `searchToolOutputV2Schema` adds `hasMore` + `nextCursor` with enforced consistency (`count === hits.length`; `nextCursor` present iff `hasMore`). The shipped V1/V2 schemas are untouched. The base64url cursor codec moves from `apps/server/src/rest/cursor.ts` to the shared `apps/server/src/cursor.ts` (pure move — REST dashboard search behavior unchanged) so the MCP search tool (layer 2) can reuse it. No ranking changes; the frozen-ordering core path (`searchDashboardPage`) is reused as-is.
