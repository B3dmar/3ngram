---
"@3ngram/schema": minor
"@3ngram/server": minor
---

Wire the `scope_project` selector onto the orientation transports (issue #46, layer 2 of 2): `briefing` and `handoff` register the V3 tool IO (`briefingToolInputV3Schema`/`handoffToolInputV3Schema` + matching outputs). Each V3 schema is rebuilt from its shipped base with `.extend(...)`, widening only the selector while reapplying the shared V2 fields and refinements (duplicate-section rejection and hasMore/counts identities), so every V2-valid payload parses identically. The REST `GET /api/v1/briefing` route accepts `kind=scope_project&scope=…&project=…&includeUnscoped=true|false` (only the literal strings coerce; anything else is a schema 400). Tool descriptions document the NULL-project semantics: a memory written without a project never appears through the bare `project` lens — `scope_project` with `includeUnscoped: true` is the explicit opt-in, and the bare variant is never widened. `docs/reference/tools.mdx`, the OpenAPI spec, and the transport-cost fixture + frozen totals are regenerated in lockstep.
