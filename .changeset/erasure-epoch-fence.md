---
'@3ngram/db': patch
'@3ngram/core': patch
---

fix(core): fence the session closer's gateway call against account erasure

Account erasure redacted `agent_sessions` (excerpt, briefed topics, project/scope)
but never touched `activation_epoch`, so an in-flight closer pass that had already
claimed a run could still send the pre-erasure excerpt and briefed topics to the
external LLM gateway — the epoch fence the closer relies on for every other
resurrection case had nothing to trip.

`eraseAccountData` now increments `activation_epoch` on every one of the account's
`agent_sessions` rows in the same `UPDATE` as the redaction, and the closer
re-checks the epoch after reserving its budget slot, immediately before
dispatching to the gateway — the last point before the excerpt/topics leave the
process, closing the window the per-resolve check (which only runs after the
round trip returns) could not. The check sits after the reservation, not before,
so the reservation's own per-user advisory-lock wait (which can block behind
another in-flight metered call) never inflates the residual below. A pass fenced
this way still releases its reservation, unbilled, and settles cleanly on the
next sweep: the erasure also cleared `briefed_memories`, so the re-enqueued row
hits `nothing-briefed` and terminates without ever reaching the gateway.

Residual, disclosed rather than hidden: a request already dispatched before the
erasure `UPDATE` commits is still on the wire for up to the gateway's timeout (30s
default) — erasure can report complete while that one call finishes. No migration:
`activation_epoch` already existed as the closer's fence column.
