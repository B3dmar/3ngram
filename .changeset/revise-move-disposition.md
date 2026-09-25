---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
"@3ngram/sdk": minor
---

`revise` gains a move disposition: `{ kind: "move", predecessorId, scope?, project?, tags? }` changes a memory's filing in place. No successor and no edge are written; content, topic, status, `valid_from`, `valid_to` and `recorded_at` are untouched, so a refile neither floods the target project's recent section nor breaks `asOf` reads. The change is audited by a `revise` memory event whose payload records scope, project and tag count before and after (tags themselves stay out of the INSERT-only event table because account erasure cannot reach it). AGENTS.md hard rule 1 gains this single carve-out. Superseded and archived rows can be moved too. A move that changes nothing writes nothing. The successor kind keeps its exact shape; the input schema is now a two-branch union, and the response's `memoryType`/`topic` come from the written or moved row (issue #233). The tool's one-line description still reads "never edits in place" until the tool-selection embeddings are regenerated; the field descriptions and the concept docs carry the move semantics.
