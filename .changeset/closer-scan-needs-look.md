---
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

perf(db): bound the session-closer candidate scan by backlog, not history

`completed` is the terminal state of the closer's happy path and was never left, so
every session a tenant had ever run stayed in `agent_sessions_closer_idx`, sorted
first by `closed_at`, and each sweep tick paid an untriaged-event `EXISTS` probe on
all of them to find nothing. The work grew with age rather than load.

Migration `0034` adds `agent_sessions.needs_look` and narrows the index predicate to
`closed_at IS NOT NULL AND triage_status <> 'overflowed' AND (triage_status <>
'completed' OR needs_look)`, so settled history leaves the index entirely. The flag
is raised by a provenance write that attaches to an already-`completed` run, and
recomputed by every watermark stamp against the set it just wrote — a stamp that
leaves an event untriaged re-raises it, which is what keeps the late-commit race
(a `memory_events` id assigned at INSERT but visible at COMMIT) covered. The
`EXISTS` backstop is unchanged; it is now paid only on flagged rows. Existing
`completed` rows are backfilled by the same probe during the migration.

The GDPR export carries the new column, and account erasure resets it alongside the
watermark it derives from.
