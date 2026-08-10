---
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/schema": minor
"@3ngram/server": minor
"@3ngram/eval": minor
---

Add an exhaustive chronological list mode to `search`.

Retrieving everything of a given shape (every decision from a project, every commitment recorded last week) previously meant issuing a ranked search and hoping the relevance ordering happened to surface it all within the result window — there was no way to ask for a complete, chronological listing.

`search` now accepts `order: "chronological"` alongside the default `"relevance"`. Chronological mode returns a most-recent-first, unranked enumeration of live memories narrowed by the same candidate filters ranked search already supports (memoryType, scope, project, status, asOf, recordedAfter/recordedBefore). It never calls the embedding gateway — no query is required as long as at least one filter narrows the set — and pages through a small, drift-free keyset cursor instead of the ranked path's larger frozen-ordering token.

Superseded predecessors are excluded from chronological listings by default (an exhaustive list has no ranking to demote a superseded row with, so it drops instead — the same live-only default the dashboard memory list already uses), unless an `asOf` coordinate explicitly asks for a historical view.
