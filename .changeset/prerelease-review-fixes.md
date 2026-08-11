---
"@3ngram/db": patch
"@3ngram/core": patch
"@3ngram/schema": patch
"@3ngram/server": patch
---

Five correctness fixes to the facts, portability, and retrieval surfaces.

**`fact_proposals` is now erased on account deletion.** Account deletion tombstones the `users` row rather than deleting it, so the FK's `ON DELETE CASCADE` never fires — a staged fact proposal kept its `subject`, `predicate`, `value`, and `rationale` through an Article 17 erasure. It is now redacted in place in the same transaction as `facts` and `consolidation_proposals` (redact-in-place, not DELETE: the runtime role has no DELETE grant on memory-domain tables). The erasure receipt gains a `factProposals` count on `DELETE /api/v1/account` and in the audit tombstone.

**`fact_proposals` is now included in the portability export.** `GET /api/v1/export` carried `facts` and `consolidation_proposals` but not the staged proposals, which are user content that is not yet a `facts` row. The archive gains a `factProposals` section (and a matching `counts.factProposals`), read under the same repeatable-read snapshot as every other section.

**Chronological search now rejects a `query` instead of silently ignoring it.** `order: 'chronological'` is an unranked enumeration and the core path takes no query argument, so a caller passing `{order: 'chronological', query}` was returned the whole live corpus as though it had been searched. A present `query` is now a validation error naming `order: 'relevance'` as the ranked alternative. Because `query` no longer bounds the scan, chronological order now REQUIRES at least one filter (previously "query or >=1 filter").

**Fact write timestamps no longer truncate to milliseconds.** `validFrom`/`validTo` on a written fact accepted arbitrary fractional-second precision, but core converts them with `new Date()` (millisecond) on the way to microsecond-precision Postgres columns — a finer instant silently moved the boundary of a bi-temporal window. Both bounds are now capped at 3 fractional-second digits and REJECTED beyond it, matching the facts-range read bounds, with the limit advertised in the field descriptions.

**Imported `updates` edges no longer mark live memories superseded.** The `superseded` flag and its ranking tier-penalty counted any incoming `supersedes`/`updates` edge, but the import contract forbids `closePredecessorAt` on an `updates` edge — so every imported `updates`-edge target stayed live (`valid_to IS NULL`) yet read `superseded: true` and was demoted in ranking. The predicate now requires BOTH a revision edge AND closed validity, the same definition `memory_history`'s `lifecycleState` applies, so search and history can no longer disagree about the same row. Genuine revisions are unaffected: the revise path closes `valid_to` for both edge kinds.
