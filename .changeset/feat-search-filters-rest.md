---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/server": minor
---

Filters V2 parity on the REST memories list (issue #48, layer 2 of 2): `GET /api/v1/memories` accepts `memoryTypes` (repeatable query param — string once, array when repeated, the same handling as `project`; mutually exclusive with the scalar `type`) and `recordedAfter`/`recordedBefore` (inclusive ISO recorded_at range bounds). The db `listConditions` narrows via `eq`/`inArray` and `gte`/`lte` on top of the ever-present live gate — the range narrows the live view, never widens it. OpenAPI spec regenerated from the schema.
