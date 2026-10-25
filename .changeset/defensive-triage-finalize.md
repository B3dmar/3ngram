---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

`POST /api/v1/agent-sessions/triage/complete` accepts an optional `defensive: true` (issue #189). It declares that the caller armed the attempt but showed no debrief for it: the outcome is `expired` whatever was written since `begin`, and `last_triaged_event_ids` stays at the begin stamp. Before this, the Stop hook's defensive finalize (a finalize-only Stop whose `begin` armed instead of declining `pending`) could have a concurrently committing async write make `since_begin` non-empty, landing the run `completed` with that write absorbed into the watermark: no longer closer-eligible and never re-armed on, though no debrief covered it. The write now stays untriaged, re-arms the next Stop and keeps the run closer-eligible, with its provenance retained. Omitting the field is the unchanged complete; the attempt-id fence, idempotency and account erasure are unaffected. `completeSessionTriage` (`@3ngram/db`) and `completeAgentSessionTriage` (`@3ngram/core`) take the same option.

Hook (`cmd/3ngram-hook`, released separately by `3ngram-hook-v*` tag): an attempt the hook armed but did not inject on — the finalize-only Stop above, or a failed debrief fetch — is now completed with `defensive: true`; finalizing a `pending` attempt, whose debrief was shown, is not. The field is sent only when true, and a 400 from a server older than it (its strict body rejects the unknown key) falls back to the ordinary complete, so a new hook against an old server behaves exactly as before.
