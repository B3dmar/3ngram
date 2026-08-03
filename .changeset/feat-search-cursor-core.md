---
"@3ngram/schema": minor
"@3ngram/server": patch
---

Search cursor pagination + compact projection contracts (issue #49, layer 1 of 2): new composed `searchQueryV3Schema` in `@3ngram/schema` (own bounded module `search-cursor.ts`) adds `cursor` (opaque frozen-ordering continuation token) and `projection` (`full` default / `compact`, which omits the per-hit `content`/`contentLength`/`truncated` triple) onto the shipped `searchQueryV2Schema`; new `searchToolOutputV2Schema` adds `hasMore` + `nextCursor` with enforced consistency (`count === hits.length`; `nextCursor` present iff `hasMore`). The shipped V1/V2 schemas are untouched. The base64url cursor codec moves from `apps/server/src/rest/cursor.ts` to the shared `apps/server/src/cursor.ts` so the MCP search tool (layer 2) can reuse it. No ranking changes; the frozen-ordering core path (`searchDashboardPage`) is reused as-is.

Review hardening: `searchToolOutputV2Schema` additionally enforces one projection per page (a mixed full/compact `hits` array is rejected), and continuation cursors are now BOUND to the search that issued them — the cursor payload gains an optional `fp` fingerprint (truncated sha256 of the normalized query + filter set) that issuance populates and continuation verifies, rejecting a cursor replayed under a changed query/filters with a typed 400 (`CursorQueryMismatchError`) instead of silently re-paging the old frozen ordering. `fp` is optional with verify-when-present semantics: fingerprint-less cursors minted before this change stay valid.
