---
"@3ngram/server": patch
"@3ngram/worker": patch
---

Raise the `@hono/node-server` override to `^1.19.18` so the server and worker images resolve the fix for GHSA-jpvv-r467-5p4w, where a raw backslash in the request path was parsed as `/` and a path-based rule at a reverse proxy could see a different path than the app (#407). Consumers that install `@3ngram/server` from npm need the same override in their own workspace, because pnpm overrides do not travel with published packages.
