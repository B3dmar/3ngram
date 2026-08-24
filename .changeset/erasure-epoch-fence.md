---
'@3ngram/db': minor
'@3ngram/core': minor
---

fix(core): fence the session closer against account erasure

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
