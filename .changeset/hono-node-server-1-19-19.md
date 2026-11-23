---
"@3ngram/server": patch
"@3ngram/worker": patch
---

Raise the `@hono/node-server` override to `^1.19.19` so the server and worker images resolve the fix for GHSA-rmxm-3fg6-px4f, where `serveStatic` decoded the request path a second time (#407). 3ngram never calls `serveStatic`; the bump closes the advisory on the 1.x line without the MCP SDK 2.4 upgrade. Consumers that install `@3ngram/server` from npm need the same override in their own workspace, because pnpm overrides do not travel with published packages.
