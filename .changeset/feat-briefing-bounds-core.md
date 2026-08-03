---
"@3ngram/core": minor
"@3ngram/server": minor
---

Briefing bounds V2 (issue #45): core `briefing()` honours the caller-tunable `sectionLimit` (clamped to the server-side ceiling of 100) and a `sections` subset — un-requested sections are skipped entirely (fewer queries) and omitted from the result; every returned section now carries `hasMore` (`count > items.length`). Brief mode fetches only its top slice since exact counts ride the `count(*) OVER()` window. The MCP `briefing` tool registers the composed V2 input/output schemas; a legacy `{selector, mode}` call returns the same sections as before plus `hasMore`.
