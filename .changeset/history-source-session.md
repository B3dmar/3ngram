---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

The memory history read now exposes the session run that produced a memory (issue #262). `GET /api/v1/memories/:id/history` adds `sessionRunId: uuid | null` to each audit event and `createdBySessionRunId: uuid | null` to the envelope. These are allowlisted sibling fields, never the raw payload: each is projected with `payload->>'sessionRunId'` and re-parsed through `sessionProvenancePayloadSchema`, and a value that fails the parse reads as `null`. `payloadMetadata` keeps its meaning and still describes the whole stored payload. `createdBySessionRunId` is the run on the memory's own native `create` event. It is read by its own query, so a truncated events window cannot hide it, and each version in a revision chain reports its own creating run. It reads `null` for an imported memory, a create written without provenance, or an `unavailable` events section, and it is never inferred from neighbouring events. The id is returned as recorded, without a join to `agent_sessions`. Harness and model labels are not projected.
