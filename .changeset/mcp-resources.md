---
'@3ngram/server': minor
---

mcp: serve memory bodies as a cacheable resource

Adds `threengram://memory/{id}` — `resources/templates/list` plus
`resources/read` — so a client that pulled a `truncated: true` search hit can
cache the full body instead of re-calling `get_memories` every session.
`resources/read` is cacheable on protocol revision 2026-07-28, which is what
makes this worth serving; resources also consume no slot against the 12-tool cap.

The body carries only fields that never change after write (content, topic,
type, scope, project, recordedAt) and deliberately omits lifecycle state
(status, validity, commitment status, tags), which is what allows a 24-hour
`cacheScope: private` TTL without ever serving a stale answer. Reads enforce the
same tenant, read-scope, and access guards as the read tools, and an id
belonging to another tenant is indistinguishable from one that does not exist.

`resources/list` returns nothing by design — enumerating a tenant's corpus is
the firehose the no-firehose rule exists to prevent.
