---
"@3ngram/server": minor
---

Register the `get_memories` MCP tool (11th tool; the last slot stays reserved for `manage_context`): a batched full-content read for ids a `search`/`handoff` result surfaced with `truncated: true` — up to 20 ids, per-item content bounded at `maxContentChars` (default 10,000, ceiling 65,536), unknown/cross-tenant ids returned as `notFound` data instead of an error. The `search` and `handoff` tool descriptions now point truncated results at `get_memories`; docs drop the never-built `memory_ids` search claim and record the 11-tool surface.
