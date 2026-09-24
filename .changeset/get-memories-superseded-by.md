---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
"@3ngram/sdk": minor
---

`get_memories` items carry `supersededBy`: the direct successor (`{ id, edgeType }`, edge type `supersedes` or `updates`) when the row is superseded, `null` otherwise (current, archived, or historical without a revision edge). Superseded means not archived, closed validity and a revision edge, the precedence REST history's `lifecycleState` applies; for active rows it matches `search`'s `superseded` flag, and an imported `updates` edge on a live row still reads `null`. One hop only; lineage remains on REST `GET /api/v1/memories/:id/history` (issue #223).
