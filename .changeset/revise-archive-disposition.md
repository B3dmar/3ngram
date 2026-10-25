---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
"@3ngram/sdk": minor
---

`revise` gains an archive disposition (issue #217): `{ kind: "archive", memoryIds }` takes 1-50 unique memories out of the active set (`status` `active → archived`) with no successor and no edge. Content, topic, tags, `valid_from`, `valid_to` and `recorded_at` are untouched, so an archived memory stays recoverable with `status: "archived"` and through `asOf`; it leaves default ranked search, briefing and the stale-candidate queue. Each id reports its own outcome — `archived`, `already_archived` (the idempotent repeat), or `rejected` with a reason code (`not_found` for unknown and other-tenant ids, `superseded`, `open_commitment` for an open or waiting commitment, `blocker`, which leaves through `resolve`) — and runs in its own transaction, so one bad id never fails the batch. Every archived row gets an `archive` memory event with the strict payload `{ disposition: "archive", sessionRunId? }`, attributed to the transport's actor and the session run; the REST archive route now writes the same payload. Over REST the revise route's URL id is the one-element batch; the SDK's `revise()` returns the outcome list for a disposition body (overloaded, so existing callers keep their types). The tool's registered output is the new `reviseToolOutputV2Schema` union; `reviseToolOutputSchema` keeps its shape. Hard rule 1 now names the audited `active → archived` transition as its second carve-out. The tool description is unchanged (no embeddings regen).
