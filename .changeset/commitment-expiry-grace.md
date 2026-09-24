---
"@3ngram/config": minor
"@3ngram/core": minor
"@3ngram/db": patch
"@3ngram/worker": patch
---

The surfacing sweep no longer expires a commitment the moment its due date passes. A new `COMMITMENT_EXPIRY_GRACE_DAYS` setting (default 14, 0 restores the old behaviour) keeps an overdue commitment open (or waiting), and therefore visible in the briefing's overdue section, for that many days before the worker expires it (issue #221). Library callers of `surface()` and `sweepCommitments()` that omit the new optional argument keep the previous immediate-expiry semantics; `loadSurfacingConfig()`, `SurfacingPolicy`, `expiryCutoff()` and `LEGACY_SURFACING_POLICY` are new exports.
