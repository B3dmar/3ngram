---
"@3ngram/server": patch
"@3ngram/schema": patch
---

Add `GET /api/v1/version`, returning the running server's package version, so deploy tooling can tell a finished rollout from one still in flight.

Nothing previously exposed build identity over HTTP: `/health` reports liveness and `/ready` reports readiness, but neither says *which build* answered. A post-deploy probe therefore could not distinguish a completed rollout from an in-flight one, and would happily verify the **previous** build while reporting success — a green light for code that was never exercised.

**Authenticated, like every `/api/v1` route.** It sits behind `apiOrSessionAuth`, so the exact version is never disclosed on an unauthenticated surface; this matches `/ready`, which logs RLS violations server-side but deliberately keeps catalog and role detail out of its HTTP response. Deploy tooling authenticates anyway.

**Deliberately ungated.** The response is the server's own build identity — not memory, not memory-derived, not tenant data — so no access gate applies. Staying ungated also keeps it orthogonal to the `AccessGate`: a deploy probe must remain answerable when the gate itself is broken, which is exactly the incident in which an operator most needs to know what is running.

The value comes from the existing `SERVER_VERSION` (read from `apps/server/package.json` at runtime), so it cannot skew from the published package version at a release; a test asserts that against `package.json` directly rather than against the constant.

Adds `versionResponseSchema` / `VersionResponse` to `@3ngram/schema` and the corresponding `getVersion` operation to the generated OpenAPI document.
