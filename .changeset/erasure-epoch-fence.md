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
  erasure commit. At most one request may still dispatch racing that commit, on
  the wire for up to the gateway's timeout (30s default) before it completes.
  Closing that fully would mean holding a lock across the network call, which the
  design explicitly rejects (couples erasure latency to the gateway's, inverts
  the repo's no-lock-across-network-call rule).
- Each `resolve` the closer writes is now fenced **inside the same transaction
  and the same statement as the write**: `transitionCommitment` (exported from
  `@3ngram/db`) accepts a new `stampedSessionEpoch`, carried as an EXISTS
  predicate on the commitment `UPDATE` itself, and raises the new
  `SessionEpochFencedError` when the run's epoch has moved. This one **closes**
  the gap rather than narrowing it — there is no statement boundary left for a
  concurrent erasure or resurrection to land in.

A pass fenced at the gateway boundary releases its budget reservation, unbilled,
and settles cleanly on the next sweep: the erasure also cleared
`briefed_memories`, so the re-enqueued row hits `nothing-briefed` and terminates
before ever reaching the gateway. A `resolve` fenced at the write returns a new
`'epoch-fenced'` outcome from `resolveForClosedRun`, which the closer maps to the
same pass-abandoning `fenced` behavior as every other epoch-fence hit — never
retried, never counted as an ordinary per-candidate skip.

No migration: `activation_epoch` already existed as the closer's fence column.
