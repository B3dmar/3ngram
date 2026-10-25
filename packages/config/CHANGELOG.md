# @3ngram/config

## 0.6.0

### Minor Changes

- 1c874bf: `loadEnv` and `parseEnv` take an optional `{ role: 'server' | 'worker' }`. The worker now validates its env as role `worker`, which skips the server-only production requirements: `OAUTH_JWKS` (the worker signs no tokens) and `REDIS_URL` (only the server's rate limiter needs it; the resident BullMQ worker still fails at boot without it). `BASE_URL`, `LOG_HASH_SALT` and the `DATABASE_URL` checks still apply. With no argument, `loadEnv()` behaves as before (server role), and asking for a different role once the env is resolved throws. The exported `envSchema` is now the role-agnostic base and no longer carries the server-only production rules; validate through `parseEnv`/`loadEnv`. Closes #204, refs #315.
- dc5dd43: Add `Gateway.decide()` for typed judgments and a Jev (TypeSafe AI) provider (issue #225). `createJevGateway` uses raw fetch with one bounded attempt and no retries. It checks every answer against the questions asked, and its errors carry counts only. `createOpenAIGateway().decide()` throws `NotImplementedError`. `composeGateway` routes `decide` to Jev, and the fake gateway records `calls.decide` with a fail-closed low default. New env vars `JEV_API_URL`, `JEV_API_KEY` and `JEV_MODEL` take an explicit model pin and refuse `-latest`. The new metered operation is `session.closer.decide`. Nothing calls `decide()` yet, and judgment stays off unless `JEV_*` is configured.
  
  Breaking for custom `Gateway` implementations: `decide` is now a required method. A wrapper or test double that implements `Gateway` by hand must add one. It can reject with `NotImplementedError('decide')`, as the OpenAI gateway does.
- 2d36f37: `RATE_LIMIT_STORE=redis|postgres|memory` selects the server's rate-limiter store (#315). `postgres` backs every limiter with the `rate_limits` table on `DATABASE_URL`, and production then accepts a missing `REDIS_URL`. `redis` requires `REDIS_URL` and `postgres` requires `DATABASE_URL` in every environment. Unset keeps today's behaviour: Redis when `REDIS_URL` is set, in-memory outside production, a validation error in production. `memory` in production is an explicit single-replica opt-in that logs a boot warning; the server also refuses an implicit memory store in production at boot. `createRateLimiter` takes `store` in place of `redis`. Refs #315.

### Patch Changes

- eee7fe3: Add a one-shot worker entrypoint, `node dist/once.js <consolidation|surfacing|gc-clients>`, for cron-style schedulers (#315). It runs one pass without Redis, closes the database pool, and exits 0 on success, 1 on failure, or 2 for an unknown job. The resident BullMQ worker (`node dist/index.js`) stays the default. `@3ngram/core` re-exports `closeDb`, and `@3ngram/config/otel` adds `flushObservability` to drain Sentry events before a deliberate exit.

## 0.5.3

### Patch Changes

- 48b8972: Security: zod 4.6.6 (CVE-2023-54404, denial of service via unbounded array validation) on every package that pins it, and body-parser 2.4.0 under express (CVE-2026-111181, denial of service via an unhandled decompression stream error) through the workspace advisory override. The v1.9.0 release image scan blocked publication on both. body-parser 2.4.0 is newer than the 7-day registry cooldown, so it is a reviewed exact-version `minimumReleaseAgeExclude` entry until it matures. No API or behaviour change.

## 0.5.2

### Patch Changes

- de8ad09: `resolve` accepts an optional `reason` (issue #234) on MCP, `POST /api/v1/memories/:id/resolve` and the SDK (`client.resolve(id, status, { reason })`), so whoever settles a commitment can say what settled it — a PR number, "superseded by X" — in the same call. The reason is trimmed and must be 1–500 characters; an empty or longer one is rejected as invalid input before anything is written. It is stored on the commitment row (new nullable column `commitments.last_resolution_reason`, migration 0040, with a length CHECK generated from the schema bound) in the same transaction as the status change, never in the append-only audit event payload, which keeps carrying only `sessionRunId`. A reason explains one transition: any later status change without one clears it (including the surfacing sweep's expiry and a revise that demotes the commitment), a same-state no-op stores nothing, and a revise that keeps the commitment carries it with the row. A blocker has no commitment row, so a blocker resolve with a `reason` is rejected as invalid input (MCP error, REST 400 with a recovery detail) instead of being dropped. The reason is memory content: it is returned only by the authenticated, tenant-scoped `GET /api/v1/memories/:id/history` (new top-level `lastResolutionReason: string | null`) and by the owner's account export, never by briefing or search, never logged (its stored and core spellings join the log redaction list), and account erasure nulls it in place alongside `owner`. The tool description is unchanged.

## 0.5.1

### Patch Changes

- dfe6d68: Bump runtime dependencies to the newest releases past the 7-day release-age cooldown: `nodemailer` 10.0.12 -> 10.0.16 and `rate-limiter-flexible` 11.2.0 -> 11.2.1 in `@3ngram/server`, `pino` 10.3.1 -> 10.4.0 in `@3ngram/config`, and `@node-rs/argon2` 2.0.2 -> 2.2.2, `ipaddr.js` 2.4.0 -> 2.5.0 and `jose` 6.2.3 -> 6.2.12 in `@3ngram/core`. `@node-rs/argon2` 2.1.0 swapped its Rust backend from RustCrypto to argon2-rust; password hashes keep the same PHC format and parameters, and a unit test now verifies a hash minted by 2.0.2. 2.2.2 also drops the `wasm32-wasi` fallback package, so a platform without a prebuilt native binding (all linux gnu/musl x64/arm64, darwin and win32 targets still have one) no longer falls back to WASM. `ipaddr.js` 2.5.0 rejects malformed IPv6 literals it used to accept (a `::` that compresses no group, a group longer than four hex digits), which only narrows what the client-metadata fetch treats as an IP literal. `jose` 6.2.5-6.2.10 tighten JWS/JWT input validation; the RS256 access tokens this package signs and verifies are unaffected.
- 48c0ad5: Bump `@sentry/node` from 10.56.0 to 10.76.0, the newest 10.x release past the 7-day release-age cooldown. Default integrations, the legacy `sendDefaultPii`-off data-collection mapping, request-body capture and `beforeSend`/`beforeSendTransaction` processing are unchanged for this config; `enableLogs` now defaults to `true` upstream, but no log-forwarding integration is enabled here, so nothing new is sent.
- 34f1985: Bump `zod` from 4.4.3 to 4.6.5, the newest release past the 7-day release-age cooldown. Datetimes keep the zod 4.4.3 grammar: zod 4.5 began requiring seconds on any time with `Z` or an offset, so every datetime field now goes through the new `isoDateTime()` helper in `@3ngram/schema`, which supplies the 4.4.3 pattern. Minute precision such as `2026-01-01T06:15Z` still parses, the `invalid_format` issue is unchanged, and the emitted `date-time` pattern is byte-identical. `@3ngram/schema` gains two exports for this, `isoDateTime` and `IsoDateTimeOptions`. Remaining upstream changes: the email pattern is rewritten without lookaheads but accepts the same addresses (checked against 4.4.3 on edge cases such as `a..b@x.com` and `.a@x.com`); string length bounds count Unicode code points instead of UTF-16 code units, matching Postgres; a strict object with an unknown key and a bad value now reports both issues; and emitted JSON Schema (MCP `tools/list`, OpenAPI) writes a nullable primitive as `type: [T, "null"]` instead of a two-branch `anyOf`. Consumers that compose `@3ngram/schema` schemas or types with their own `zod` must move `zod` to 4.6.5 in lockstep: zod's declarations carry the minor version as a literal type, so passing a schema from one copy into another copy's `ZodType`, `z.array()` or `z.union()` fails to typecheck.

## 0.5.0

### Minor Changes

- 61bc6bc: The surfacing sweep no longer expires a commitment the moment its due date passes. A new `COMMITMENT_EXPIRY_GRACE_DAYS` setting (default 14, 0 restores the old behaviour) keeps an overdue commitment open (or waiting), and therefore visible in the briefing's overdue section, for that many days before the worker expires it (issue #221). Library callers of `surface()` and `sweepCommitments()` that omit the new optional argument keep the previous immediate-expiry semantics; `loadSurfacingConfig()`, `SurfacingPolicy`, `expiryCutoff()` and `LEGACY_SURFACING_POLICY` are new exports.

## 0.4.0

### Minor Changes

- 67b0c02: Age-guard the Stop nudge's `pending` decline so concurrent Stop deliveries cannot double-nudge one turn's work (issue #188).

  `triage/begin` hands the in-flight `attemptId` back on a `pending` decline so a later ordinary Stop finalizes the attempt instead of injecting again. That is safe when one process handles one Stop, and unsafe when two handle the _same_ Stop — which is what a duplicate registration of the hook's `stop` and `heartbeat` aliases produces, since a harness runs every matching hook for an event concurrently. The sibling would complete the arming process's attempt while it is still fetching the debrief, so that continuation's writes commit outside the stamped watermark, a later Stop re-arms, and the documented bound of _one nudge per turn that produced new provenance_ breaks.

  `agent_sessions` now carries `triage_armed_at` (migration `0036`), stamped by the arm alongside the attempt token, and `begin` decides by AGE: an attempt younger than `SESSION_TRIAGE_MIN_ATTEMPT_AGE_SECONDS` (default 30, bounded 1–600) declines with the new reason `pending-fresh` and **withholds** the `attemptId`. Withholding is the whole mechanism — the token is the capability to finalize, and the hook keeps no threshold, clock or arm time of its own. The separation is wide: a sibling reads the row milliseconds after the arm, a genuine later Stop is a whole model turn away.

  A finalize-only Stop is EXEMPT: `triage/begin` accepts an optional `stopHookActive`, forwarded verbatim from the harness payload, and skips the age guard when it is true. Deferring a finalize is not free — the attempt stays `pending` across the user's next turn, and the Stop that eventually completes it absorbs that turn's events into the cumulative watermark, where nothing can re-arm on them and the closer no longer selects them. The exemption cannot be reached on the delivery that can inject (that one is `stop_hook_active=false` by definition), and two concurrent finalize deliveries are settled by the existing `(status = 'pending', attempt id)` fence: one stamps the outcome, the other gets a 409, and neither may inject. A harness that never sets the field — Codex has none, Gemini CLI 0.30.0 hardcodes it false — keeps the deferral. The hook omits the field when false, so the arming path stays wire-compatible with a 7a server whose begin body is strict.

  `GET /api/v1/export` now serializes `triageArmedAt` for every agent session, matching the generated OpenAPI contract.

  `TriageDebounceThresholds` gains the required `minAttemptAgeMs`, so a composition root that builds the thresholds by hand must supply it; `loadSessionTriageConfig()` already does. `BeginTriageOptions` gains an optional `armNow` clock, read at the arm point so a slow `begin` cannot stamp an attempt as already aged.

  The age is a cross-instance subtraction — the arming process's stamp against the reading process's clock — so the guard assumes NTP-synchronised app instances. A slow reading clock only defers a finalize by one Stop; a reading clock more than the floor fast relative to the arming one reopens the race. Deriving the age where it was stamped is impossible (Stop is a fresh process per delivery), and a database clock would break the injected-clock convention the module's testability rests on, so the assumption is documented rather than engineered around.

  `triage_armed_at` is nullable and a NULL age reads as "finalize", so rows armed before this migration keep the pre-guard behavior. Deferring a finalize costs at most one Stop: a `pending` row can never arm a second injection, age only grows, and `pending` is unconditionally closer-eligible if the session ends first. An older hook needs no update — `pending-fresh` carries no `attemptId`, so the finalize it declines to authorize is unreachable either way.

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

- 54a7993: Add the server half of the Stop-nudge handshake (issue #166 step 7a): `POST /api/v1/agent-sessions/triage/begin` and `/triage/complete`. Both address the row by the natural key `(agent, sessionId)` in the body, with the tenant from the API key — Stop is a separate process that holds the harness conversation id and nothing else. The client half is the step 7b hook (`3ngram-hook stop`), which ships in this same release and calls these routes only behind `THREENGRAM_STOP_NUDGE=1` — the nudge remains default-off.

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
