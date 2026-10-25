---
"@3ngram/core": minor
---

The session closer uses typed judgments for tenants that opted in (issue #229). An opted-in tenant's pass calls `gateway.decide()` with one Noul per briefed commitment. The excerpt is fenced as untrusted data, and the criteria say that an assertion of completion is not evidence. A commitment is resolved through `resolveForClosedRun` only when its probability reaches `CLOSER_RESOLVE_PROBABILITY` (0.9). The call is metered as `session.closer.decide`. Opted-out tenants, and deployments without a judgment gateway, keep the `complete()` path unchanged. `SessionCloserRepo` gains `isJudgmentEnabled`. `SESSION_CLOSER_ENABLED` still defaults to off.
