# @3ngram/schema

## 0.8.0

### Minor Changes

- 5af5010: Native writes accept optional `sessionRunId` and stamp `{ sessionRunId }` on audit events. Import still rejects the key. Unknown run ids fail the write; an explicitly closed row succeeds unattributed and is never resurrected; a stale lease resurrects then attaches, and a successful attach refreshes the lease. Concurrent writes carrying the same stale run id resurrect it exactly once — `activationEpoch` advances one step per resurrection, never one per writer, so a claim fenced at the new epoch stays valid. Omitted id uses the single leased-open session for the project. `POST /api/v1/memories/:id/archive` gains an optional body carrying the same field, and the SDK's `resolve()` takes an optional `{ sessionRunId }`. The SDK's `remember()` now takes/returns the facts-capable `RememberToolArgsV2`/`RememberToolOutputV2` types instead of the V1 pair. Resolving a commitment to the status it already holds stays idempotent but now validates a supplied `sessionRunId` too: such a request previously succeeded with an unowned or nonexistent id and is now rejected as invalid input, the same as every other native write. Lease refreshes are monotonic — a heartbeat or resurrect can only move `lastSeenAt` forward, so a slow writer cannot shorten a lease a later one already extended.
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

- 62317d9: Add the typed provenance read: `GET /api/v1/agent-sessions/{sessionRunId}/events` lists the audit events one agent-session run produced (issue #166 step 4). Items carry `id`, `memoryId`, `eventKind`, `actorKind`, `sessionRunId` and `createdAt` — this is a narrowing of the payload-redaction rule to exactly one key, read with a jsonb operator and parsed through `sessionProvenancePayloadSchema`; the memory-history DTO stays metadata-only. Pagination is a keyset on the uuidv7 event `id` with a bounded per-call `limit` and the per-run `MAX_SESSION_EVENT_IDS` ceiling, which reports `truncated: true` rather than paging past it. A run id this tenant does not own is rejected as invalid input, the same as on the native write path.

  `sessionRunId` now canonicalizes to lowercase at one shared boundary (`sessionRunIdSchema`), reused by native remember/revise, `resolve`, the archive body, the provenance payload and the new read. The accepted input set and every exported TypeScript type are unchanged — an uppercase UUID was always valid and still is — but a parsed value is now returned lowercased. This matters because the reader compares `payload->>'sessionRunId'` as text: an uppercase spelling used to clear the uuid-typed ownership check and then match nothing, returning an empty page for a run that has events.

- 1f4c763: Add the hook-facing session-lifecycle REST surface (issue #166 step 5a): `POST /api/v1/agent-sessions/open`, `/close` and `/heartbeat`, plus `GET /api/v1/prompts/debrief`. All four address the row by the natural key `(agent, sessionId)` in the body or query — Stop and SessionEnd are separate processes that hold the harness conversation id and nothing else, so close carries no `activation_epoch` and nothing has to persist a local run-id mapping. The tenant always comes from the API key.

  `open` is idempotent by that natural key, which doubles as the request token: `startup` inserts at `activation_epoch` 1 and stamps the briefed rows the hook reports after its local truncate; a duplicate `startup` delivery with the same `project`/`scope`/`selector` changes nothing, and one with different values is a `409`. `resume` reuses the row, advances the epoch, reopens a closed or lease-expired row and refreshes the lease — without restamping the briefing. `close` sets `closed_at` once (a repeat echoes the first timestamp), deliberately freezes `last_seen_at` so `closed_at <= last_seen_at + lease` keeps identifying an explicit SessionEnd, and never clears an excerpt the closer has not consumed. `heartbeat` refreshes the lease monotonically, resurrects a closed or lease-expired row, and optionally snapshots the turn's bounded `last_assistant_message`.

  `GET /api/v1/prompts/debrief` renders the same debrief text the MCP `debrief` prompt serves — one renderer, two transports — and inlines the run's `briefed_memories` as an id → topic/status mapping so the model can tell which commitment to resolve. Instructions are server-authored and every caller- or tenant-supplied value renders inside a fenced JSON block whose fence grows past the longest backtick run in the payload; the MCP `debrief` prompt changed to the same delimited-data shape, so `scope` and `project` are no longer interpolated into its imperative sentences.

  The rendered resolve instruction is conditional on that mapping: with one, the prompt narrows resolution to the listed ids; without one — which is every MCP render, since a prompt carries no tenant data — it keeps telling the agent to resolve the commitments it completed, unchanged from before.

  Also hardens the native write-attach path: the re-read under the attach advisory lock is now `SELECT ... FOR UPDATE`, so a concurrent close cannot commit between the resurrect decision and the resurrect it justified and silently reopen an explicitly closed session. The close route is the first writer of `closed_at`, which is what made that race reachable.

- 54a7993: Add the server half of the Stop-nudge handshake (issue #166 step 7a): `POST /api/v1/agent-sessions/triage/begin` and `/triage/complete`. Both address the row by the natural key `(agent, sessionId)` in the body, with the tenant from the API key — Stop is a separate process that holds the harness conversation id and nothing else. The client half is the step 7b hook (`3ngram-hook stop`), which ships in this same release and calls these routes only behind `THREENGRAM_STOP_NUDGE=1` — the nudge remains default-off.

  `begin` decides on the SERVER and answers `armed`; the hook injects only when armed. The entry rule is `idle` always, `completed` and `expired` only on a re-arm signal (a provenance event for the run whose id is outside `last_triaged_event_ids`), `pending` hands back the attempt already in flight so a later Stop finishes it rather than double-injecting, and `overflowed` is terminal. `expired` deliberately behaves like `completed` for entry: a zero-write continuation must not nag on every later Stop. The debounce requires session substance — a minimum turn count (`SESSION_TRIAGE_MIN_TURNS`, default 3) **or** elapsed time since `opened_at` (`SESSION_TRIAGE_MIN_ELAPSED_MINUTES`, default 10) **or** that same untriaged-event signal. The thresholds are tunable; the condition is not optional. A decline is a 200 carrying a content-free reason; only an unknown natural key is a 404. Both routes hand the raw body to core, which parses it once — the single validation boundary `remember` already establishes; a transport only re-parses when it must echo a normalized value, and neither triage response does.

  `complete` absorbs whatever the continuation wrote: `completed` when the run produced provenance since the attempt began, `expired` when it produced none so the closer still runs, `overflowed` past the per-run event ceiling. The watermark it stamps is the FULL bounded visible set for the run, cumulative rather than the since-begin slice — storing only the slice would re-arm immediately on the events that armed the debounce. `since_begin` is a set difference against the set `begin` stamps when it arms, so it needs no second listing, no new column, and neither of the shortcuts the design rules out (`max(createdAt)`, or "ids greater than X in uuidv7 order" — a late-committing write can hold an earlier uuidv7). Both statements reuse the existing bounded `listSessionEvents` machinery and the `memory_events` expression index.

  A stale `complete` cannot clobber a newer attempt: the stamp is fenced on `triage_attempt_id` AND on the run still being `pending`, so a crashed hook retrying, a second Stop, or a closer that re-claimed the row after the lease expired mid-handshake all get a `409` instead. That last case is the coexistence boundary the fence exists for — the closer runs on closed rows and claims them by compare-and-set on the same column, while the handshake only ever runs on leased-open rows and never resurrects one, so a nudge can neither reopen a session the closer has claimed nor advance the epoch under it.

  Because `triage_attempt_id` now has two writers, the closer's claim also **retires an abandoned handshake, `pending` → `expired`**, and asserts `closed_at IS NOT NULL`. A closed row still marked `pending` is an attempt whose session ended before `triage/complete`, so `expired` — the existing word for a triage attempt that produced no completion, and unconditionally closer-eligible — is simply the truth. Without it, a resurrection (which preserves both columns) would republish the closer's token through `begin`'s `pending` reply and let the hook finalize an attempt whose session had already died, stamping `completed` — which is _not_ closer-eligible — off ordinary post-resurrection MCP traffic. The invariant it buys is that **`pending` means an interactive attempt is in flight, and nothing else**.

  A native write that attaches to a `completed` run now atomically restores `triage_status` to `idle`, folded into the same UPDATE the attach already runs — `completed` is not terminal. It costs no extra statement, no extra lock and no rescan of the stored set: the transaction is inserting a brand-new uuidv7 event id, which by construction cannot be in a watermark stamped before it existed.

### Patch Changes

- 1160f1a: Add `agent_sessions` and a `memory_events` sessionRunId index (issue #166 step 2). Import payloads reject the reserved `sessionRunId` key. Account erasure redacts session rows in place; the GDPR export includes them.

## 0.7.3

### Patch Changes

- 33d1a7f: Debrief and server instructions require one typed atom per remember, under the 2000-character cap. Optional `project` on the debrief prompt so writes can hit a project briefing.

## 0.7.2

### Patch Changes

- 851fa53: Tool output schemas now advertise open (`additionalProperties: true`) while the server keeps parsing them strict.

  **A cached catalog no longer breaks on an additive response field.** Every tool output object was `.strict()`, which Zod 4 emits as `additionalProperties: false` in the JSON Schema `tools/list` advertises. Clients cache that catalog for an hour, so ANY release that added a response field hard-failed every validating client for the whole TTL window — and nothing prompted an early re-fetch, because the failure is client-side _output_ validation rather than a `-32601`/`-32602` the client reads as staleness. That is the observed v1.4.1 incident: a session holding the v1.3.0 catalog called `get_facts` and died on `data/facts/0 must NOT have additional properties`, on a nested item object, from a purely additive field. Every object node reachable in all eleven tool output trees now carries `.meta({ additionalProperties: true })` — root envelopes, array item objects, union members, and section wrappers alike, since the incident failed at depth.

  **The runtime contract is unchanged.** `.meta()` moves metadata only: the objects stay `.strict()`, so the server still rejects an unknown key in a result it produced itself, and the search envelope's projection-homogeneity refinement still relies on its hit members being strict. `.loose()`/`.passthrough()` would have moved the runtime contract and were deliberately not used. The strictness suites in `packages/schema` pass unchanged.

  **Inputs stay closed, and the asymmetry is now locked by a test.** An unknown argument key remains a loud rejection — a silently dropped `scope` filter reads as a scope leak — so no input schema's advertisement moved a byte. The briefing/handoff `selector` union is the one object reachable from BOTH an input and an output tree (it is an argument AND an echo); the openness rides an output-side derivation, leaving the input union untouched. A registry invariant test walks every tool's emitted output schema asserting no `additionalProperties: false` at any depth, and asserts every input root still carries it.

  **The OpenAPI response schemas open up too — deliberately.** The generator reuses the same output schemas for REST responses, so `POST /api/v1/memories`, `POST /api/v1/search`, `GET /api/v1/facts`, `GET /api/v1/briefing`, and the revise/resolve responses now publish `additionalProperties: true`. The rationale is the same one: a REST reader compiled against an older spec should not break on a field that was only added. Request bodies and query schemas are untouched.

## 0.7.1

### Patch Changes

- 483c658: Five correctness fixes to the facts, portability, and retrieval surfaces.

  **`fact_proposals` is now erased on account deletion.** Account deletion tombstones the `users` row rather than deleting it, so the FK's `ON DELETE CASCADE` never fires — a staged fact proposal kept its `subject`, `predicate`, `value`, and `rationale` through an Article 17 erasure. It is now redacted in place in the same transaction as `facts` and `consolidation_proposals` (redact-in-place, not DELETE: the runtime role has no DELETE grant on memory-domain tables). The erasure receipt gains a `factProposals` count on `DELETE /api/v1/account` and in the audit tombstone.

  **`fact_proposals` is now included in the portability export.** `GET /api/v1/export` carried `facts` and `consolidation_proposals` but not the staged proposals, which are user content that is not yet a `facts` row. The archive gains a `factProposals` section (and a matching `counts.factProposals`), read under the same repeatable-read snapshot as every other section.

  **Chronological search now rejects a `query` instead of silently ignoring it.** `order: 'chronological'` is an unranked enumeration and the core path takes no query argument, so a caller passing `{order: 'chronological', query}` was returned the whole live corpus as though it had been searched. A present `query` is now a validation error naming `order: 'relevance'` as the ranked alternative. Because `query` no longer bounds the scan, chronological order now REQUIRES at least one filter (previously "query or >=1 filter").

  **Fact write timestamps no longer truncate to milliseconds.** `validFrom`/`validTo` on a written fact accepted arbitrary fractional-second precision, but core converts them with `new Date()` (millisecond) on the way to microsecond-precision Postgres columns — a finer instant silently moved the boundary of a bi-temporal window. Both bounds are now capped at 3 fractional-second digits and REJECTED beyond it, matching the facts-range read bounds, with the limit advertised in the field descriptions.

  **Imported `updates` edges no longer mark live memories superseded.** The `superseded` flag and its ranking tier-penalty counted any incoming `supersedes`/`updates` edge, but the import contract forbids `closePredecessorAt` on an `updates` edge — so every imported `updates`-edge target stayed live (`valid_to IS NULL`) yet read `superseded: true` and was demoted in ranking. The predicate now requires BOTH a revision edge AND closed validity, the same definition `memory_history`'s `lifecycleState` applies, so search and history can no longer disagree about the same row. Genuine revisions are unaffected: the revise path closes `valid_to` for both edge kinds.

## 0.7.0

### Minor Changes

- c6a819c: `get_facts` gains a `range: {from?, to?}` window for chronological time-series reads over the bi-temporal facts table, on both the MCP tool and REST `GET /api/v1/facts`.

  `range` replaces (never appends to) the default live-only predicate with a half-open `[from, to)` valid-time overlap: a fact whose validity window overlaps the requested range is returned, including generations superseded inside it — the point of a time-series read over "what's currently true." Ordering flips to `valid_from ASC` (chronological) instead of the default `recorded_at DESC` (recency); `range` and `asOf` are mutually exclusive point-in-time vs. window modes, enforced at the schema boundary (empty range object rejected, mirroring `asOfSchema`; an inverted `from`/`to` range rejected rather than silently returning empty, per issue #58's REST/MCP parity precedent). Each bound is also capped at millisecond precision (issue #58 item 2's fix, applied here too): `valid_from`/`valid_to` are microsecond-precise in Postgres, so a sub-millisecond bound would silently truncate up to the next whole millisecond and let an already-ended generation leak into the window. The existing `DEFAULT_FACTS_LIMIT`/`MAX_FACTS_LIMIT` bounds still apply in range mode.

  Every returned fact now also carries `recordedAt` (transaction time) — an additive, output-only widening useful for telling apart same-window generations recorded at different instants.

  Deliberately out of scope: a `valid_from` index (the sort is accepted at current volumes) and a scope axis on `get_facts` (the facts table has no scope column — continuing issue #47's open item). The SDK `getFacts` client and the CLI `facts` command do not yet expose the `from`/`to` range axis (REST/MCP only for now); follow-up planned.

- 88ee7d4: mcp/rest: expose structured facts on remember

  `remember` now accepts the measurable claims a memory states, on both
  transports. Pass `facts` as subject/predicate/value triples and the response
  returns a `factIds` array; `get_facts` can then read those claims back directly
  instead of re-parsing prose.

  Fact values are text, so the unit belongs in the predicate and each fact holds
  one measure — subject `lift.back_squat`, predicate `top_set.weight_kg`, value
  `98`, not a predicate `top_set` carrying `98kg x 3`. A later range read is only
  comparable across entries if every writer follows that convention, so it is
  stated in the tool description, the server instructions, and the data model doc.

  Validity instants are ISO-8601 strings: an MCP server publishes its input schema
  as JSON Schema, which has no date type. A `validTo` requires a `validFrom`, and
  at most 16 facts ride one write.

  `factIds` is present only when facts were written, so every existing response is
  byte-identical and the V1 output schema still parses it. The V2 contracts are
  composed beside the shipped ones rather than replacing them.

- 4ed7e25: core: accept structured facts on remember

  A write can now carry the facts it asserts. `remember` takes an optional
  `facts` list of `{subject, predicate, value}` triples with an optional
  confidence and valid-time window, and returns their ids alongside the memory's.
  The facts are persisted in the same transaction as the memory, so a claim and
  its source can never be half-written.

  `rememberWithFactsInputSchema` is composed BESIDE the shipped
  `rememberInputSchema` rather than replacing it. That separation is what keeps
  `revise` rejecting a `facts` key: facts belong to the assertion that introduced
  them, and a revision appends a new memory, so silently carrying facts across
  would attribute them to the wrong row.

  The per-fact contract mirrors the import path minus the fields a fresh write
  already knows — no `memoryId` (the memory is being written in the same call) and
  no `recordedAt` (knowledge time is now, by definition). Validity is stricter
  than the `facts` table alone requires: a `validTo` demands a `validFrom`, so a
  window that ends but never begins is a field-level error rather than a
  constraint violation later. At most 16 facts per write; an empty list is
  equivalent to omitting the key, and both return no fact ids.

  Transports are unchanged in this release and still reject a `facts` key at
  their own boundary — core accepts it ahead of the MCP and REST surface.

- 4cd03d4: mcp: review extracted fact proposals alongside edge proposals

  `review_proposals` now covers both kinds of proposal. Listing returns extracted
  fact proposals next to consolidation ones, and accepting a fact proposal writes
  the structured fact so `get_facts` can read it — nothing an extractor produced
  becomes queryable truth without a person accepting it.

  The input is unchanged: accept and reject still take just the proposal id.
  Proposal ids are disjoint across the two tables, so the id alone identifies
  which kind it is, and core probes the edge table first and the fact table only
  when that reports not-found — a not-found reaches the caller only after both
  miss. Any other failure propagates instead of being retried against the wrong
  table.

  Existing responses are untouched. The list result only grows a `factProposals`
  key when there are some, so a tenant with only edge proposals sees the response
  it always saw; decisions on a fact proposal answer with their own
  `applied_fact` / `rejected_fact` variants rather than changing the payload under
  the shipped `applied` / `rejected` literals. Accepting a fact proposal also
  returns the id of the fact it wrote, so a reviewer does not need a second call
  to find out what landed.

  Listing bounds each kind by the same limit rather than splitting one budget, so
  a burst of extracted facts cannot push edge proposals out of the review window.

- 1d9a420: Add an exhaustive chronological list mode to `search`.

  Retrieving everything of a given shape (every decision from a project, every commitment recorded last week) previously meant issuing a ranked search and hoping the relevance ordering happened to surface it all within the result window — there was no way to ask for a complete, chronological listing.

  `search` now accepts `order: "chronological"` alongside the default `"relevance"`. Chronological mode returns a most-recent-first, unranked enumeration of live memories narrowed by the same candidate filters ranked search already supports (memoryType, scope, project, status, asOf, recordedAfter/recordedBefore). It never calls the embedding gateway — no query is required as long as at least one filter narrows the set — and pages through a small, drift-free keyset cursor instead of the ranked path's larger frozen-ordering token.

  Superseded predecessors are excluded from chronological listings by default (an exhaustive list has no ranking to demote a superseded row with, so it drops instead — the same live-only default the dashboard memory list already uses), unless an `asOf` coordinate explicitly asks for a historical view.

- 318025a: Fix `search` to demote every superseded predecessor, and label demoted hits.

  The supersession tier-penalty in `search` only fired for a `supersedes` edge — a revision recorded with the `updates` edge kind closed its predecessor's validity exactly the same way, but escaped the ranking demotion entirely, so a superseded row could still outrank its live successor. The penalty now applies whenever a row has an incoming `supersedes` or `updates` edge, matching the existing `CLOSES_PREDECESSOR` convention used elsewhere for the same two edge kinds.

  Search hits (both MCP and REST, full and compact projections) now also carry a `superseded: boolean` flag, so a caller can tell a demoted result from a current one instead of inferring it from score alone. Ranking stays supersession-_aware_, never supersession-_filtered_: a demoted row is still returned, just ranked below its successor and now labeled as such.

## 0.6.4

### Patch Changes

- 43a200c: Add `GET /api/v1/version`, returning the running server's package version, so deploy tooling can tell a finished rollout from one still in flight.

  Nothing previously exposed build identity over HTTP: `/health` reports liveness and `/ready` reports readiness, but neither says _which build_ answered. A post-deploy probe therefore could not distinguish a completed rollout from an in-flight one, and would happily verify the **previous** build while reporting success — a green light for code that was never exercised.

  **Authenticated, like every `/api/v1` route.** It sits behind `apiOrSessionAuth`, so the exact version is never disclosed on an unauthenticated surface; this matches `/ready`, which logs RLS violations server-side but deliberately keeps catalog and role detail out of its HTTP response. Deploy tooling authenticates anyway.

  **Deliberately ungated.** The response is the server's own build identity — not memory, not memory-derived, not tenant data — so no access gate applies. Staying ungated also keeps it orthogonal to the `AccessGate`: a deploy probe must remain answerable when the gate itself is broken, which is exactly the incident in which an operator most needs to know what is running.

  The value comes from the existing `SERVER_VERSION` (read from `apps/server/package.json` at runtime), so it cannot skew from the published package version at a release; a test asserts that against `package.json` directly rather than against the constant.

  Adds `versionResponseSchema` / `VersionResponse` to `@3ngram/schema` and the corresponding `getVersion` operation to the generated OpenAPI document.

## 0.6.3

### Patch Changes

- Keep `engines.node` at `>=22`. The Node 24 work should only have moved what we build, test and ship on — CI and the container base — not what consumers must run. Nothing in this closure uses a Node 24 feature, and Node 22 is supported upstream until 2027-04-30, so raising the published floor would have hard-failed Node 22 consumers on a patch release. Raising it becomes a deliberate major when there is a reason.

## 0.6.2

### Patch Changes

- 6e06cd6: Build, test and ship on Node 24 (Active LTS). CI, the release workflow and the server image base move to Node 24 — `node:24-bookworm-slim`, digest-pinned. `engines.node` deliberately stays `>=22`: nothing here requires a Node 24 feature, so consumers on Node 22 (supported until 2027-04-30) remain supported.

## 0.6.1

### Patch Changes

- 75ff6f4: Stop rejecting a Client ID Metadata Document because it advertises a grant type this server does not implement.

  `clientIdMetadataDocumentSchema` validated `grant_types` as `z.array(z.enum(['authorization_code','refresh_token'])).max(2)`, so any document listing a third grant failed structurally and the client could not authorize at all. That locked out real MCP clients: claude.ai's document advertises `urn:ietf:params:oauth:grant-type:jwt-bearer` alongside the two grants we support, failing both the enum and the `max(2)` cap and producing a bare `400 invalid_client`.

  `grant_types` and `response_types` advertise what a client MAY use (RFC 7591 §2). MCP's CIMD requirements for an authorization server are to validate that `client_id` matches the document URL, to validate `redirect_uris`, and to validate that the structure is valid JSON containing the required fields — `client_id`, `client_name`, `redirect_uris`. `grant_types` is not among them, and nothing licenses condemning a whole document over one unsupported entry.

  Both fields are now parsed permissively and narrowed to what this server issues. The bound stays on the raw array, since unbounded input is the actual risk; the narrowed result is by construction no larger than the supported set. Structurally malformed advertisements (a non-array, or an empty array) are still rejected, and the absent-field default is unchanged.

  `grant_types` may narrow to an empty list: usability is a policy question the `/authorize` path already answers with a precise `unsupported_grant_type`, rather than a blanket `invalid_document` from the structural boundary. `response_types` may not — it tolerates extra advertised values but still requires `code` to survive. The asymmetry is deliberate: nothing downstream consults the client's advertised `response_types`, so allowing it to empty would admit a document advertising only `token` and still issue it an authorization code, silently dropping a constraint the previous `z.literal('code')` array enforced.

## 0.6.0

### Minor Changes

- 58e3f9d: Add the briefing/handoff bounds V2 contracts (`packages/schema/src/briefing-bounds.ts`): composed successor input schemas with a caller-tunable `sectionLimit` (bounded by the new server-side ceilings `MAX_BRIEFING_SECTION_CEILING`/`MAX_HANDOFF_SECTION_CEILING`, both 100) and an optional briefing `sections` subset selector, plus successor output schemas where briefing sections gain a `hasMore` flag and the handoff envelope gains exact per-section `counts` + `truncated` flags. Shipped V1 schemas stay byte-identical; a legacy input parses identically through V1 and V2.
- b704728: Add the batched bounded-content read that backs the upcoming `get_memories` MCP tool: `getMemoriesInputSchema`/`getMemoriesOutputSchema` (own bounded module `get-memories.ts`; ids 1–20, `maxContentChars` 600–65,536 with default 10,000, aggregate `ids × maxContentChars` capped at 262,144, `count` enforced to equal `memories.length`) at the one validation boundary, a single-query `getMemoriesByIds` db read (`id = ANY` under one `withTenant`, RLS-safe), and core `getMemoriesByIds(userId, ids, { maxContentChars })` returning `{ memories, notFound }` — a missing or cross-tenant id is data (`notFound`), never an error. `excerptContent` now accepts an optional max-chars argument; existing call sites keep the shipped 600-char excerpt behavior.
- eb2ea4e: Per-user retrieval-scope policy store (issue #47, layer 1 of 3): a new `user_retrieval_policy` table (one optional row per user; RLS + FORCE, tenant-isolation policy, Zod-derived mode and consistency CHECKs) with `getRetrievalPolicy`/`upsertRetrievalPolicy` accessors under `withTenant()`. The policy is included in account portability exports and reset to the inert `off` state during tombstone-style account erasure. The schema contract lands in a bounded `retrieval-scope` module: the `set_retrieval_default` `configure_scope` action variant composed onto the shipped action union, the `retrieval_default_set` output variant, and the additive `describe_environment` `retrievalScopePolicy` report field. Storage + contracts only; read-path enforcement remains in the stacked core layer.
- 0790813: Retrieval-scope policy wiring (issue #47, layer 3 of 3 — closes the stack). The MCP transport resolves the user's policy at most once per request (a memoized thunk over core `resolveRetrievalPolicy`, paid only by the read tools) and injects it into search/briefing/handoff; `configure_scope` gains the `set_retrieval_default` action (write-scoped; a `default` scope must exist in the registry — typed not_found otherwise) and `describe_environment` reports `retrievalScopePolicy`. Results echo `appliedScope` exactly when the policy narrowed an unscoped call (schema successors: `searchToolOutputV3Schema`, `briefingToolOutputV4Schema`, `handoffToolOutputV4Schema`, `searchRestResponseV2Schema`, `dashboardSearchResponseV2Schema` — shipped schemas byte-identical); an unscoped read under mode `require` maps to a typed invalid_input naming the registered scopes (MCP isError; REST 400 with the recovery in `detail`). REST parity: `/api/v1/search`, `/api/v1/dashboard/search`, and `/api/v1/briefing` ride the same injected policy. The SDK and CLI preserve recovery detail, and human CLI search output reports a policy-applied scope. Docs, OpenAPI, the MCP reference, and the transport-cost fixture are regenerated in lockstep (frozen totals updated); the golden-set eval gate holds at floors.
- a364654: Add the `scope_project` orientation selector variant (issue #46): `{kind:'scope_project', scope, project, includeUnscoped}` selects the scope AND project intersection the shipped union could not express, with `includeUnscoped` (default false) as the opt-in NULL-project mitigation — `scope = $s AND (project = $p OR ($includeUnscoped AND project IS NULL))` in the single `memoryScopePredicate` all six briefing sections and handoff inherit. The V2 selector union (`briefingSelectorV2Schema`, packages/schema/src/briefing-bounds.ts) is composed from the shipped variant objects, so the three shipped variants stay byte-identical and the bare `project` variant is NOT widened. Core `requireSelector` validates the new variant; the published `BriefingSelector` type carries it with a required `includeUnscoped`.
- 2ecf3ab: Wire the `scope_project` selector onto the orientation transports (issue #46, layer 2 of 2): `briefing` and `handoff` register the V3 tool IO (`briefingToolInputV3Schema`/`handoffToolInputV3Schema` + matching outputs). Each V3 schema is rebuilt from its shipped base with `.extend(...)`, widening only the selector while reapplying the shared V2 fields and refinements (duplicate-section rejection and hasMore/counts identities), so every V2-valid payload parses identically. The REST `GET /api/v1/briefing` route accepts `kind=scope_project&scope=…&project=…&includeUnscoped=true|false` (only the literal strings coerce; anything else is a schema 400). Tool descriptions document the NULL-project semantics: a memory written without a project never appears through the bare `project` lens — `scope_project` with `includeUnscoped: true` is the explicit opt-in, and the bare variant is never widened. `docs/reference/tools.mdx`, the OpenAPI spec, and the transport-cost fixture + frozen totals are regenerated in lockstep.
- 351aee0: Search cursor pagination + compact projection contracts (issue #49, layer 1 of 2): new composed `searchQueryV3Schema` in `@3ngram/schema` (own bounded module `search-cursor.ts`) adds `cursor` (opaque frozen-ordering continuation token) and `projection` (`full` default / `compact`, which omits the per-hit `content`/`contentLength`/`truncated` triple) onto the shipped `searchQueryV2Schema`; new `searchToolOutputV2Schema` adds `hasMore` + `nextCursor` with enforced consistency (`count === hits.length`; `nextCursor` present iff `hasMore`). The shipped V1/V2 schemas are untouched. The base64url cursor codec moves from `apps/server/src/rest/cursor.ts` to the shared `apps/server/src/cursor.ts` so the MCP search tool (layer 2) can reuse it. No ranking changes; the frozen-ordering core path (`searchDashboardPage`) is reused as-is.

  Review hardening: `searchToolOutputV2Schema` additionally enforces one projection per page (a mixed full/compact `hits` array is rejected), and continuation cursors are now BOUND to the search that issued them — the cursor payload gains an optional `fp` fingerprint (truncated sha256 of the normalized query + filter set) that issuance populates and continuation verifies, rejecting a cursor replayed under a changed query/filters with a typed 400 (`CursorQueryMismatchError`) instead of silently re-paging the old frozen ordering. `fp` is optional with verify-when-present semantics: fingerprint-less cursors minted before this change stay valid.

- 8598b09: Filters V2 parity on the REST memories list (issue #48, layer 2 of 2): `GET /api/v1/memories` accepts `memoryTypes` (repeatable query param — string once, array when repeated, the same handling as `project`; mutually exclusive with the scalar `type`) and `recordedAfter`/`recordedBefore` (inclusive ISO recorded_at range bounds). The db `listConditions` narrows via `eq`/`inArray` and `gte`/`lte` on top of the ever-present live gate — the range narrows the live view, never widens it. OpenAPI spec regenerated from the schema.
- 1471fcb: Search filters V2 (issue #48, layer 1 of 2): the MCP `search` tool accepts two new candidate-narrowing filter axes — `memoryTypes` (an OR-set of memory types, 1–8 entries, mutually exclusive with the scalar `memoryType`) and `recordedAfter`/`recordedBefore` (an inclusive transaction-time range on `recorded_at` that narrows the live view WITHOUT lifting the active-only default — unlike `asOf`, it is not time travel). New composed `searchFiltersV2Schema`/`searchQueryV2Schema` in `@3ngram/schema` (the shipped V1 schemas are untouched); the db `rowEligibility` predicate gains `memory_type = ANY(...)` and `recorded_at >=/<=` branches spliced identically into every fusion leg (leg parity preserved); core threads the filters through unchanged. Fusion weights and ranking are untouched — filters narrow candidates pre-fusion only.

### Patch Changes

- 1663683: Recorded-range hardening (issue #58): the recordedAfter/recordedBefore pair is now validated by one shared rule set (`recordedRangeIssues` in `packages/schema/src/recorded-range.ts`) applied by BOTH transports — the MCP search schema (searchQueryV2Schema, carried into V3) and the REST `GET /api/v1/memories` query schema. The REST list now rejects an inverted range as a 400 (parity with MCP — previously an empty 200), and both surfaces reject a bound with more than 3 fractional-second digits instead of silently truncating it to JS millisecond precision (Postgres stores `recorded_at` at microsecond precision, so a truncated bound could leak a boundary row past an inclusive bound). `searchFingerprint` now hashes the post-parse query text verbatim — both transport query schemas trim at parse, so the fingerprint hashes exactly the text core embeds (no behavior change for schema-parsed callers).

## 0.5.0

### Minor Changes

- d5080cd: Add validated, SSRF-safe OAuth Client ID Metadata Document resolution and bounded HTTP caching.
- b88a6fa: Support Client ID Metadata Documents across OAuth discovery, authorization, token exchange, and grant management while retaining dynamic registration fallback.

## 0.4.1

### Patch Changes

- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.
- b956a15: Add billing-neutral, optional live-memory and active-MCP-client limit primitives
  with exact transactional enforcement, explicit transport errors, and an exported
  server compatibility sentinel. Omitted limits remain unlimited for self-hosting.

## 0.4.0

### Minor Changes

- fb2487a: Reshape into a clean, self-hostable OSS core. Remove the billing/subscription surface and replace the `CloudExtension` seam with a neutral `Extension` seam (`resolveLimits` / `AccessGate` / `onAccountDeletion` / export enricher), all with no-op self-host defaults. Keep the budget cost-cap as a self-host feature. Consolidate docs into a single Mintlify tree and make CI fork-friendly (pgvector service container instead of hosted branches).

## 0.3.0

Initial public release.
