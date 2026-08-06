---
'@3ngram/server': patch
'@3ngram/config': patch
---

mcp: close two 2026-07-28 specification MUSTs

`server/discover` now advertises the same one-hour `cacheScope: 'public'` hint the
tool and prompt catalogs carry. It previously fell through to the SDK's defaults
(`ttlMs: 0`, `cacheScope: 'private'`), so clients treated discovery as immediately
stale and re-probed on every reconnect.

`/mcp` now validates the `Origin` header. A request with no `Origin` is allowed —
non-browser clients do not send one — and a present `Origin` must appear in the
allowlist (`WEB_APP_URL` plus the new optional `MCP_ALLOWED_ORIGINS`) or the request
is refused with `403` before authentication runs. With neither variable configured
the allowlist is empty, so any browser origin is rejected; non-browser clients are
unaffected.
