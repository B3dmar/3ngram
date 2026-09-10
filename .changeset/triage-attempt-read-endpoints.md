---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

Read endpoints for agent-session rows and triage attempts (issue #203). `GET /api/v1/agent-sessions/{sessionRunId}` returns the bookkeeping row — identity, lifecycle timestamps, `activation_epoch`, triage status and `briefed_memories`, never the excerpt or the watermark ids — and `GET /api/v1/agent-sessions/{sessionRunId}/triage-attempts` returns the run's interactive nudge history. Both are read-only, tenant-scoped, and share the events endpoint's id boundary and error mapping (unknown/foreign run id → 400 `invalid_input`).

The history is persisted by migration `0037_triage_attempt_log`: `agent_sessions.triage_attempt_log` records one `{attemptId, armedAt, finalizedAt?, outcome?}` entry per armed Stop-nudge attempt (appended by `triage/begin`'s arm, finalized by `triage/complete`), bounded at 50 entries dropping the oldest, with `triage_attempt_count` keeping the true total so a trimmed log is detectable. An entry nothing finalized stays open — an abandoned handshake is a different fact from a zero-write continuation. The closer's claims are deliberately not logged: the log measures the nudge, which is what the #166 validation bar's ignore-rate metric needs.
