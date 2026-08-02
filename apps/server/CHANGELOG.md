# @3ngram/server

## 1.1.0

### Minor Changes

- b88a6fa: Support Client ID Metadata Documents across OAuth discovery, authorization, token exchange, and grant management while retaining dynamic registration fallback.
- 8bf4847: Serve legacy and `2026-07-28` MCP clients from one stateless SDK v2 handler.

### Patch Changes

- 69a66b3: Add RFC 9207 issuer identification to OAuth authorization responses and metadata.
- 63ebb77: Tenant-isolation hardening (fail-closed runtime guard): add a runtime RLS guard that asks the live database whether isolation is provably in force — the connected role is the expected NOBYPASSRLS/non-superuser runtime role and FORCE ROW LEVEL SECURITY is set on the tenant-data tables (forced-table set derived from the migrations). Wire it into a new `/ready` readiness endpoint (503 when it fails, keeping a misconfigured instance out of rotation) and as a boot-time fail-fast so a broken DB config can never begin serving traffic. Replace the string-match proof with a behavioral integration test and make the migration-drift RLS/policy checks enumerate migrations dynamically so a new tenant table that enables RLS without a tenant_isolation policy fails automatically.
- dcc98b7: Add modern MCP catalog cache hints and bounded pre-parser header observability.
- 99be80f: Document the 2000-character content cap in the remember MCP tool description.
- Updated dependencies [d5080cd]
- Updated dependencies [b88a6fa]
- Updated dependencies [69a66b3]
- Updated dependencies [63ebb77]
- Updated dependencies [2eb1ca8]
- Updated dependencies [7c0c627]
- Updated dependencies [e5c1a2e]
- Updated dependencies [dcc98b7]
  - @3ngram/core@0.6.0
  - @3ngram/schema@0.5.0
  - @3ngram/config@0.2.2

## 1.0.2

### Patch Changes

- e18e4a2: Bound every non-health HTTP surface with a coarse per-IP rate limit and replace trailing-slash regular expressions with linear-time normalization.
- Updated dependencies [e18e4a2]
  - @3ngram/core@0.5.1
  - @3ngram/llm@0.2.2

## 1.0.1

### Patch Changes

- 4b6e545: Remove the unused npm toolchain from the production server image.

## 1.0.0

### Major Changes

- b956a15: Release the stable 3ngram v1 product line: MCP and REST server, worker,
  TypeScript SDK, and bare `3ngram` CLI.

### Minor Changes

- 3d1f0ec: Add the REST-only ARCHIVE lifecycle operation: `POST /api/v1/memories/:id/archive` flips an active memory of any type to `status='archived'` (leaving `valid_to` NULL, so the row lands in the archived bucket that `GET /api/v1/memories?status=archived` and `GET /api/v1/stats` read) and records an `archive` audit event in the same transaction. Adoption-gate Decision D: no MCP tool mirrors this surface.

### Patch Changes

- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.
- b956a15: Add billing-neutral, optional live-memory and active-MCP-client limit primitives
  with exact transactional enforcement, explicit transport errors, and an exported
  server compatibility sentinel. Omitted limits remain unlimited for self-hosting.
- Updated dependencies [b956a15]
- Updated dependencies [3d1f0ec]
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
  - @3ngram/config@0.2.1
  - @3ngram/core@0.5.0
  - @3ngram/llm@0.2.1
  - @3ngram/schema@0.4.1

## 0.8.0

## 0.7.3

### Patch Changes

- No-op release validating token-free npm publishing: OIDC trusted publishing via pnpm with provenance attestations.

## 0.7.2

### Patch Changes

- No-op release validating the npm trusted-publishing (OIDC) cutover: publishes via the registered trusted publisher instead of a token, with provenance attestations and per-package release tags.

## 0.7.1

### Patch Changes

- c2d9a99: Security dependency bumps: nodemailer 9.0.1 (direct), plus workspace overrides for hono 4.12.25, js-yaml 3.15.0, @opentelemetry/core 2.8.0, and esbuild 0.28.1 to clear the open Dependabot advisories.

## 0.7.0

### Minor Changes

- fb2487a: Reshape into a clean, self-hostable OSS core. Remove the billing/subscription surface and replace the `CloudExtension` seam with a neutral `Extension` seam (`resolveLimits` / `AccessGate` / `onAccountDeletion` / export enricher), all with no-op self-host defaults. Keep the budget cost-cap as a self-host feature. Consolidate docs into a single Mintlify tree and make CI fork-friendly (pgvector service container instead of hosted branches).

### Patch Changes

- Updated dependencies [fb2487a]
  - @3ngram/core@0.4.0
  - @3ngram/schema@0.4.0
  - @3ngram/config@0.2.0
  - @3ngram/llm@0.2.0

## 0.6.0

Initial public release.
