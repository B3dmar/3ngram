---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/config': patch
'@3ngram/server': minor
'@3ngram/sdk': minor
'3ngram': minor
---

`resolve` accepts an optional `reason` (issue #234) on MCP, `POST /api/v1/memories/:id/resolve` and the SDK (`client.resolve(id, status, { reason })`), so whoever settles a commitment can say what settled it — a PR number, "superseded by X" — in the same call. The reason is trimmed and must be 1–500 characters; an empty or longer one is rejected as invalid input before anything is written. It is stored on the commitment row (new nullable column `commitments.last_resolution_reason`, migration 0040, with a length CHECK generated from the schema bound) in the same transaction as the status change, never in the append-only audit event payload, which keeps carrying only `sessionRunId`. A reason explains one transition: any later status change without one clears it (including the surfacing sweep's expiry and a revise that demotes the commitment), a same-state no-op stores nothing, and a revise that keeps the commitment carries it with the row. A blocker has no commitment row, so a blocker resolve with a `reason` is rejected as invalid input (MCP error, REST 400 with a recovery detail) instead of being dropped. The reason is memory content: it is returned only by the authenticated, tenant-scoped `GET /api/v1/memories/:id/history` (new top-level `lastResolutionReason: string | null`) and by the owner's account export, never by briefing or search, never logged (its stored and core spellings join the log redaction list), and account erasure nulls it in place alongside `owner`. The tool description is unchanged.
