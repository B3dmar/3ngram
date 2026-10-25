# @3ngram/worker

## 1.10.0

### Minor Changes

- 51fc6a7: One-shot mode accepts `session-sweep` (#315): closers drain in-process after the sweep, deduped by (run, epoch), each as a last attempt so a failure stamps the row-level backoff once (#184).
- eee7fe3: Add a one-shot worker entrypoint, `node dist/once.js <consolidation|surfacing|gc-clients>`, for cron-style schedulers (#315). It runs one pass without Redis, closes the database pool, and exits 0 on success, 1 on failure, or 2 for an unknown job. The resident BullMQ worker (`node dist/index.js`) stays the default. `@3ngram/core` re-exports `closeDb`, and `@3ngram/config/otel` adds `flushObservability` to drain Sentry events before a deliberate exit.

### Patch Changes

- 1c874bf: `loadEnv` and `parseEnv` take an optional `{ role: 'server' | 'worker' }`. The worker now validates its env as role `worker`, which skips the server-only production requirements: `OAUTH_JWKS` (the worker signs no tokens) and `REDIS_URL` (only the server's rate limiter needs it; the resident BullMQ worker still fails at boot without it). `BASE_URL`, `LOG_HASH_SALT` and the `DATABASE_URL` checks still apply. With no argument, `loadEnv()` behaves as before (server role), and asking for a different role once the env is resolved throws. The exported `envSchema` is now the role-agnostic base and no longer carries the server-only production rules; validate through `parseEnv`/`loadEnv`. Closes #204, refs #315.
- dc5dd43: Add `Gateway.decide()` for typed judgments and a Jev (TypeSafe AI) provider (issue #225). `createJevGateway` uses raw fetch with one bounded attempt and no retries. It checks every answer against the questions asked, and its errors carry counts only. `createOpenAIGateway().decide()` throws `NotImplementedError`. `composeGateway` routes `decide` to Jev, and the fake gateway records `calls.decide` with a fail-closed low default. New env vars `JEV_API_URL`, `JEV_API_KEY` and `JEV_MODEL` take an explicit model pin and refuse `-latest`. The new metered operation is `session.closer.decide`. Nothing calls `decide()` yet, and judgment stays off unless `JEV_*` is configured.
  
  Breaking for custom `Gateway` implementations: `decide` is now a required method. A wrapper or test double that implements `Gateway` by hand must add one. It can reject with `NotImplementedError('decide')`, as the OpenAI gateway does.
- Updated dependencies [0888ff0]
- Updated dependencies [1c874bf]
- Updated dependencies [dc5dd43]
- Updated dependencies [537811a]
- Updated dependencies [48dcb4a]
- Updated dependencies [6a3adf5]
- Updated dependencies [5ceaec4]
- Updated dependencies [2d36f37]
- Updated dependencies [7dec400]
- Updated dependencies [eee7fe3]
  - @3ngram/core@0.15.0
  - @3ngram/config@0.6.0
  - @3ngram/llm@0.4.0
  - @3ngram/schema@0.13.0

## 1.9.1

### Patch Changes

- Updated dependencies [48b8972]
  - @3ngram/schema@0.12.1
  - @3ngram/config@0.5.3
  - @3ngram/core@0.14.1

## 1.9.0

### Patch Changes

- Updated dependencies [545fb26]
- Updated dependencies [2fc6fbf]
- Updated dependencies [eef068b]
- Updated dependencies [96c5e01]
- Updated dependencies [b3d705d]
- Updated dependencies [3222da4]
- Updated dependencies [0d70e7c]
- Updated dependencies [de8ad09]
- Updated dependencies [a550395]
- Updated dependencies [38b83c9]
- Updated dependencies [959ce85]
- Updated dependencies [9e3bd98]
  - @3ngram/schema@0.12.0
  - @3ngram/core@0.14.0
  - @3ngram/config@0.5.2

## 1.8.7

### Patch Changes

- @3ngram/core@0.13.4

## 1.8.6

### Patch Changes

- 375496c: Bump the worker's queue stack: `bullmq` from 5.78.0 to 5.81.5, the newest 5.x release, and `ioredis` from 5.10.1 to 5.11.1, the version bullmq 5.81.5 pins and `@3ngram/server` already runs, so the lockfile now carries one ioredis copy. Both are past the 7-day release-age cooldown. The retry, terminal-removal and custom job id checks the worker's comments cite are unchanged in 5.81.5; the range adds blocking-connection recovery after a Redis or Sentinel disconnect, `upsertJobScheduler` fixes for `every` offsets and same-id re-upserts (the worker's schedulers use `pattern`), and fails, rather than requeues, a stalled job whose scheduler was removed. Since 5.81.2 BullMQ drops connection errors that no `error` listener receives, so the worker's Queue and Worker now register one each and log only the error name and queue name at `warn`: never the error object or its message, which can quote stored job data.
- Updated dependencies [dfe6d68]
- Updated dependencies [48c0ad5]
- Updated dependencies [34f1985]
  - @3ngram/config@0.5.1
  - @3ngram/core@0.13.3
  - @3ngram/schema@0.11.2

## 1.8.5

### Patch Changes

- @3ngram/core@0.13.2

## 1.8.4

### Patch Changes

- 49abc82: Clear the release image scan that blocked v1.8.3. New advisories landed after v1.8.2: perl-base CVE-2026-13221 (critical), libpcre2-8-0 CVE-2026-103111 (high), proxy-addr CVE-2026-90711 (critical) and two nodemailer advisories (CVE-2026-90776, GHSA-v53p-9fqp-m79j). Both images move to the current `node:24-bookworm-slim` digest (libpcre2 10.42-1+deb12u2) and upgrade perl-base to 5.36.0-7+deb12u4 from Debian security until the base image catches up; proxy-addr is overridden to 2.0.8; nodemailer moves to 10.0.12, which keeps the transport API, requires Node 20+, and ships its own types, so `@types/nodemailer` is dropped.

## 1.8.3

### Patch Changes

- Updated dependencies [063e312]
  - @3ngram/schema@0.11.1
  - @3ngram/core@0.13.1

## 1.8.2

### Patch Changes

- Re-cut of v1.8.1, whose tag was pushed against the wrong commit before its promotion had merged; the immutable tag ruleset makes that number unusable. No code change.

## 1.8.1

### Patch Changes

- eefaa05: Release images move to the current `node:24-bookworm-slim` digest, which carries libpcre2 10.42-1+deb12u1. The v1.8.0 release scan rejected the previous pinned digest on CVE-2026-86145 (libpcre2-8-0, high), so that tag is burned and v1.8.1 carries its content.

## 1.8.0

### Patch Changes

- Updated dependencies [f04e568]
- Updated dependencies [fd10617]
- Updated dependencies [35bff20]
  - @3ngram/schema@0.11.0
  - @3ngram/core@0.13.0

## 1.7.0

### Patch Changes

- 61bc6bc: The surfacing sweep no longer expires a commitment the moment its due date passes. A new `COMMITMENT_EXPIRY_GRACE_DAYS` setting (default 14, 0 restores the old behaviour) keeps an overdue commitment open (or waiting), and therefore visible in the briefing's overdue section, for that many days before the worker expires it (issue #221). Library callers of `surface()` and `sweepCommitments()` that omit the new optional argument keep the previous immediate-expiry semantics; `loadSurfacingConfig()`, `SurfacingPolicy`, `expiryCutoff()` and `LEGACY_SURFACING_POLICY` are new exports.
- 035de9a: Consolidation no longer re-proposes a settled pair. `findSimilarPairs` now excludes any candidate pair that already carries a proposal (proposed, applied or rejected) or a materialized edge, in either orientation. A rejection is final for that pair and an applied `extends`/`derives` edge is not proposed again on the next hourly run (issue #220).
- Updated dependencies [61bc6bc]
- Updated dependencies [062c2ba]
  - @3ngram/config@0.5.0
  - @3ngram/core@0.12.0
  - @3ngram/schema@0.10.0

## 1.6.3

## 1.6.2

### Patch Changes

- Updated dependencies [a96fb41]
  - @3ngram/core@0.11.2
  - @3ngram/schema@0.9.1

## 1.6.1

### Patch Changes

- Updated dependencies [7e254c8]
  - @3ngram/core@0.11.1

## 1.6.0

### Patch Changes

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

- Updated dependencies [6421161]
- Updated dependencies [05aa7ae]
- Updated dependencies [69059d7]
- Updated dependencies [67b0c02]
  - @3ngram/schema@0.9.0
  - @3ngram/core@0.11.0
  - @3ngram/config@0.4.0

## 1.5.0

### Patch Changes

- Updated dependencies [1160f1a]
- Updated dependencies [5af5010]
- Updated dependencies [809ae0e]
- Updated dependencies [62317d9]
- Updated dependencies [1f4c763]
- Updated dependencies [54a7993]
  - @3ngram/core@0.10.0
  - @3ngram/schema@0.8.0
  - @3ngram/llm@0.3.0
  - @3ngram/config@0.3.0

## 1.4.4

### Patch Changes

- @3ngram/core@0.9.3

## 1.4.3

## 1.4.2

### Patch Changes

- Updated dependencies [1ebd82c]
  - @3ngram/core@0.9.2

## 1.4.1

### Patch Changes

- Updated dependencies [483c658]
  - @3ngram/core@0.9.1

## 1.4.0

### Patch Changes

- Updated dependencies [4ed7e25]
- Updated dependencies [4cd03d4]
- Updated dependencies [1d9a420]
- Updated dependencies [318025a]
  - @3ngram/core@0.9.0

## 1.3.0

### Patch Changes

- Updated dependencies [139473c]
  - @3ngram/config@0.2.6
  - @3ngram/core@0.8.6

## 1.2.7

### Patch Changes

- Updated dependencies [1263111]
  - @3ngram/core@0.8.5

## 1.2.6

### Patch Changes

- Updated dependencies
  - @3ngram/core@0.8.4
  - @3ngram/config@0.2.5

## 1.2.5

### Patch Changes

- Updated dependencies [6e06cd6]
  - @3ngram/core@0.8.3
  - @3ngram/config@0.2.4

## 1.2.4

### Patch Changes

- @3ngram/core@0.8.2

## 1.2.3

### Patch Changes

- Updated dependencies [4d0d05d]
  - @3ngram/core@0.8.1

## 1.2.2

### Patch Changes

- Updated dependencies [7af346c]
  - @3ngram/core@0.8.0

## 1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [ba229fa]
- Updated dependencies [cfb7d50]
- Updated dependencies [b704728]
- Updated dependencies [11d1916]
- Updated dependencies [eb2ea4e]
- Updated dependencies [a364654]
- Updated dependencies [1471fcb]
- Updated dependencies [cf088c1]
  - @3ngram/core@0.7.0

## 1.1.3

### Patch Changes

- @3ngram/core@0.6.3

## 1.1.2

### Patch Changes

- Updated dependencies [310e515]
  - @3ngram/config@0.2.3
  - @3ngram/core@0.6.2

## 1.1.1

### Patch Changes

- Updated dependencies [cea2989]
  - @3ngram/core@0.6.1

## 1.1.0

### Patch Changes

- Updated dependencies [d5080cd]
- Updated dependencies [b88a6fa]
- Updated dependencies [69a66b3]
- Updated dependencies [63ebb77]
- Updated dependencies [2eb1ca8]
- Updated dependencies [7c0c627]
- Updated dependencies [e5c1a2e]
- Updated dependencies [dcc98b7]
  - @3ngram/core@0.6.0
  - @3ngram/config@0.2.2

## 1.0.2

### Patch Changes

- Updated dependencies [e18e4a2]
  - @3ngram/core@0.5.1

## 1.0.1

## 1.0.0

### Major Changes

- b956a15: Release the stable 3ngram v1 product line: MCP and REST server, worker,
  TypeScript SDK, and bare `3ngram` CLI.

### Patch Changes

- Updated dependencies [b956a15]
- Updated dependencies [3d1f0ec]
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
  - @3ngram/config@0.2.1
  - @3ngram/core@0.5.0

## 0.8.0

## 0.7.3

## 0.7.2

## 0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [fb2487a]
  - @3ngram/core@0.4.0
  - @3ngram/config@0.2.0

## 0.6.0

Initial public release.
