---
"@3ngram/schema": patch
"@3ngram/db": patch
"@3ngram/core": patch
"@3ngram/server": patch
"@3ngram/sdk": patch
---

`revise` inherits `scope`, `project` and `tags` from the predecessor when they are omitted, instead of defaulting to `personal`, no project and no tags. A revise that left out `scope` used to move a `work` memory out of its scope and drop it from its project briefing while closing the original. Explicit values still override. The MCP and REST responses now echo the filing the successor was written with (issue #222).
