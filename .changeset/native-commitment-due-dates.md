---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
'3ngram': minor
---

Native `remember` can now record a commitment's deadline and owner (issue #165). A `commitment` write over MCP, REST (`POST /api/v1/memories`), the SDK or the CLI (`--due`, `--owner`) accepts an optional explicit `dueAt` (ISO-8601 instant, at most millisecond precision) and `owner`. Both are written onto the auto-created commitment row in the same transaction, so briefing reports the commitment overdue once the deadline passes and the surfacing sweep expires it after the grace window, exactly as for imported commitments. Either field on a non-commitment is rejected rather than dropped, and nothing is inferred from the content: an undated commitment stays undated. A `revise` keeps the deadline, owner and commitment identity with the successor. No migration; the columns already existed.
