---
'@3ngram/schema': minor
'@3ngram/config': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

Age-guard the Stop nudge's `pending` decline so concurrent Stop deliveries cannot double-nudge one turn's work (issue #188).

`triage/begin` hands the in-flight `attemptId` back on a `pending` decline so a later ordinary Stop finalizes the attempt instead of injecting again. That is safe when one process handles one Stop, and unsafe when two handle the *same* Stop — which is what a duplicate registration of the hook's `stop` and `heartbeat` aliases produces, since a harness runs every matching hook for an event concurrently. The sibling would complete the arming process's attempt while it is still fetching the debrief, so that continuation's writes commit outside the stamped watermark, a later Stop re-arms, and the documented bound of *one nudge per turn that produced new provenance* breaks.

`agent_sessions` now carries `triage_armed_at` (migration `0036`), stamped by the arm alongside the attempt token, and `begin` decides by AGE: an attempt younger than `SESSION_TRIAGE_MIN_ATTEMPT_AGE_SECONDS` (default 30, bounded 1–600) declines with the new reason `pending-fresh` and **withholds** the `attemptId`. Withholding is the whole mechanism — the token is the capability to finalize, and the hook keeps no threshold, clock or arm time of its own. The separation is wide: a sibling reads the row milliseconds after the arm, a genuine later Stop is a whole model turn away.

`TriageDebounceThresholds` gains the required `minAttemptAgeMs`, so a composition root that builds the thresholds by hand must supply it; `loadSessionTriageConfig()` already does.

The age is a cross-instance subtraction — the arming process's stamp against the reading process's clock — so the guard assumes NTP-synchronised app instances. A slow reading clock only defers a finalize by one Stop; a reading clock more than the floor fast relative to the arming one reopens the race. Deriving the age where it was stamped is impossible (Stop is a fresh process per delivery), and a database clock would break the injected-clock convention the module's testability rests on, so the assumption is documented rather than engineered around.

`triage_armed_at` is nullable and a NULL age reads as "finalize", so rows armed before this migration keep the pre-guard behavior. Deferring a finalize costs at most one Stop: a `pending` row can never arm a second injection, age only grows, and `pending` is unconditionally closer-eligible if the session ends first. An older hook needs no update — `pending-fresh` carries no `attemptId`, so the finalize it declines to authorize is unreachable either way.
