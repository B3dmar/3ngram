---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
"@3ngram/sdk": minor
---

`get_memories` items carry `supersededBy`: the direct successor (`{ id, edgeType }`, edge type `supersedes` or `updates`) when the row is superseded, `null` otherwise (current, archived, or historical without a revision edge). Superseded means closed validity plus a revision edge, the definition `search` already uses for its `superseded` flag, so an imported `updates` edge on a live row still reads `null`. One hop only; lineage remains on REST `GET /api/v1/memories/:id/history` (issue #223).
