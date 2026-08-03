---
"@3ngram/schema": minor
---

Add the briefing/handoff bounds V2 contracts (`packages/schema/src/briefing-bounds.ts`): composed successor input schemas with a caller-tunable `sectionLimit` (bounded by the new server-side ceilings `MAX_BRIEFING_SECTION_CEILING`/`MAX_HANDOFF_SECTION_CEILING`, both 100) and an optional briefing `sections` subset selector, plus successor output schemas where briefing sections gain a `hasMore` flag and the handoff envelope gains exact per-section `counts` + `truncated` flags. Shipped V1 schemas stay byte-identical; a legacy input parses identically through V1 and V2.
