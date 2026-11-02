---
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

Add `userMemoryCount` to the read-only onboarding status. Count live memories while excluding the genuine system-created welcome seed using its content hash and creation provenance. User-authored welcome lookalikes count; archived and superseded versions do not. This lets onboarding ignore delayed seed creation without writing during page rendering.

Return a typed creation outcome from explicit welcome seeding so the dashboard can distinguish a new seed from an existing, possibly archived copy. Archived copies remain archived.
