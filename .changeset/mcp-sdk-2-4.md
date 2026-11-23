---
"@3ngram/server": patch
---

Upgrade the MCP TypeScript SDK: `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1 -> 2.4.0, and `@modelcontextprotocol/node` 2.1.1 -> 2.1.2 (the adapter 2.1.2 requires server ^2.4.0). The advertised MCP surface is unchanged: no tool uses `x-mcp-header` on a `number` parameter or a `.meta({ id })` output schema, which are the 2.4.0 upgrade notes. The adapter now also accepts `@hono/node-server` 2.x; the lockfile stays on 1.19.19.
