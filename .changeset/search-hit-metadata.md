---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
'3ngram': minor
---

Search hits now carry their filing (`scope`, nullable `project`) and, for commitments only, the lifecycle `commitmentStatus` (#319). The fields ride both MCP `search` projections (`full` and `compact`) in relevance and chronological order, the public REST `POST /api/v1/search` response, and the SDK types; the CLI labels each hit with `scope/project` and `commitment:<status>`. Memory status and commitment lifecycle are separate axes, so a resolved commitment stays a valid historical hit, now labelled instead of reading as an active instruction. Ordering, candidate sets, supersession demotion and cursors are unchanged.
