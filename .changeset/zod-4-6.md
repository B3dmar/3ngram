---
"@3ngram/server": patch
"@3ngram/schema": patch
"@3ngram/sdk": patch
"@3ngram/config": patch
---

Bump `zod` from 4.4.3 to 4.6.5, the newest release past the 7-day release-age cooldown. Datetimes keep the zod 4.4.3 grammar: zod 4.5 began requiring seconds on any time with `Z` or an offset, so every datetime field now goes through the new `isoDateTime()` helper in `@3ngram/schema`, which supplies the 4.4.3 pattern. Minute precision such as `2026-01-01T06:15Z` still parses, the `invalid_format` issue is unchanged, and the emitted `date-time` pattern is byte-identical. `@3ngram/schema` gains two exports for this, `isoDateTime` and `IsoDateTimeOptions`. Remaining upstream changes: the email pattern is rewritten without lookaheads but accepts the same addresses (checked against 4.4.3 on edge cases such as `a..b@x.com` and `.a@x.com`); string length bounds count Unicode code points instead of UTF-16 code units, matching Postgres; a strict object with an unknown key and a bad value now reports both issues; and emitted JSON Schema (MCP `tools/list`, OpenAPI) writes a nullable primitive as `type: [T, "null"]` instead of a two-branch `anyOf`. Consumers that compose `@3ngram/schema` schemas or types with their own `zod` must move `zod` to 4.6.5 in lockstep: zod's declarations carry the minor version as a literal type, so passing a schema from one copy into another copy's `ZodType`, `z.array()` or `z.union()` fails to typecheck.
