# @3ngram/core

## 0.6.3

### Patch Changes

- Updated dependencies [78c062c]
  - @3ngram/db@0.6.2

## 0.6.2

### Patch Changes

- 310e515: Make the production `DATABASE_URL` role-name check honor the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`), matching the RLS readiness guard. A deployment whose runtime connects as a differently-named `NOBYPASSRLS` role now passes env validation instead of being rejected for not using `app_user`.

## 0.6.1

### Patch Changes

- cea2989: Make the runtime RLS guard's expected role name configurable via the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`). This lets a deployment whose runtime connects as a differently-named `NOBYPASSRLS` role pass the readiness check, instead of the role name being hardcoded.
- Updated dependencies [cea2989]
  - @3ngram/db@0.6.1

## 0.6.0

### Minor Changes

- d5080cd: Add validated, SSRF-safe OAuth Client ID Metadata Document resolution and bounded HTTP caching.
- b88a6fa: Support Client ID Metadata Documents across OAuth discovery, authorization, token exchange, and grant management while retaining dynamic registration fallback.

### Patch Changes

- 69a66b3: Add RFC 9207 issuer identification to OAuth authorization responses and metadata.
- 63ebb77: Tenant-isolation hardening (fail-closed runtime guard): add a runtime RLS guard that asks the live database whether isolation is provably in force — the connected role is the expected NOBYPASSRLS/non-superuser runtime role and FORCE ROW LEVEL SECURITY is set on the tenant-data tables (forced-table set derived from the migrations). Wire it into a new `/ready` readiness endpoint (503 when it fails, keeping a misconfigured instance out of rotation) and as a boot-time fail-fast so a broken DB config can never begin serving traffic. Replace the string-match proof with a behavioral integration test and make the migration-drift RLS/policy checks enumerate migrations dynamically so a new tenant table that enables RLS without a tenant_isolation policy fails automatically.
- 2eb1ca8: Tenant-isolation hardening for the scopes registry: every scope query and mutation (list, rename, set-aliases, delete) and the environment-stats counts now carry an explicit caller-bound `user_id` predicate in SQL, in addition to RLS. Defense in depth — behavior is unchanged when RLS is active, since `(user_id, name)` is the natural key.
- 7c0c627: Add caller-bound `user_id` predicates to the briefing, facts, and dashboard memory reads (open/overdue commitments, live-memory and stale-candidate sections, getFacts, count/list/facets, getMemoryById) as a second tenant-isolation layer alongside RLS (defense in depth). Result sets are unchanged while RLS functions.
- e5c1a2e: Add caller-bound `user_id` predicates to every search read (FTS, recency, vector, fused legs, id fetch, and the similar-pairs self-join) as a second tenant-isolation layer alongside RLS (defense in depth). Result sets are unchanged while RLS functions.
- Updated dependencies [d5080cd]
- Updated dependencies [b88a6fa]
- Updated dependencies [63ebb77]
- Updated dependencies [2eb1ca8]
- Updated dependencies [7c0c627]
- Updated dependencies [2c1fede]
- Updated dependencies [e5c1a2e]
- Updated dependencies [535db7c]
  - @3ngram/schema@0.5.0
  - @3ngram/db@0.6.0

## 0.5.1

### Patch Changes

- e18e4a2: Bound every non-health HTTP surface with a coarse per-IP rate limit and replace trailing-slash regular expressions with linear-time normalization.
- Updated dependencies [e18e4a2]
  - @3ngram/llm@0.2.2

## 0.5.0

### Minor Changes

- 3d1f0ec: Add the REST-only ARCHIVE lifecycle operation: `POST /api/v1/memories/:id/archive` flips an active memory of any type to `status='archived'` (leaving `valid_to` NULL, so the row lands in the archived bucket that `GET /api/v1/memories?status=archived` and `GET /api/v1/stats` read) and records an `archive` audit event in the same transaction. Adoption-gate Decision D: no MCP tool mirrors this surface.

### Patch Changes

- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.
- b956a15: Add billing-neutral, optional live-memory and active-MCP-client limit primitives
  with exact transactional enforcement, explicit transport errors, and an exported
  server compatibility sentinel. Omitted limits remain unlimited for self-hosting.
- Updated dependencies [3d1f0ec]
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
  - @3ngram/db@0.5.0
  - @3ngram/llm@0.2.1
  - @3ngram/schema@0.4.1

## 0.4.0

### Minor Changes

- fb2487a: Reshape into a clean, self-hostable OSS core. Remove the billing/subscription surface and replace the `CloudExtension` seam with a neutral `Extension` seam (`resolveLimits` / `AccessGate` / `onAccountDeletion` / export enricher), all with no-op self-host defaults. Keep the budget cost-cap as a self-host feature. Consolidate docs into a single Mintlify tree and make CI fork-friendly (pgvector service container instead of hosted branches).

### Patch Changes

- Updated dependencies [fb2487a]
  - @3ngram/db@0.4.0
  - @3ngram/schema@0.4.0
  - @3ngram/llm@0.2.0

## 0.3.0

Initial public release.
