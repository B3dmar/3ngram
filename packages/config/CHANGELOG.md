# @3ngram/config

## 0.3.0

### Minor Changes

- 809ae0e: Add the session closer (issue #166 step 6): a lease-expiry sweep plus a resolve-only closer job on the worker, both **default-off** behind `SESSION_CLOSER_ENABLED`.

  The sweep is the producer the crash path lacked — a killed terminal touches no row, so nothing else would ever triage a dead session. It stamps an implicit `closedAt` on rows quiet for the lease plus a new one-hour grace, and hands each closed, untriaged run to the closer. The grace is load-bearing: it keeps the stamped `closedAt` outside the `closedAt <= lastSeenAt + lease` window that identifies an explicit `SessionEnd` forever, so a swept row still resurrects on a later heartbeat or resume.

  The closer claims the run with a compare-and-set on `triageAttemptId` fenced at the observed `activationEpoch`, makes ONE LLM pass over the run's briefed commitments, this-run event kinds and the bounded last-message excerpt, then live-re-reads and `resolve`s the commitments the model says the work completed. It writes nothing else — no `remember`, no `revise`, no `archive`. `resolve` is reversible via `unresolve`, which is what makes a retried model pass safe: it cannot append a duplicate corpus row. The model's reply is strict-parsed and then intersected with the briefed id set, so it cannot resolve a commitment it was never shown. The epoch is re-checked on the final write-back, so a resurrection mid-pass abandons the attempt instead of landing on a session the user has resumed.

  The generation is **metered and bounded**. `session.closer` joins the operation registry as the first `generation`-class entry, and the pass reserves against the tenant's budget before the call, records one `llm_usage` row after it, and releases the reservation — the same seam every embed call site uses, so an over-cap pass is rejected rather than silently billed. Output tokens are capped per call. `Gateway.complete()` is implemented for the OpenAI-compatible gateway (it previously threw `NotImplementedError`) and now returns `{ text, usage, model }` rather than a bare string, so callers can price the call; it accepts `maxOutputTokens` and an optional JSON-object response format, and holds its timeout until the response body is consumed rather than releasing it when headers arrive.

  Closer jobs are removed from Redis immediately on both terminal states. The job id is deterministic on `(run, epoch)` and a retained job keeps its id reserved, so anything short of immediate removal leaves a run un-enqueueable: a retained-count policy only rotates when another job finishes, which on a low-volume deployment never happens. The trade is that a persistently failing row is re-enqueued once per sweep tick rather than once ever — bounded, self-healing, and budget-capped — and the `worker: job failed` log (job id, attempt counts, error name; no content) becomes the durable trace in place of the failed-set entry.

  `SESSION_CLOSER_ENABLED` is a **kill switch, not just a first-boot default**. BullMQ job schedulers are durable in Redis, so turning the flag off removes the registered sweep scheduler and additionally makes both processors no-op — a deployment that once ran with the closer on stops closing rows and stops billing generation on the next restart.

  `renderDebriefPrompt` moves from `apps/server` to `@3ngram/core` so the closer renders the same registrar as the MCP prompt and the REST route; the rendered text is unchanged. `transitionCommitment` gains `stampedSessionRunId` for provenance a caller has already resolved — the closer's rows are closed by construction, so the normal attach path would resurrect them — and an optional `expectedFrom` compare-and-set guard, which raises the new `CommitmentStateChangedError` when the row moved between a caller's live read and its write. Without it a lost race still wrote: the FSM trigger passes `resolved -> resolved` straight through, re-stamping `resolvedAt` and appending a duplicate `resolve` event under the loser's provenance.

  The compare-and-set guard applies to the interactive `resolve` surfaces too, so a user resolving a commitment the closer is resolving concurrently no longer appends a second `resolve` event. Losing that race is resolved silently where it can be — the loser re-reads and returns the ordinary idempotent success when the commitment already reached the requested status, and reports the _actual_ from-status when it did not — so the only user-visible change is a new `409 conflict` (MCP: `conflict: commitment is no longer '<status>'; retry`) in the rare case where concurrent writers keep moving the row out from under every attempt.

  Migration `0033` adds a partial index for the closer's candidate scan (`closed_at IS NOT NULL`, excluding the terminal status) — the opposite predicate to the lease index, which therefore could not serve it. No new table; the count stays 27.

  `apps/worker` gains a Dockerfile and a service in **both** `docker-compose.yml` and `compose.selfhost.yml`. Without them a self-host stack enqueued into a void.

  Enabling the closer is a later, measured decision: the validation bar is a positive commitment-recall improvement against the documented 0% baseline, judged by a dogfood audit rather than by CI.

- 54a7993: Add the server half of the Stop-nudge handshake (issue #166 step 7a): `POST /api/v1/agent-sessions/triage/begin` and `/triage/complete`. Both address the row by the natural key `(agent, sessionId)` in the body, with the tenant from the API key — Stop is a separate process that holds the harness conversation id and nothing else. The hook that injects on an armed answer is step 7b and does not exist yet, so the nudge remains default-off: nothing calls these routes.

  `begin` decides on the SERVER and answers `armed`; the hook injects only when armed. The entry rule is `idle` always, `completed` and `expired` only on a re-arm signal (a provenance event for the run whose id is outside `last_triaged_event_ids`), `pending` hands back the attempt already in flight so a later Stop finishes it rather than double-injecting, and `overflowed` is terminal. `expired` deliberately behaves like `completed` for entry: a zero-write continuation must not nag on every later Stop. The debounce requires session substance — a minimum turn count (`SESSION_TRIAGE_MIN_TURNS`, default 3) **or** elapsed time since `opened_at` (`SESSION_TRIAGE_MIN_ELAPSED_MINUTES`, default 10) **or** that same untriaged-event signal. The thresholds are tunable; the condition is not optional. A decline is a 200 carrying a content-free reason; only an unknown natural key is a 404. Both routes hand the raw body to core, which parses it once — the single validation boundary `remember` already establishes; a transport only re-parses when it must echo a normalized value, and neither triage response does.

  `complete` absorbs whatever the continuation wrote: `completed` when the run produced provenance since the attempt began, `expired` when it produced none so the closer still runs, `overflowed` past the per-run event ceiling. The watermark it stamps is the FULL bounded visible set for the run, cumulative rather than the since-begin slice — storing only the slice would re-arm immediately on the events that armed the debounce. `since_begin` is a set difference against the set `begin` stamps when it arms, so it needs no second listing, no new column, and neither of the shortcuts the design rules out (`max(createdAt)`, or "ids greater than X in uuidv7 order" — a late-committing write can hold an earlier uuidv7). Both statements reuse the existing bounded `listSessionEvents` machinery and the `memory_events` expression index.

  A stale `complete` cannot clobber a newer attempt: the stamp is fenced on `triage_attempt_id` AND on the run still being `pending`, so a crashed hook retrying, a second Stop, or a closer that re-claimed the row after the lease expired mid-handshake all get a `409` instead. That last case is the coexistence boundary the fence exists for — the closer runs on closed rows and claims them by compare-and-set on the same column, while the handshake only ever runs on leased-open rows and never resurrects one, so a nudge can neither reopen a session the closer has claimed nor advance the epoch under it.

  Because `triage_attempt_id` now has two writers, the closer's claim also **retires an abandoned handshake, `pending` → `expired`**, and asserts `closed_at IS NOT NULL`. A closed row still marked `pending` is an attempt whose session ended before `triage/complete`, so `expired` — the existing word for a triage attempt that produced no completion, and unconditionally closer-eligible — is simply the truth. Without it, a resurrection (which preserves both columns) would republish the closer's token through `begin`'s `pending` reply and let the hook finalize an attempt whose session had already died, stamping `completed` — which is _not_ closer-eligible — off ordinary post-resurrection MCP traffic. The invariant it buys is that **`pending` means an interactive attempt is in flight, and nothing else**.

  A native write that attaches to a `completed` run now atomically restores `triage_status` to `idle`, folded into the same UPDATE the attach already runs — `completed` is not terminal. It costs no extra statement, no extra lock and no rescan of the stored set: the transaction is inserting a brand-new uuidv7 event id, which by construction cannot be in a watermark stamped before it existed.

## 0.2.6

### Patch Changes

- 139473c: mcp: close two 2026-07-28 specification MUSTs

  `server/discover` now advertises the same one-hour `cacheScope: 'public'` hint the
  tool and prompt catalogs carry. It previously fell through to the SDK's defaults
  (`ttlMs: 0`, `cacheScope: 'private'`), so clients treated discovery as immediately
  stale and re-probed on every reconnect.

  `/mcp` now validates the `Origin` header. A request with no `Origin` is allowed —
  non-browser clients do not send one — and a present `Origin` must appear in the
  allowlist (`WEB_APP_URL` plus the new optional `MCP_ALLOWED_ORIGINS`) or the request
  is refused with `403` before authentication runs. With neither variable configured
  the allowlist is empty, so any browser origin is rejected; non-browser clients are
  unaffected.

## 0.2.5

### Patch Changes

- Keep `engines.node` at `>=22`. The Node 24 work should only have moved what we build, test and ship on — CI and the container base — not what consumers must run. Nothing in this closure uses a Node 24 feature, and Node 22 is supported upstream until 2027-04-30, so raising the published floor would have hard-failed Node 22 consumers on a patch release. Raising it becomes a deliberate major when there is a reason.

## 0.2.4

### Patch Changes

- 6e06cd6: Build, test and ship on Node 24 (Active LTS). CI, the release workflow and the server image base move to Node 24 — `node:24-bookworm-slim`, digest-pinned. `engines.node` deliberately stays `>=22`: nothing here requires a Node 24 feature, so consumers on Node 22 (supported until 2027-04-30) remain supported.

## 0.2.3

### Patch Changes

- 310e515: Make the production `DATABASE_URL` role-name check honor the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`), matching the RLS readiness guard. A deployment whose runtime connects as a differently-named `NOBYPASSRLS` role now passes env validation instead of being rejected for not using `app_user`.

## 0.2.2

### Patch Changes

- 69a66b3: Add RFC 9207 issuer identification to OAuth authorization responses and metadata.
- dcc98b7: Add modern MCP catalog cache hints and bounded pre-parser header observability.

## 0.2.1

### Patch Changes

- b956a15: Reject the public self-host `LOG_HASH_SALT` placeholder when production configuration is parsed.
- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.

## 0.2.0

### Minor Changes

- fb2487a: Reshape into a clean, self-hostable OSS core. Remove the billing/subscription surface and replace the `CloudExtension` seam with a neutral `Extension` seam (`resolveLimits` / `AccessGate` / `onAccountDeletion` / export enricher), all with no-op self-host defaults. Keep the budget cost-cap as a self-host feature. Consolidate docs into a single Mintlify tree and make CI fork-friendly (pgvector service container instead of hosted branches).

## 0.1.1

Initial public release.
