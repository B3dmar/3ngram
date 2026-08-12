---
"@3ngram/schema": patch
"@3ngram/server": patch
---

Tool output schemas now advertise open (`additionalProperties: true`) while the server keeps parsing them strict.

**A cached catalog no longer breaks on an additive response field.** Every tool output object was `.strict()`, which Zod 4 emits as `additionalProperties: false` in the JSON Schema `tools/list` advertises. Clients cache that catalog for an hour, so ANY release that added a response field hard-failed every validating client for the whole TTL window — and nothing prompted an early re-fetch, because the failure is client-side *output* validation rather than a `-32601`/`-32602` the client reads as staleness. That is the observed v1.4.1 incident: a session holding the v1.3.0 catalog called `get_facts` and died on `data/facts/0 must NOT have additional properties`, on a nested item object, from a purely additive field. Every object node reachable in all eleven tool output trees now carries `.meta({ additionalProperties: true })` — root envelopes, array item objects, union members, and section wrappers alike, since the incident failed at depth.

**The runtime contract is unchanged.** `.meta()` moves metadata only: the objects stay `.strict()`, so the server still rejects an unknown key in a result it produced itself, and the search envelope's projection-homogeneity refinement still relies on its hit members being strict. `.loose()`/`.passthrough()` would have moved the runtime contract and were deliberately not used. The strictness suites in `packages/schema` pass unchanged.

**Inputs stay closed, and the asymmetry is now locked by a test.** An unknown argument key remains a loud rejection — a silently dropped `scope` filter reads as a scope leak — so no input schema's advertisement moved a byte. The briefing/handoff `selector` union is the one object reachable from BOTH an input and an output tree (it is an argument AND an echo); the openness rides an output-side derivation, leaving the input union untouched. A registry invariant test walks every tool's emitted output schema asserting no `additionalProperties: false` at any depth, and asserts every input root still carries it.

**The OpenAPI response schemas open up too — deliberately.** The generator reuses the same output schemas for REST responses, so `POST /api/v1/memories`, `POST /api/v1/search`, `GET /api/v1/facts`, `GET /api/v1/briefing`, and the revise/resolve responses now publish `additionalProperties: true`. The rationale is the same one: a REST reader compiled against an older spec should not break on a field that was only added. Request bodies and query schemas are untouched.
