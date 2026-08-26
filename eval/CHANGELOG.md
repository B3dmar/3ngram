# @3ngram/eval

## 0.1.6

### Patch Changes

- Updated dependencies [7e254c8]
  - @3ngram/db@0.10.1
  - @3ngram/core@0.11.1

## 0.1.5

### Patch Changes

- Updated dependencies [6421161]
- Updated dependencies [05aa7ae]
- Updated dependencies [69059d7]
- Updated dependencies [67b0c02]
  - @3ngram/schema@0.9.0
  - @3ngram/db@0.10.0
  - @3ngram/core@0.11.0

## 0.1.4

### Patch Changes

- Updated dependencies [1160f1a]
- Updated dependencies [5af5010]
- Updated dependencies [809ae0e]
- Updated dependencies [62317d9]
- Updated dependencies [1f4c763]
- Updated dependencies [54a7993]
  - @3ngram/core@0.10.0
  - @3ngram/schema@0.8.0
  - @3ngram/db@0.9.0
  - @3ngram/llm@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [33d1a7f]
  - @3ngram/schema@0.7.3
  - @3ngram/core@0.9.3
  - @3ngram/db@0.8.3

## 0.1.2

### Patch Changes

- Updated dependencies [851fa53]
- Updated dependencies [1ebd82c]
  - @3ngram/schema@0.7.2
  - @3ngram/core@0.9.2
  - @3ngram/db@0.8.2

## 0.1.1

### Patch Changes

- 483c658: Five correctness fixes to the facts, portability, and retrieval surfaces.

  **`fact_proposals` is now erased on account deletion.** Account deletion tombstones the `users` row rather than deleting it, so the FK's `ON DELETE CASCADE` never fires — a staged fact proposal kept its `subject`, `predicate`, `value`, and `rationale` through an Article 17 erasure. It is now redacted in place in the same transaction as `facts` and `consolidation_proposals` (redact-in-place, not DELETE: the runtime role has no DELETE grant on memory-domain tables). The erasure receipt gains a `factProposals` count on `DELETE /api/v1/account` and in the audit tombstone.

  **`fact_proposals` is now included in the portability export.** `GET /api/v1/export` carried `facts` and `consolidation_proposals` but not the staged proposals, which are user content that is not yet a `facts` row. The archive gains a `factProposals` section (and a matching `counts.factProposals`), read under the same repeatable-read snapshot as every other section.

  **Chronological search now rejects a `query` instead of silently ignoring it.** `order: 'chronological'` is an unranked enumeration and the core path takes no query argument, so a caller passing `{order: 'chronological', query}` was returned the whole live corpus as though it had been searched. A present `query` is now a validation error naming `order: 'relevance'` as the ranked alternative. Because `query` no longer bounds the scan, chronological order now REQUIRES at least one filter (previously "query or >=1 filter").

  **Fact write timestamps no longer truncate to milliseconds.** `validFrom`/`validTo` on a written fact accepted arbitrary fractional-second precision, but core converts them with `new Date()` (millisecond) on the way to microsecond-precision Postgres columns — a finer instant silently moved the boundary of a bi-temporal window. Both bounds are now capped at 3 fractional-second digits and REJECTED beyond it, matching the facts-range read bounds, with the limit advertised in the field descriptions.

  **Imported `updates` edges no longer mark live memories superseded.** The `superseded` flag and its ranking tier-penalty counted any incoming `supersedes`/`updates` edge, but the import contract forbids `closePredecessorAt` on an `updates` edge — so every imported `updates`-edge target stayed live (`valid_to IS NULL`) yet read `superseded: true` and was demoted in ranking. The predicate now requires BOTH a revision edge AND closed validity, the same definition `memory_history`'s `lifecycleState` applies, so search and history can no longer disagree about the same row. Genuine revisions are unaffected: the revise path closes `valid_to` for both edge kinds.

- Updated dependencies [483c658]
  - @3ngram/db@0.8.1
  - @3ngram/core@0.9.1
  - @3ngram/schema@0.7.1

## 0.1.0

### Minor Changes

- 1d9a420: Add an exhaustive chronological list mode to `search`.

  Retrieving everything of a given shape (every decision from a project, every commitment recorded last week) previously meant issuing a ranked search and hoping the relevance ordering happened to surface it all within the result window — there was no way to ask for a complete, chronological listing.

  `search` now accepts `order: "chronological"` alongside the default `"relevance"`. Chronological mode returns a most-recent-first, unranked enumeration of live memories narrowed by the same candidate filters ranked search already supports (memoryType, scope, project, status, asOf, recordedAfter/recordedBefore). It never calls the embedding gateway — no query is required as long as at least one filter narrows the set — and pages through a small, drift-free keyset cursor instead of the ranked path's larger frozen-ordering token.

  Superseded predecessors are excluded from chronological listings by default (an exhaustive list has no ranking to demote a superseded row with, so it drops instead — the same live-only default the dashboard memory list already uses), unless an `asOf` coordinate explicitly asks for a historical view.

- 318025a: Fix `search` to demote every superseded predecessor, and label demoted hits.

  The supersession tier-penalty in `search` only fired for a `supersedes` edge — a revision recorded with the `updates` edge kind closed its predecessor's validity exactly the same way, but escaped the ranking demotion entirely, so a superseded row could still outrank its live successor. The penalty now applies whenever a row has an incoming `supersedes` or `updates` edge, matching the existing `CLOSES_PREDECESSOR` convention used elsewhere for the same two edge kinds.

  Search hits (both MCP and REST, full and compact projections) now also carry a `superseded: boolean` flag, so a caller can tell a demoted result from a current one instead of inferring it from score alone. Ranking stays supersession-_aware_, never supersession-_filtered_: a demoted row is still returned, just ranked below its successor and now labeled as such.

### Patch Changes

- Updated dependencies [eb68c04]
- Updated dependencies [d18e749]
- Updated dependencies [c6a819c]
- Updated dependencies [91f1d39]
- Updated dependencies [88ee7d4]
- Updated dependencies [4ed7e25]
- Updated dependencies [4cd03d4]
- Updated dependencies [1d9a420]
- Updated dependencies [318025a]
  - @3ngram/db@0.8.0
  - @3ngram/schema@0.7.0
  - @3ngram/core@0.9.0

## 0.0.20

### Patch Changes

- Updated dependencies [43a200c]
  - @3ngram/schema@0.6.4
  - @3ngram/core@0.8.6
  - @3ngram/db@0.7.5

## 0.0.19

### Patch Changes

- Updated dependencies [1263111]
  - @3ngram/core@0.8.5
  - @3ngram/db@0.7.4

## 0.0.18

### Patch Changes

- Updated dependencies
  - @3ngram/core@0.8.4
  - @3ngram/db@0.7.3
  - @3ngram/schema@0.6.3
  - @3ngram/llm@0.2.4

## 0.0.17

### Patch Changes

- Updated dependencies [6e06cd6]
  - @3ngram/core@0.8.3
  - @3ngram/db@0.7.2
  - @3ngram/schema@0.6.2
  - @3ngram/llm@0.2.3

## 0.0.16

### Patch Changes

- Updated dependencies [75ff6f4]
  - @3ngram/schema@0.6.1
  - @3ngram/core@0.8.2
  - @3ngram/db@0.7.1

## 0.0.15

### Patch Changes

- Updated dependencies [4d0d05d]
  - @3ngram/core@0.8.1

## 0.0.14

### Patch Changes

- Updated dependencies [7af346c]
  - @3ngram/core@0.8.0

## 0.0.13

### Patch Changes

- Updated dependencies [ba229fa]
- Updated dependencies [cfb7d50]
- Updated dependencies [58e3f9d]
- Updated dependencies [b704728]
- Updated dependencies [11d1916]
- Updated dependencies [eb2ea4e]
- Updated dependencies [0790813]
- Updated dependencies [a364654]
- Updated dependencies [2ecf3ab]
- Updated dependencies [351aee0]
- Updated dependencies [8598b09]
- Updated dependencies [1471fcb]
- Updated dependencies [1663683]
- Updated dependencies [cf088c1]
  - @3ngram/core@0.7.0
  - @3ngram/schema@0.6.0
  - @3ngram/db@0.7.0

## 0.0.12

### Patch Changes

- Updated dependencies [78c062c]
  - @3ngram/db@0.6.2
  - @3ngram/core@0.6.3

## 0.0.11

### Patch Changes

- Updated dependencies [310e515]
  - @3ngram/core@0.6.2

## 0.0.10

### Patch Changes

- Updated dependencies [cea2989]
  - @3ngram/db@0.6.1
  - @3ngram/core@0.6.1

## 0.0.9

### Patch Changes

- Updated dependencies [d5080cd]
- Updated dependencies [b88a6fa]
- Updated dependencies [69a66b3]
- Updated dependencies [63ebb77]
- Updated dependencies [2eb1ca8]
- Updated dependencies [7c0c627]
- Updated dependencies [2c1fede]
- Updated dependencies [e5c1a2e]
- Updated dependencies [535db7c]
  - @3ngram/core@0.6.0
  - @3ngram/schema@0.5.0
  - @3ngram/db@0.6.0

## 0.0.8

### Patch Changes

- Updated dependencies [e18e4a2]
  - @3ngram/core@0.5.1
  - @3ngram/llm@0.2.2

## 0.0.7

### Patch Changes

- Updated dependencies [3d1f0ec]
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
  - @3ngram/db@0.5.0
  - @3ngram/core@0.5.0
  - @3ngram/llm@0.2.1
  - @3ngram/schema@0.4.1

## 0.0.6

### Patch Changes

- Updated dependencies [fb2487a]
  - @3ngram/core@0.4.0
  - @3ngram/db@0.4.0
  - @3ngram/schema@0.4.0
  - @3ngram/llm@0.2.0

## 0.0.5

Initial public release.
