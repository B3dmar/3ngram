---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': patch
'@3ngram/server': patch
---

Add the typed provenance read: `GET /api/v1/agent-sessions/{sessionRunId}/events` lists the audit events one agent-session run produced (issue #166 step 4). Items carry `id`, `memoryId`, `eventKind`, `actorKind`, `sessionRunId` and `createdAt` — this is a narrowing of the payload-redaction rule to exactly one key, read with a jsonb operator and parsed through `sessionProvenancePayloadSchema`; the memory-history DTO stays metadata-only. Pagination is a keyset on the uuidv7 event `id` with a bounded per-call `limit` and the per-run `MAX_SESSION_EVENT_IDS` ceiling, which reports `truncated: true` rather than paging past it. A run id this tenant does not own is rejected as invalid input, the same as on the native write path.

`sessionRunId` now canonicalizes to lowercase at one shared boundary (`sessionRunIdSchema`), reused by native remember/revise, `resolve`, the archive body, the provenance payload and the new read. The accepted input set and every exported TypeScript type are unchanged — an uppercase UUID was always valid and still is — but a parsed value is now returned lowercased. This matters because the reader compares `payload->>'sessionRunId'` as text: an uppercase spelling used to clear the uuid-typed ownership check and then match nothing, returning an empty page for a run that has events.
