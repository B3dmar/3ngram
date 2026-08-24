# @3ngram/core

## 0.11.0

### Minor Changes

- 6421161: fix(worker): back off a consistently-failing closer row instead of retrying it every sweep tick

  `removeOnFail: true` (PR #181) frees a closer job's id the moment its retries exhaust, so
  a row whose pass keeps throwing — a gateway outage, a persistently unparseable verdict, a
  DB blip on `finish` — was re-enqueued on EVERY later sweep tick, forever. Sorted oldest
  `closed_at` first, that row sat at the front of every bounded batch and starved every
  newer session sharing the window.

  Migration `0035` adds `agent_sessions.closer_failure_count` (int) and
  `closer_next_attempt_at` (timestamptz, nullable). `closeSessionRun` wraps its pass in a
  try/catch: a thrown exception — never a deliberate skip, which already settles the row
  permanently or stays eligible on purpose — stamps the count and a doubling backoff (base
  one sweep tick, capped at 4 hours; `closerBackoffDelayMs`, `CLOSER_BACKOFF_BASE_MS` /
  `CLOSER_BACKOFF_MAX_MS`, `@3ngram/schema`) before re-throwing, so the job still fails and
  BullMQ still retries. The stamp fires **once per enqueued job whose BullMQ retries are
  exhausted, not once per attempt** (`CloserOptions.isLastAttempt`, fed from
  `job.attemptsMade`/`job.opts.attempts` in `apps/worker/src/queues.ts`) — without that gate,
  a single enqueue that fails all 3 of `CLOSER_JOB_OPTS`' tries would stamp the row three
  times in under two minutes and blow through the cap for what may have been a sub-two-minute
  blip. The candidate scan's WHERE clause (not the partial index — `closer_next_attempt_at
<= now()` is not IMMUTABLE, so `CREATE INDEX` refuses it) gates on it, including the
  `completed`+`needs_look` leg. Both columns reset to zero/`NULL` on a durable write-back
  (the closer's own `finishSessionTriage`, or the interactive handshake's
  `completeSessionTriage`) or a genuine resurrect — all three resurrect writers now reset it
  (the write-time attach, `openSession`'s reopen, and Stop's own `refreshLease` resurrect
  branch), not just the first one shipped with.

  The GDPR export carries both new columns, and account erasure resets them alongside
  `needs_look`.

- 05aa7ae: perf(db): bound the session-closer candidate scan by backlog, not history

  `completed` is the terminal state of the closer's happy path and was never left, so
  every session a tenant had ever run stayed in `agent_sessions_closer_idx`, sorted
  first by `closed_at`, and each sweep tick paid an untriaged-event `EXISTS` probe on
  all of them to find nothing. The work grew with age rather than load.

  Migration `0034` adds `agent_sessions.needs_look` and narrows the index predicate to
  `closed_at IS NOT NULL AND triage_status <> 'overflowed' AND (triage_status <>
'completed' OR needs_look)`, so settled history leaves the index entirely. The flag
  is raised by a provenance write that attaches to an already-`completed` run, and
  recomputed by every watermark stamp against the set it just wrote — a stamp that
  leaves an event untriaged re-raises it, which is what keeps the late-commit race
  (a `memory_events` id assigned at INSERT but visible at COMMIT) covered. The
  `EXISTS` backstop is unchanged; it is now paid only on flagged rows. Existing
  `completed` rows are backfilled by the same probe during the migration.

  The GDPR export carries the new column, and account erasure resets it alongside the
  watermark it derives from.

- 69059d7: fix(core): fence the session closer against account erasure

  Account erasure redacted `agent_sessions` (excerpt, briefed topics, project/scope)
  but never touched `activation_epoch`, so an in-flight closer pass that had already
  claimed a run could still send the pre-erasure excerpt and briefed topics to the
  external LLM gateway, and could still write a `resolve` against the tombstoned
  account — the epoch fence the closer relies on for every other resurrection case
  had nothing to trip.

  `eraseAccountData` now increments `activation_epoch` on every one of the account's
  `agent_sessions` rows in the same `UPDATE` as the redaction. Two fences follow
  from that:

  - The closer re-checks the epoch after reserving its budget slot, immediately
    before dispatching to the gateway — the last point before the excerpt/topics
    leave the process. This is a **narrowing** fence, not a serialized handoff: the
    check and the dispatch are adjacent statements with no awaited work between
    them, but the check is a read, not a lock, so it does not serialize against an
    erasure commit. The claim is a fence, not an exclusive lease, so more than one
    of an account's runs can be claimed and mid-pass at once — the honest bound is
    one racing dispatch **per concurrently-executing closer pass**, bounded by
    worker concurrency (one job at a time per replica today) times replica count,
    not a single request account-wide. Each one that does dispatch is on the wire
    for up to the gateway's timeout (30s default) before it completes. Closing that
    fully would mean holding a lock across every in-flight pass's network call,
    which the design explicitly rejects (couples erasure latency to the gateway's,
    inverts the repo's no-lock-across-network-call rule).
  - Each `resolve` the closer writes is now fenced **inside the same transaction as
    the write, ordered lock-then-read**: `transitionCommitment` (exported from
    `@3ngram/db`) locks the commitment row (`FOR UPDATE`) before reading the run's
    CURRENT `activation_epoch` in its own separate, freshly-snapshotted statement,
    and raises the new `SessionEpochFencedError` when it no longer matches the
    `stampedSessionEpoch` the caller supplies. Locking first is load-bearing: an
    epoch check folded into the write's own `WHERE` (an `EXISTS(...)` against
    `agent_sessions`) looks equivalent but is not — Postgres re-checks a
    blocked-then-woken UPDATE's own target row fresh (EvalPlanQual), but a
    sub-SELECT against another table inside that WHERE still runs under the
    statement's original snapshot, so it can read a pre-erasure epoch even after
    erasure has already committed. This one **closes** the gap rather than
    narrowing it — both orderings (the closer's transaction locks the row first, or
    erasure's bulk commitments UPDATE does) serialize correctly.

  A pass fenced at the gateway boundary releases its budget reservation, unbilled,
  and settles cleanly on the next sweep: the erasure also cleared
  `briefed_memories`, so the re-enqueued row hits `nothing-briefed` and terminates
  before ever reaching the gateway. A `resolve` fenced at the write returns a new
  `'epoch-fenced'` outcome from `resolveForClosedRun`, which the closer maps to the
  same pass-abandoning `fenced` behavior as every other epoch-fence hit — never
  retried, never counted as an ordinary per-candidate skip.

  No migration: `activation_epoch` already existed as the closer's fence column.

- 67b0c02: Age-guard the Stop nudge's `pending` decline so concurrent Stop deliveries cannot double-nudge one turn's work (issue #188).

  `triage/begin` hands the in-flight `attemptId` back on a `pending` decline so a later ordinary Stop finalizes the attempt instead of injecting again. That is safe when one process handles one Stop, and unsafe when two handle the _same_ Stop — which is what a duplicate registration of the hook's `stop` and `heartbeat` aliases produces, since a harness runs every matching hook for an event concurrently. The sibling would complete the arming process's attempt while it is still fetching the debrief, so that continuation's writes commit outside the stamped watermark, a later Stop re-arms, and the documented bound of _one nudge per turn that produced new provenance_ breaks.

  `agent_sessions` now carries `triage_armed_at` (migration `0036`), stamped by the arm alongside the attempt token, and `begin` decides by AGE: an attempt younger than `SESSION_TRIAGE_MIN_ATTEMPT_AGE_SECONDS` (default 30, bounded 1–600) declines with the new reason `pending-fresh` and **withholds** the `attemptId`. Withholding is the whole mechanism — the token is the capability to finalize, and the hook keeps no threshold, clock or arm time of its own. The separation is wide: a sibling reads the row milliseconds after the arm, a genuine later Stop is a whole model turn away.

  A finalize-only Stop is EXEMPT: `triage/begin` accepts an optional `stopHookActive`, forwarded verbatim from the harness payload, and skips the age guard when it is true. Deferring a finalize is not free — the attempt stays `pending` across the user's next turn, and the Stop that eventually completes it absorbs that turn's events into the cumulative watermark, where nothing can re-arm on them and the closer no longer selects them. The exemption cannot be reached on the delivery that can inject (that one is `stop_hook_active=false` by definition), and two concurrent finalize deliveries are settled by the existing `(status = 'pending', attempt id)` fence: one stamps the outcome, the other gets a 409, and neither may inject. A harness that never sets the field — Codex has none, Gemini CLI 0.30.0 hardcodes it false — keeps the deferral. The hook omits the field when false, so the arming path stays wire-compatible with a 7a server whose begin body is strict.

  `GET /api/v1/export` now serializes `triageArmedAt` for every agent session, matching the generated OpenAPI contract.

  `TriageDebounceThresholds` gains the required `minAttemptAgeMs`, so a composition root that builds the thresholds by hand must supply it; `loadSessionTriageConfig()` already does. `BeginTriageOptions` gains an optional `armNow` clock, read at the arm point so a slow `begin` cannot stamp an attempt as already aged.

  The age is a cross-instance subtraction — the arming process's stamp against the reading process's clock — so the guard assumes NTP-synchronised app instances. A slow reading clock only defers a finalize by one Stop; a reading clock more than the floor fast relative to the arming one reopens the race. Deriving the age where it was stamped is impossible (Stop is a fresh process per delivery), and a database clock would break the injected-clock convention the module's testability rests on, so the assumption is documented rather than engineered around.

  `triage_armed_at` is nullable and a NULL age reads as "finalize", so rows armed before this migration keep the pre-guard behavior. Deferring a finalize costs at most one Stop: a `pending` row can never arm a second injection, age only grows, and `pending` is unconditionally closer-eligible if the session ends first. An older hook needs no update — `pending-fresh` carries no `attemptId`, so the finalize it declines to authorize is unreachable either way.

### Patch Changes

- Updated dependencies [6421161]
- Updated dependencies [05aa7ae]
- Updated dependencies [69059d7]
- Updated dependencies [67b0c02]
  - @3ngram/schema@0.9.0
  - @3ngram/db@0.10.0

## 0.10.0

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

- 54a7993: Add the server half of the Stop-nudge handshake (issue #166 step 7a): `POST /api/v1/agent-sessions/triage/begin` and `/triage/complete`. Both address the row by the natural key `(agent, sessionId)` in the body, with the tenant from the API key — Stop is a separate process that holds the harness conversation id and nothing else. The client half is the step 7b hook (`3ngram-hook stop`), which ships in this same release and calls these routes only behind `THREENGRAM_STOP_NUDGE=1` — the nudge remains default-off.

  `begin` decides on the SERVER and answers `armed`; the hook injects only when armed. The entry rule is `idle` always, `completed` and `expired` only on a re-arm signal (a provenance event for the run whose id is outside `last_triaged_event_ids`), `pending` hands back the attempt already in flight so a later Stop finishes it rather than double-injecting, and `overflowed` is terminal. `expired` deliberately behaves like `completed` for entry: a zero-write continuation must not nag on every later Stop. The debounce requires session substance — a minimum turn count (`SESSION_TRIAGE_MIN_TURNS`, default 3) **or** elapsed time since `opened_at` (`SESSION_TRIAGE_MIN_ELAPSED_MINUTES`, default 10) **or** that same untriaged-event signal. The thresholds are tunable; the condition is not optional. A decline is a 200 carrying a content-free reason; only an unknown natural key is a 404. Both routes hand the raw body to core, which parses it once — the single validation boundary `remember` already establishes; a transport only re-parses when it must echo a normalized value, and neither triage response does.

  `complete` absorbs whatever the continuation wrote: `completed` when the run produced provenance since the attempt began, `expired` when it produced none so the closer still runs, `overflowed` past the per-run event ceiling. The watermark it stamps is the FULL bounded visible set for the run, cumulative rather than the since-begin slice — storing only the slice would re-arm immediately on the events that armed the debounce. `since_begin` is a set difference against the set `begin` stamps when it arms, so it needs no second listing, no new column, and neither of the shortcuts the design rules out (`max(createdAt)`, or "ids greater than X in uuidv7 order" — a late-committing write can hold an earlier uuidv7). Both statements reuse the existing bounded `listSessionEvents` machinery and the `memory_events` expression index.

  A stale `complete` cannot clobber a newer attempt: the stamp is fenced on `triage_attempt_id` AND on the run still being `pending`, so a crashed hook retrying, a second Stop, or a closer that re-claimed the row after the lease expired mid-handshake all get a `409` instead. That last case is the coexistence boundary the fence exists for — the closer runs on closed rows and claims them by compare-and-set on the same column, while the handshake only ever runs on leased-open rows and never resurrects one, so a nudge can neither reopen a session the closer has claimed nor advance the epoch under it.

  Because `triage_attempt_id` now has two writers, the closer's claim also **retires an abandoned handshake, `pending` → `expired`**, and asserts `closed_at IS NOT NULL`. A closed row still marked `pending` is an attempt whose session ended before `triage/complete`, so `expired` — the existing word for a triage attempt that produced no completion, and unconditionally closer-eligible — is simply the truth. Without it, a resurrection (which preserves both columns) would republish the closer's token through `begin`'s `pending` reply and let the hook finalize an attempt whose session had already died, stamping `completed` — which is _not_ closer-eligible — off ordinary post-resurrection MCP traffic. The invariant it buys is that **`pending` means an interactive attempt is in flight, and nothing else**.

  A native write that attaches to a `completed` run now atomically restores `triage_status` to `idle`, folded into the same UPDATE the attach already runs — `completed` is not terminal. It costs no extra statement, no extra lock and no rescan of the stored set: the transaction is inserting a brand-new uuidv7 event id, which by construction cannot be in a watermark stamped before it existed.

### Patch Changes

- 1160f1a: Add `agent_sessions` and a `memory_events` sessionRunId index (issue #166 step 2). Import payloads reject the reserved `sessionRunId` key. Account erasure redacts session rows in place; the GDPR export includes them.
- 5af5010: Native writes accept optional `sessionRunId` and stamp `{ sessionRunId }` on audit events. Import still rejects the key. Unknown run ids fail the write; an explicitly closed row succeeds unattributed and is never resurrected; a stale lease resurrects then attaches, and a successful attach refreshes the lease. Concurrent writes carrying the same stale run id resurrect it exactly once — `activationEpoch` advances one step per resurrection, never one per writer, so a claim fenced at the new epoch stays valid. Omitted id uses the single leased-open session for the project. `POST /api/v1/memories/:id/archive` gains an optional body carrying the same field, and the SDK's `resolve()` takes an optional `{ sessionRunId }`. The SDK's `remember()` now takes/returns the facts-capable `RememberToolArgsV2`/`RememberToolOutputV2` types instead of the V1 pair. Resolving a commitment to the status it already holds stays idempotent but now validates a supplied `sessionRunId` too: such a request previously succeeded with an unowned or nonexistent id and is now rejected as invalid input, the same as every other native write. Lease refreshes are monotonic — a heartbeat or resurrect can only move `lastSeenAt` forward, so a slow writer cannot shorten a lease a later one already extended.
- 62317d9: Add the typed provenance read: `GET /api/v1/agent-sessions/{sessionRunId}/events` lists the audit events one agent-session run produced (issue #166 step 4). Items carry `id`, `memoryId`, `eventKind`, `actorKind`, `sessionRunId` and `createdAt` — this is a narrowing of the payload-redaction rule to exactly one key, read with a jsonb operator and parsed through `sessionProvenancePayloadSchema`; the memory-history DTO stays metadata-only. Pagination is a keyset on the uuidv7 event `id` with a bounded per-call `limit` and the per-run `MAX_SESSION_EVENT_IDS` ceiling, which reports `truncated: true` rather than paging past it. A run id this tenant does not own is rejected as invalid input, the same as on the native write path.

  `sessionRunId` now canonicalizes to lowercase at one shared boundary (`sessionRunIdSchema`), reused by native remember/revise, `resolve`, the archive body, the provenance payload and the new read. The accepted input set and every exported TypeScript type are unchanged — an uppercase UUID was always valid and still is — but a parsed value is now returned lowercased. This matters because the reader compares `payload->>'sessionRunId'` as text: an uppercase spelling used to clear the uuid-typed ownership check and then match nothing, returning an empty page for a run that has events.

- 1f4c763: Add the hook-facing session-lifecycle REST surface (issue #166 step 5a): `POST /api/v1/agent-sessions/open`, `/close` and `/heartbeat`, plus `GET /api/v1/prompts/debrief`. All four address the row by the natural key `(agent, sessionId)` in the body or query — Stop and SessionEnd are separate processes that hold the harness conversation id and nothing else, so close carries no `activation_epoch` and nothing has to persist a local run-id mapping. The tenant always comes from the API key.

  `open` is idempotent by that natural key, which doubles as the request token: `startup` inserts at `activation_epoch` 1 and stamps the briefed rows the hook reports after its local truncate; a duplicate `startup` delivery with the same `project`/`scope`/`selector` changes nothing, and one with different values is a `409`. `resume` reuses the row, advances the epoch, reopens a closed or lease-expired row and refreshes the lease — without restamping the briefing. `close` sets `closed_at` once (a repeat echoes the first timestamp), deliberately freezes `last_seen_at` so `closed_at <= last_seen_at + lease` keeps identifying an explicit SessionEnd, and never clears an excerpt the closer has not consumed. `heartbeat` refreshes the lease monotonically, resurrects a closed or lease-expired row, and optionally snapshots the turn's bounded `last_assistant_message`.

  `GET /api/v1/prompts/debrief` renders the same debrief text the MCP `debrief` prompt serves — one renderer, two transports — and inlines the run's `briefed_memories` as an id → topic/status mapping so the model can tell which commitment to resolve. Instructions are server-authored and every caller- or tenant-supplied value renders inside a fenced JSON block whose fence grows past the longest backtick run in the payload; the MCP `debrief` prompt changed to the same delimited-data shape, so `scope` and `project` are no longer interpolated into its imperative sentences.

  The rendered resolve instruction is conditional on that mapping: with one, the prompt narrows resolution to the listed ids; without one — which is every MCP render, since a prompt carries no tenant data — it keeps telling the agent to resolve the commitments it completed, unchanged from before.

  Also hardens the native write-attach path: the re-read under the attach advisory lock is now `SELECT ... FOR UPDATE`, so a concurrent close cannot commit between the resurrect decision and the resurrect it justified and silently reopen an explicitly closed session. The close route is the first writer of `closed_at`, which is what made that race reachable.

- Updated dependencies [1160f1a]
- Updated dependencies [5af5010]
- Updated dependencies [809ae0e]
- Updated dependencies [62317d9]
- Updated dependencies [1f4c763]
- Updated dependencies [54a7993]
  - @3ngram/schema@0.8.0
  - @3ngram/db@0.9.0
  - @3ngram/llm@0.3.0

## 0.9.3

### Patch Changes

- Updated dependencies [33d1a7f]
  - @3ngram/schema@0.7.3
  - @3ngram/db@0.8.3

## 0.9.2

### Patch Changes

- 1ebd82c: Remove the self-imposed MCP surface caps; a gated eval replaces them.

  **`MAX_TOOLS = 12` and `MAX_PROMPTS = 2` are gone.** Both were 3ngram's own discipline, entered at the `v1.0.0` launch commit and sourced to nothing upstream — the specification defines no maximum tool count and paginates `tools/list`, and the pinned SDK enforces no limit. Neither constant was ever exported past its module and neither appears in the public API report, so there is no runtime or API change for any client: the server still registers exactly 11 tools and 2 prompts, with the same names, schemas, and annotations.

  **What replaced them is a measurement of the thing they proxied for.** The `tool-selection` eval slice moved from report-only to gated: `selection_accuracy_at_1` (0.8545) and `selection_margin` (0.1097) are recorded as floors, and `max_description_overlap` (0.6737, `briefing` ~ `handoff`) as a ceiling — a metric where lower is better, so `eval/fixtures/floors.json` gained a `ceilings` block with its own comparison rather than storing an inverted floor. A twelfth tool is no longer blocked; a twelfth tool whose description reads like an existing one now fails a required check, and the failure names the offending pair. This is the sequencing `docs/concepts/mcp-surface.mdx` prescribed — re-set the cap last, and record the reasoning as description overlap and selection accuracy rather than a number inherited from launch day — except that nothing was re-set to a new number, because a fresh figure with no measurement under it would have reproduced the original mistake higher up.

  `@3ngram/core` is included for a comment-only change: `write/archive.ts` justified its REST-only surface by citing hard rule 8 without its reason, which no longer reads correctly now that the rule is an evidence test rather than a count. No behavior changed in core.

  **The docs generator no longer arbitrates the surface.** `generate-mcp-reference.ts` threw above both ceilings, which put the argument in the one place that cannot measure either metric; the generated `docs/reference/tools.mdx` and `prompts.mdx` now cite the eval instead. `AGENTS.md` hard rule 8 became an evidence test (JTBD, regenerated surface snapshot, eval scenarios) with its enforcement named, alongside every other hard rule.

- Updated dependencies [851fa53]
  - @3ngram/schema@0.7.2
  - @3ngram/db@0.8.2

## 0.9.1

### Patch Changes

- 483c658: Five correctness fixes to the facts, portability, and retrieval surfaces.

  **`fact_proposals` is now erased on account deletion.** Account deletion tombstones the `users` row rather than deleting it, so the FK's `ON DELETE CASCADE` never fires — a staged fact proposal kept its `subject`, `predicate`, `value`, and `rationale` through an Article 17 erasure. It is now redacted in place in the same transaction as `facts` and `consolidation_proposals` (redact-in-place, not DELETE: the runtime role has no DELETE grant on memory-domain tables). The erasure receipt gains a `factProposals` count on `DELETE /api/v1/account` and in the audit tombstone.

  **`fact_proposals` is now included in the portability export.** `GET /api/v1/export` carried `facts` and `consolidation_proposals` but not the staged proposals, which are user content that is not yet a `facts` row. The archive gains a `factProposals` section (and a matching `counts.factProposals`), read under the same repeatable-read snapshot as every other section.

  **Chronological search now rejects a `query` instead of silently ignoring it.** `order: 'chronological'` is an unranked enumeration and the core path takes no query argument, so a caller passing `{order: 'chronological', query}` was returned the whole live corpus as though it had been searched. A present `query` is now a validation error naming `order: 'relevance'` as the ranked alternative. Because `query` no longer bounds the scan, chronological order now REQUIRES at least one filter (previously "query or >=1 filter").

  **Fact write timestamps no longer truncate to milliseconds.** `validFrom`/`validTo` on a written fact accepted arbitrary fractional-second precision, but core converts them with `new Date()` (millisecond) on the way to microsecond-precision Postgres columns — a finer instant silently moved the boundary of a bi-temporal window. Both bounds are now capped at 3 fractional-second digits and REJECTED beyond it, matching the facts-range read bounds, with the limit advertised in the field descriptions.

  **Imported `updates` edges no longer mark live memories superseded.** The `superseded` flag and its ranking tier-penalty counted any incoming `supersedes`/`updates` edge, but the import contract forbids `closePredecessorAt` on an `updates` edge — so every imported `updates`-edge target stayed live (`valid_to IS NULL`) yet read `superseded: true` and was demoted in ranking. The predicate now requires BOTH a revision edge AND closed validity, the same definition `memory_history`'s `lifecycleState` applies, so search and history can no longer disagree about the same row. Genuine revisions are unaffected: the revise path closes `valid_to` for both edge kinds.

- Updated dependencies [483c658]
  - @3ngram/db@0.8.1
  - @3ngram/schema@0.7.1

## 0.9.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [eb68c04]
- Updated dependencies [d18e749]
- Updated dependencies [c6a819c]
- Updated dependencies [91f1d39]
- Updated dependencies [88ee7d4]
- Updated dependencies [4ed7e25]
- Updated dependencies [4cd03d4]
- Updated dependencies [1d9a420]
- Updated dependencies [318025a]
  - @3ngram/db@0.8.0
  - @3ngram/schema@0.7.0

## 0.8.6

### Patch Changes

- Updated dependencies [43a200c]
  - @3ngram/schema@0.6.4
  - @3ngram/db@0.7.5

## 0.8.5

### Patch Changes

- 1263111: Stop issuing refresh tokens to OAuth clients that never advertised the `refresh_token` grant (issue #86).

  The authorization-code exchange minted a refresh token unconditionally, but the token route gates the refresh grant on the client's advertised `grant_types`. A client registered for `authorization_code` alone — which is also the schema default when a CIMD document omits `grant_types` entirely — therefore received a refresh token that the very next request rejected as `invalid_client`. Nothing in the token response signalled that, so the client had no way to know the credential was inert until it tried to use it and lost its session.

  Issuance now matches what the authorization server will actually honour: the refresh token is omitted from the response and its hash is not persisted, since a hash for a token no client was ever handed can never be presented or rotated. `refresh_token` on the token response is now optional, which is what RFC 6749 §5.1 always specified.

  Rotation additionally fails closed if a client's advertised grants are narrowed between issuance and rotation, rather than revoking the predecessor and minting no successor.

  This predates the CIMD grant-type narrowing in #85 — `grant_types: ['authorization_code']` has always been accepted.

- Updated dependencies [1263111]
  - @3ngram/db@0.7.4

## 0.8.4

### Patch Changes

- Keep `engines.node` at `>=22`. The Node 24 work should only have moved what we build, test and ship on — CI and the container base — not what consumers must run. Nothing in this closure uses a Node 24 feature, and Node 22 is supported upstream until 2027-04-30, so raising the published floor would have hard-failed Node 22 consumers on a patch release. Raising it becomes a deliberate major when there is a reason.
- Updated dependencies
  - @3ngram/db@0.7.3
  - @3ngram/schema@0.6.3
  - @3ngram/llm@0.2.4

## 0.8.3

### Patch Changes

- 6e06cd6: Build, test and ship on Node 24 (Active LTS). CI, the release workflow and the server image base move to Node 24 — `node:24-bookworm-slim`, digest-pinned. `engines.node` deliberately stays `>=22`: nothing here requires a Node 24 feature, so consumers on Node 22 (supported until 2027-04-30) remain supported.
- Updated dependencies [6e06cd6]
  - @3ngram/db@0.7.2
  - @3ngram/schema@0.6.2
  - @3ngram/llm@0.2.3

## 0.8.2

### Patch Changes

- Updated dependencies [75ff6f4]
  - @3ngram/schema@0.6.1
  - @3ngram/db@0.7.1

## 0.8.1

### Patch Changes

- 4d0d05d: Fix every CIMD client resolution failing under a real ESM runtime.

  `client-metadata.ts` imported `ipaddr.js` as a namespace (`import * as ipaddr`). That package is CommonJS with `module.exports = ipaddr` and no `exports` map, so Node's ESM interop — which relies on `cjs-module-lexer` finding statically scannable assignments — synthesizes no usable named exports. Every member of the namespace was `undefined` at runtime, so the first call, `ipaddr.isValid(...)` in `resolveHostnameDefault`, threw a `TypeError`. `resolvePublicTarget` catches any resolver throw and relabels it `dns_failure`, so **every** Client ID Metadata Document resolution failed — for hostnames and IP literals alike, with no network I/O — and surfaced to the client as a bare `400 invalid_client` attributed to DNS.

  Vitest never saw this: Vite pre-bundles CJS dependencies through its own interop and synthesizes the named exports, so the module shape under test was not the shape the deployment got.

  The import is now a default import. `scripts/check-cjs-namespace-imports.mjs` guards the class: it imports every namespace-imported bare specifier through real Node ESM resolution (a throwaway sibling module, not `createRequire().resolve()`, which would select the `require` export condition and check a different file than `import` loads for a dual package) and fails when a member the source uses is absent. Detection is by member use rather than export count, because `ipaddr.js`'s namespace is not empty — the lexer emits a literal key named `module.exports`, which makes "has some named export" a false pass — and covers destructuring (`const { isValid } = ipaddr`) as well as property access, since both yield `undefined` in production.

  The script is **not yet wired into CI**: adding the `workspace-checks` step requires a token with `workflow` scope. Until that lands it runs manually via `node scripts/check-cjs-namespace-imports.mjs`.

## 0.8.0

### Minor Changes

- 7af346c: Fix CIMD client resolution failing closed on IPv4-mapped DNS answers, and record why an `/oauth/authorize` request was rejected.

  `resolvePublicTarget` compared the DNS-reported address family against `ipaddr.process()`, which UNMAPS `::ffff:a.b.c.d` to its IPv4 form. A resolver reports that answer as family 6, so the unmapped kind (`ipv4` → 4) disagreed with it and a perfectly self-consistent answer was treated as forged: every Client ID Metadata Document fetch on such a resolver failed closed with `unsafe_address` before a socket was opened, surfacing as a bare `400 { "error": "invalid_client" }`. The agreement check now uses `ipaddr.parse()`, which preserves the wire form. The security boundary is unchanged — `isPublicClientMetadataAddress()` still unmaps via `process()`, so a mapped loopback or private answer is still rejected.

  `/oauth/authorize` now emits one structured, content-free line per REJECTED request (`oauth: authorize endpoint`) carrying a hashed `client_id_prefix` and a closed-set `reason` — `not_registered`, `metadata_*` for each CIMD failure class, `metadata_not_materialized`, `unsupported_grant_type`, or `redirect_uri_mismatch`. Previously every one of those returned an identical bare 400 with nothing written anywhere, so a stale registration and a metadata document that never loaded were indistinguishable in production logs. The response is unchanged (still a uniform `invalid_client`, no enumeration oracle); the reason is diagnostic only.

  `resolveOAuthClient()` takes a new optional `options.onFailure` callback carrying the `ClientResolutionFailure` reason. Existing two-argument callers are unaffected.

## 0.7.0

### Minor Changes

- ba229fa: Briefing bounds V2 (issue #45): core `briefing()` honours the caller-tunable `sectionLimit` (clamped to the server-side ceiling of 100) and a `sections` subset — un-requested sections are skipped entirely (fewer queries) and omitted from the result; every returned section now carries `hasMore` (`count > items.length`). Brief mode fetches only its top slice since exact counts ride the `count(*) OVER()` window. The MCP `briefing` tool registers the composed V2 input/output schemas; a legacy `{selector, mode}` call returns the same sections as before plus `hasMore`.
- cfb7d50: Handoff bounds V2 (issue #45): core `handoff()` honours the caller-tunable `sectionLimit` (default 25, clamped to the server-side ceiling of 100) and stops discarding the exact window totals the briefing-read queries already compute — the envelope now carries `counts: {decisions, commitments, preferences}` plus per-section `truncated` flags (`counts.X > X.length`). The MCP `handoff` tool registers the composed V2 input/output schemas; a legacy `{selector, generatedFor?}` call returns the same lists as before plus the additive totals.
- b704728: Add the batched bounded-content read that backs the upcoming `get_memories` MCP tool: `getMemoriesInputSchema`/`getMemoriesOutputSchema` (own bounded module `get-memories.ts`; ids 1–20, `maxContentChars` 600–65,536 with default 10,000, aggregate `ids × maxContentChars` capped at 262,144, `count` enforced to equal `memories.length`) at the one validation boundary, a single-query `getMemoriesByIds` db read (`id = ANY` under one `withTenant`, RLS-safe), and core `getMemoriesByIds(userId, ids, { maxContentChars })` returning `{ memories, notFound }` — a missing or cross-tenant id is data (`notFound`), never an error. `excerptContent` now accepts an optional max-chars argument; existing call sites keep the shipped 600-char excerpt behavior.
- 11d1916: Retrieval-scope policy enforcement in core (issue #47, layer 2 of 3). Read surfaces accept an injected `retrievalPolicy` (a strict discriminated union: `off` / `default`+scope / `require`+registered scopes), resolved once per request by the transport — core stays env-free (one core, N transports). Mode `default` fills a missing scope axis (search `scope` filter; briefing/handoff selector `kind: 'all'`) and the result ECHOES `appliedScope` — never silent; `require` throws the typed `UnscopedRetrievalError` (a `MissingSelectorError` sibling) naming the registered scopes, before any metered work; `off` is byte-identical to shipped behavior, and policy-less callers keep the exact shipped return types (`search()` returns the `ScopedSearchResult` envelope only via the policy overload — the briefing() overload precedent). `searchDashboardPage` enforces on every page of a walk. New services: `resolveRetrievalPolicy` (row → enforcement union; `require` pre-reads the registry so the error can name scopes) and `setRetrievalDefault` (asserts a `default` scope is registered — typed `ScopeNotFoundError` otherwise). `describeEnvironment` now reports `retrievalScopePolicy` (off default when unset). Stated decision: `getFacts` is NOT policy-enforced — the facts surface has no scope axis (no scope column/filter), so `default` has nothing to apply and `require` would brick the tool.

  Scope renames now carry an active retrieval default to the new name atomically. Deleting the active default switches the policy to fail-closed `require`; per-user transaction locks serialize both mutations with the policy setter.

- eb2ea4e: Per-user retrieval-scope policy store (issue #47, layer 1 of 3): a new `user_retrieval_policy` table (one optional row per user; RLS + FORCE, tenant-isolation policy, Zod-derived mode and consistency CHECKs) with `getRetrievalPolicy`/`upsertRetrievalPolicy` accessors under `withTenant()`. The policy is included in account portability exports and reset to the inert `off` state during tombstone-style account erasure. The schema contract lands in a bounded `retrieval-scope` module: the `set_retrieval_default` `configure_scope` action variant composed onto the shipped action union, the `retrieval_default_set` output variant, and the additive `describe_environment` `retrievalScopePolicy` report field. Storage + contracts only; read-path enforcement remains in the stacked core layer.
- a364654: Add the `scope_project` orientation selector variant (issue #46): `{kind:'scope_project', scope, project, includeUnscoped}` selects the scope AND project intersection the shipped union could not express, with `includeUnscoped` (default false) as the opt-in NULL-project mitigation — `scope = $s AND (project = $p OR ($includeUnscoped AND project IS NULL))` in the single `memoryScopePredicate` all six briefing sections and handoff inherit. The V2 selector union (`briefingSelectorV2Schema`, packages/schema/src/briefing-bounds.ts) is composed from the shipped variant objects, so the three shipped variants stay byte-identical and the bare `project` variant is NOT widened. Core `requireSelector` validates the new variant; the published `BriefingSelector` type carries it with a required `includeUnscoped`.
- 1471fcb: Search filters V2 (issue #48, layer 1 of 2): the MCP `search` tool accepts two new candidate-narrowing filter axes — `memoryTypes` (an OR-set of memory types, 1–8 entries, mutually exclusive with the scalar `memoryType`) and `recordedAfter`/`recordedBefore` (an inclusive transaction-time range on `recorded_at` that narrows the live view WITHOUT lifting the active-only default — unlike `asOf`, it is not time travel). New composed `searchFiltersV2Schema`/`searchQueryV2Schema` in `@3ngram/schema` (the shipped V1 schemas are untouched); the db `rowEligibility` predicate gains `memory_type = ANY(...)` and `recorded_at >=/<=` branches spliced identically into every fusion leg (leg parity preserved); core threads the filters through unchanged. Fusion weights and ranking are untouched — filters narrow candidates pre-fusion only.

### Patch Changes

- cf088c1: Restrict the briefing's `staleCandidates` section to a reviewable memory-type allowlist: `memory_type IN ('decision', 'preference', 'blocker', 'fact')`. The previous predicate excluded only `commitment`, so every other live memory older than the 30-day stale window qualified — in production that matched ~74% of active memories (dominated by bulk-imported `event`/`note` rows) and made the section unusable noise. The allowlist is core policy (`STALE_CANDIDATE_TYPES`, exported beside `STALE_WINDOW_DAYS`) and fails closed: future or imported memory types are excluded by default. `packages/db`'s `staleCandidates` now accepts the allowlist as an OPTIONAL trailing parameter (after `limit`); when omitted, the legacy NOT-`commitment` filter applies, so existing five-argument callers keep both their signature and their prior behavior. The briefing output shape is unchanged.
- Updated dependencies [58e3f9d]
- Updated dependencies [b704728]
- Updated dependencies [11d1916]
- Updated dependencies [eb2ea4e]
- Updated dependencies [0790813]
- Updated dependencies [a364654]
- Updated dependencies [2ecf3ab]
- Updated dependencies [351aee0]
- Updated dependencies [8598b09]
- Updated dependencies [1471fcb]
- Updated dependencies [1663683]
- Updated dependencies [cf088c1]
  - @3ngram/schema@0.6.0
  - @3ngram/db@0.7.0

## 0.6.3

### Patch Changes

- Updated dependencies [78c062c]
  - @3ngram/db@0.6.2

## 0.6.2

### Patch Changes

- 310e515: Make the production `DATABASE_URL` role-name check honor the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`), matching the RLS readiness guard. A deployment whose runtime connects as a differently-named `NOBYPASSRLS` role now passes env validation instead of being rejected for not using `app_user`.

## 0.6.1

### Patch Changes

- cea2989: Make the runtime RLS guard's expected role name configurable via the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`). This lets a deployment whose runtime connects as a differently-named `NOBYPASSRLS` role pass the readiness check, instead of the role name being hardcoded.
- Updated dependencies [cea2989]
  - @3ngram/db@0.6.1

## 0.6.0

### Minor Changes

- d5080cd: Add validated, SSRF-safe OAuth Client ID Metadata Document resolution and bounded HTTP caching.
- b88a6fa: Support Client ID Metadata Documents across OAuth discovery, authorization, token exchange, and grant management while retaining dynamic registration fallback.

### Patch Changes

- 69a66b3: Add RFC 9207 issuer identification to OAuth authorization responses and metadata.
- 63ebb77: Tenant-isolation hardening (fail-closed runtime guard): add a runtime RLS guard that asks the live database whether isolation is provably in force — the connected role is the expected NOBYPASSRLS/non-superuser runtime role and FORCE ROW LEVEL SECURITY is set on the tenant-data tables (forced-table set derived from the migrations). Wire it into a new `/ready` readiness endpoint (503 when it fails, keeping a misconfigured instance out of rotation) and as a boot-time fail-fast so a broken DB config can never begin serving traffic. Replace the string-match proof with a behavioral integration test and make the migration-drift RLS/policy checks enumerate migrations dynamically so a new tenant table that enables RLS without a tenant_isolation policy fails automatically.
- 2eb1ca8: Tenant-isolation hardening for the scopes registry: every scope query and mutation (list, rename, set-aliases, delete) and the environment-stats counts now carry an explicit caller-bound `user_id` predicate in SQL, in addition to RLS. Defense in depth — behavior is unchanged when RLS is active, since `(user_id, name)` is the natural key.
- 7c0c627: Add caller-bound `user_id` predicates to the briefing, facts, and dashboard memory reads (open/overdue commitments, live-memory and stale-candidate sections, getFacts, count/list/facets, getMemoryById) as a second tenant-isolation layer alongside RLS (defense in depth). Result sets are unchanged while RLS functions.
- e5c1a2e: Add caller-bound `user_id` predicates to every search read (FTS, recency, vector, fused legs, id fetch, and the similar-pairs self-join) as a second tenant-isolation layer alongside RLS (defense in depth). Result sets are unchanged while RLS functions.
- Updated dependencies [d5080cd]
- Updated dependencies [b88a6fa]
- Updated dependencies [63ebb77]
- Updated dependencies [2eb1ca8]
- Updated dependencies [7c0c627]
- Updated dependencies [2c1fede]
- Updated dependencies [e5c1a2e]
- Updated dependencies [535db7c]
  - @3ngram/schema@0.5.0
  - @3ngram/db@0.6.0

## 0.5.1

### Patch Changes

- e18e4a2: Bound every non-health HTTP surface with a coarse per-IP rate limit and replace trailing-slash regular expressions with linear-time normalization.
- Updated dependencies [e18e4a2]
  - @3ngram/llm@0.2.2

## 0.5.0

### Minor Changes

- 3d1f0ec: Add the REST-only ARCHIVE lifecycle operation: `POST /api/v1/memories/:id/archive` flips an active memory of any type to `status='archived'` (leaving `valid_to` NULL, so the row lands in the archived bucket that `GET /api/v1/memories?status=archived` and `GET /api/v1/stats` read) and records an `archive` audit event in the same transaction. Adoption-gate Decision D: no MCP tool mirrors this surface.

### Patch Changes

- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.
- b956a15: Add billing-neutral, optional live-memory and active-MCP-client limit primitives
  with exact transactional enforcement, explicit transport errors, and an exported
  server compatibility sentinel. Omitted limits remain unlimited for self-hosting.
- Updated dependencies [3d1f0ec]
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
  - @3ngram/db@0.5.0
  - @3ngram/llm@0.2.1
  - @3ngram/schema@0.4.1

## 0.4.0

### Minor Changes

- fb2487a: Reshape into a clean, self-hostable OSS core. Remove the billing/subscription surface and replace the `CloudExtension` seam with a neutral `Extension` seam (`resolveLimits` / `AccessGate` / `onAccountDeletion` / export enricher), all with no-op self-host defaults. Keep the budget cost-cap as a self-host feature. Consolidate docs into a single Mintlify tree and make CI fork-friendly (pgvector service container instead of hosted branches).

### Patch Changes

- Updated dependencies [fb2487a]
  - @3ngram/db@0.4.0
  - @3ngram/schema@0.4.0
  - @3ngram/llm@0.2.0

## 0.3.0

Initial public release.
