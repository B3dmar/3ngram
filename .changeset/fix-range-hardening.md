---
"@3ngram/schema": patch
"@3ngram/server": patch
---

Recorded-range hardening (issue #58): the recordedAfter/recordedBefore pair is now validated by one shared rule set (`recordedRangeIssues` in `packages/schema/src/recorded-range.ts`) applied by BOTH transports — the MCP search schema (searchQueryV2Schema, carried into V3) and the REST `GET /api/v1/memories` query schema. The REST list now rejects an inverted range as a 400 (parity with MCP — previously an empty 200), and both surfaces reject a bound with more than 3 fractional-second digits instead of silently truncating it to JS millisecond precision (Postgres stores `recorded_at` at microsecond precision, so a truncated bound could leak a boundary row past an inclusive bound). `searchFingerprint` now hashes the post-parse query text verbatim — both transport query schemas trim at parse, so the fingerprint hashes exactly the text core embeds (no behavior change for schema-parsed callers).
