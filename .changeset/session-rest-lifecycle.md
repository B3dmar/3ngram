---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': patch
'@3ngram/server': minor
---

Add the hook-facing session-lifecycle REST surface (issue #166 step 5a): `POST /api/v1/agent-sessions/open`, `/close` and `/heartbeat`, plus `GET /api/v1/prompts/debrief`. All four address the row by the natural key `(agent, sessionId)` in the body or query — Stop and SessionEnd are separate processes that hold the harness conversation id and nothing else, so close carries no `activation_epoch` and nothing has to persist a local run-id mapping. The tenant always comes from the API key.

`open` is idempotent by that natural key, which doubles as the request token: `startup` inserts at `activation_epoch` 1 and stamps the briefed rows the hook reports after its local truncate; a duplicate `startup` delivery with the same `project`/`scope`/`selector` changes nothing, and one with different values is a `409`. `resume` reuses the row, advances the epoch, reopens a closed or lease-expired row and refreshes the lease — without restamping the briefing. `close` sets `closed_at` once (a repeat echoes the first timestamp), deliberately freezes `last_seen_at` so `closed_at <= last_seen_at + lease` keeps identifying an explicit SessionEnd, and never clears an excerpt the closer has not consumed. `heartbeat` refreshes the lease monotonically, resurrects a closed or lease-expired row, and optionally snapshots the turn's bounded `last_assistant_message`.

`GET /api/v1/prompts/debrief` renders the same debrief text the MCP `debrief` prompt serves — one renderer, two transports — and inlines the run's `briefed_memories` as an id → topic/status mapping so the model can tell which commitment to resolve. Instructions are server-authored and every caller- or tenant-supplied value renders inside a fenced JSON block whose fence grows past the longest backtick run in the payload; the MCP `debrief` prompt changed to the same delimited-data shape, so `scope` and `project` are no longer interpolated into its imperative sentences.

Also hardens the native write-attach path: the re-read under the attach advisory lock is now `SELECT ... FOR UPDATE`, so a concurrent close cannot commit between the resurrect decision and the resurrect it justified and silently reopen an explicitly closed session. The close route is the first writer of `closed_at`, which is what made that race reachable.
