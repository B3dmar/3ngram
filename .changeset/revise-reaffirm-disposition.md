---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
"@3ngram/sdk": minor
---

`revise` gains a reaffirm disposition (issue #218): `{ kind: "reaffirm", memoryIds }` (the same bounded 1-50 unique batch as archive) records "reviewed, still valid". It stamps the new nullable `memories.last_reviewed_at` column (migration 0040) and writes a `reaffirm` memory event with the strict payload `{ disposition: "reaffirm", sessionRunId? }` — a new `reaffirm` event kind, with the generated `memory_events` CHECK regenerated. Nothing else changes: no new row, no edge, no status change, and content, topic, `recorded_at`, valid time and `updated_at` are untouched, so a review never poses as a revision. Briefing stale candidates now key on `GREATEST(updated_at, last_reviewed_at)`, so a reaffirmed memory leaves that section for one full stale window (30 days) and returns after it; a never-reviewed memory is judged exactly as before. Each id reports `reaffirmed` or `rejected` (`not_found`, `superseded`, `archived`). Ranked search is unchanged. The data export carries `lastReviewedAt` on every memory; account erasure leaves it (it is not content). The tool description is unchanged (no embeddings regen).
