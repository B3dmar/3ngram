# @3ngram/worker

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
