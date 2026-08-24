---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/worker': patch
'@3ngram/server': minor
---

fix(worker): back off a consistently-failing closer row instead of retrying it every sweep tick

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
