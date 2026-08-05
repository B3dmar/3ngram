---
"@3ngram/server": patch
---

Declare `hono` explicitly at 4.12.34 and raise the `hono`/`postcss` advisory overrides. `hono` reaches this package as an optional peer of `@modelcontextprotocol/node`, which pnpm auto-installs and which pnpm overrides cannot reach — the server genuinely needs it at runtime for the MCP HTTP transport, so it is now a declared dependency rather than an implicit one.
