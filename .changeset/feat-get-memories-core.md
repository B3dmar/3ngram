---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
---

Add the batched bounded-content read that backs the upcoming `get_memories` MCP tool: `getMemoriesInputSchema`/`getMemoriesOutputSchema` (ids 1–20, `maxContentChars` 200–65,536, default 10,000) at the one validation boundary, a single-query `getMemoriesByIds` db read (`id = ANY` under one `withTenant`, RLS-safe), and core `getMemoriesByIds(userId, ids, { maxContentChars })` returning `{ memories, notFound }` — a missing or cross-tenant id is data (`notFound`), never an error. `excerptContent` now accepts an optional max-chars argument; existing call sites keep the shipped 600-char excerpt behavior.
