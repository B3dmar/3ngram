---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/llm': minor
'@3ngram/config': minor
'@3ngram/core': minor
'@3ngram/server': patch
---

Add the session closer (issue #166 step 6): a lease-expiry sweep plus a resolve-only closer job on the worker, both **default-off** behind `SESSION_CLOSER_ENABLED`.

The sweep is the producer the crash path lacked — a killed terminal touches no row, so nothing else would ever triage a dead session. It stamps an implicit `closedAt` on rows quiet for the lease plus a new one-hour grace, and hands each closed, untriaged run to the closer. The grace is load-bearing: it keeps the stamped `closedAt` outside the `closedAt <= lastSeenAt + lease` window that identifies an explicit `SessionEnd` forever, so a swept row still resurrects on a later heartbeat or resume.

The closer claims the run with a compare-and-set on `triageAttemptId` fenced at the observed `activationEpoch`, makes ONE LLM pass over the run's briefed commitments, this-run event kinds and the bounded last-message excerpt, then live-re-reads and `resolve`s the commitments the model says the work completed. It writes nothing else — no `remember`, no `revise`, no `archive`. `resolve` is reversible via `unresolve`, which is what makes a retried model pass safe: it cannot append a duplicate corpus row. The model's reply is strict-parsed and then intersected with the briefed id set, so it cannot resolve a commitment it was never shown. The epoch is re-checked on the final write-back, so a resurrection mid-pass abandons the attempt instead of landing on a session the user has resumed.

`Gateway.complete()` is implemented for the OpenAI-compatible gateway (it previously threw `NotImplementedError`), and `session.closer` joins the operation registry as the first `generation`-class entry. `renderDebriefPrompt` moves from `apps/server` to `@3ngram/core` so the closer renders the same registrar as the MCP prompt and the REST route; the rendered text is unchanged. `transitionCommitment` gains `stampedSessionRunId` for provenance a caller has already resolved — the closer's rows are closed by construction, so the normal attach path would resurrect them.

`apps/worker` gains a Dockerfile and a `docker-compose.yml` service. Without them a self-host stack enqueued into a void.

Enabling the closer is a later, measured decision: the validation bar is a positive commitment-recall improvement against the documented 0% baseline, judged by a dogfood audit rather than by CI.
