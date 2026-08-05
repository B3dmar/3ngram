# @3ngram/server

## 1.2.5

### Patch Changes

- a3ac379: Declare `hono` explicitly at 4.12.34 and raise the `hono`/`postcss` advisory overrides. `hono` reaches this package as an optional peer of `@modelcontextprotocol/node`, which pnpm auto-installs and which pnpm overrides cannot reach — the server genuinely needs it at runtime for the MCP HTTP transport, so it is now a declared dependency rather than an implicit one.
- 6e06cd6: Raise the supported Node floor to 24 (Active LTS). Node 22 entered maintenance on 2025-10-21 and receives security fixes only; Node 24 has been Active LTS since 2025-10-28. `engines.node` moves to `>=24`, CI and the release workflow test on 24, and the server image base moves to `node:24-bookworm-slim`.
- Updated dependencies [6e06cd6]
  - @3ngram/core@0.8.3
  - @3ngram/schema@0.6.2
  - @3ngram/config@0.2.4
  - @3ngram/llm@0.2.3

## 1.2.4

### Patch Changes

- Updated dependencies [75ff6f4]
  - @3ngram/schema@0.6.1
  - @3ngram/core@0.8.2

## 1.2.3

### Patch Changes

- Updated dependencies [4d0d05d]
  - @3ngram/core@0.8.1

## 1.2.2

### Patch Changes

- 7af346c: Fix CIMD client resolution failing closed on IPv4-mapped DNS answers, and record why an `/oauth/authorize` request was rejected.

  `resolvePublicTarget` compared the DNS-reported address family against `ipaddr.process()`, which UNMAPS `::ffff:a.b.c.d` to its IPv4 form. A resolver reports that answer as family 6, so the unmapped kind (`ipv4` → 4) disagreed with it and a perfectly self-consistent answer was treated as forged: every Client ID Metadata Document fetch on such a resolver failed closed with `unsafe_address` before a socket was opened, surfacing as a bare `400 { "error": "invalid_client" }`. The agreement check now uses `ipaddr.parse()`, which preserves the wire form. The security boundary is unchanged — `isPublicClientMetadataAddress()` still unmaps via `process()`, so a mapped loopback or private answer is still rejected.

  `/oauth/authorize` now emits one structured, content-free line per REJECTED request (`oauth: authorize endpoint`) carrying a hashed `client_id_prefix` and a closed-set `reason` — `not_registered`, `metadata_*` for each CIMD failure class, `metadata_not_materialized`, `unsupported_grant_type`, or `redirect_uri_mismatch`. Previously every one of those returned an identical bare 400 with nothing written anywhere, so a stale registration and a metadata document that never loaded were indistinguishable in production logs. The response is unchanged (still a uniform `invalid_client`, no enumeration oracle); the reason is diagnostic only.

  `resolveOAuthClient()` takes a new optional `options.onFailure` callback carrying the `ClientResolutionFailure` reason. Existing two-argument callers are unaffected.

- Updated dependencies [7af346c]
  - @3ngram/core@0.8.0

## 1.2.1

### Patch Changes

- b75c2fd: Security: force transitive `ip-address` to 10.3.1 (CVE-2026-69192, HIGH — via `express-rate-limit` → `@modelcontextprotocol/server-legacy`) with a scoped pnpm override, matching the repo's advisory-fix pattern. The vulnerable 10.2.0 resolution blocked the v1.2.0 release image scan (fail-closed; nothing was published).

## 1.2.0

### Minor Changes

- ba229fa: Briefing bounds V2 (issue #45): core `briefing()` honours the caller-tunable `sectionLimit` (clamped to the server-side ceiling of 100) and a `sections` subset — un-requested sections are skipped entirely (fewer queries) and omitted from the result; every returned section now carries `hasMore` (`count > items.length`). Brief mode fetches only its top slice since exact counts ride the `count(*) OVER()` window. The MCP `briefing` tool registers the composed V2 input/output schemas; a legacy `{selector, mode}` call returns the same sections as before plus `hasMore`.
- cfb7d50: Handoff bounds V2 (issue #45): core `handoff()` honours the caller-tunable `sectionLimit` (default 25, clamped to the server-side ceiling of 100) and stops discarding the exact window totals the briefing-read queries already compute — the envelope now carries `counts: {decisions, commitments, preferences}` plus per-section `truncated` flags (`counts.X > X.length`). The MCP `handoff` tool registers the composed V2 input/output schemas; a legacy `{selector, generatedFor?}` call returns the same lists as before plus the additive totals.
- 657f224: Register the `get_memories` MCP tool (11th tool; the last slot stays reserved for `manage_context`): a batched full-content read for ids a `search`/`handoff` result surfaced with `truncated: true` — up to 20 ids, per-item content bounded at `maxContentChars` (default 10,000, ceiling 65,536), unknown/cross-tenant ids returned as `notFound` data instead of an error. The `search` and `handoff` tool descriptions now point truncated results at `get_memories`; docs drop the never-built `memory_ids` search claim and record the 11-tool surface.
- eb2ea4e: Per-user retrieval-scope policy store (issue #47, layer 1 of 3): a new `user_retrieval_policy` table (one optional row per user; RLS + FORCE, tenant-isolation policy, Zod-derived mode and consistency CHECKs) with `getRetrievalPolicy`/`upsertRetrievalPolicy` accessors under `withTenant()`. The policy is included in account portability exports and reset to the inert `off` state during tombstone-style account erasure. The schema contract lands in a bounded `retrieval-scope` module: the `set_retrieval_default` `configure_scope` action variant composed onto the shipped action union, the `retrieval_default_set` output variant, and the additive `describe_environment` `retrievalScopePolicy` report field. Storage + contracts only; read-path enforcement remains in the stacked core layer.
- 0790813: Retrieval-scope policy wiring (issue #47, layer 3 of 3 — closes the stack). The MCP transport resolves the user's policy at most once per request (a memoized thunk over core `resolveRetrievalPolicy`, paid only by the read tools) and injects it into search/briefing/handoff; `configure_scope` gains the `set_retrieval_default` action (write-scoped; a `default` scope must exist in the registry — typed not_found otherwise) and `describe_environment` reports `retrievalScopePolicy`. Results echo `appliedScope` exactly when the policy narrowed an unscoped call (schema successors: `searchToolOutputV3Schema`, `briefingToolOutputV4Schema`, `handoffToolOutputV4Schema`, `searchRestResponseV2Schema`, `dashboardSearchResponseV2Schema` — shipped schemas byte-identical); an unscoped read under mode `require` maps to a typed invalid_input naming the registered scopes (MCP isError; REST 400 with the recovery in `detail`). REST parity: `/api/v1/search`, `/api/v1/dashboard/search`, and `/api/v1/briefing` ride the same injected policy. The SDK and CLI preserve recovery detail, and human CLI search output reports a policy-applied scope. Docs, OpenAPI, the MCP reference, and the transport-cost fixture are regenerated in lockstep (frozen totals updated); the golden-set eval gate holds at floors.
- 2ecf3ab: Wire the `scope_project` selector onto the orientation transports (issue #46, layer 2 of 2): `briefing` and `handoff` register the V3 tool IO (`briefingToolInputV3Schema`/`handoffToolInputV3Schema` + matching outputs). Each V3 schema is rebuilt from its shipped base with `.extend(...)`, widening only the selector while reapplying the shared V2 fields and refinements (duplicate-section rejection and hasMore/counts identities), so every V2-valid payload parses identically. The REST `GET /api/v1/briefing` route accepts `kind=scope_project&scope=…&project=…&includeUnscoped=true|false` (only the literal strings coerce; anything else is a schema 400). Tool descriptions document the NULL-project semantics: a memory written without a project never appears through the bare `project` lens — `scope_project` with `includeUnscoped: true` is the explicit opt-in, and the bare variant is never widened. `docs/reference/tools.mdx`, the OpenAPI spec, and the transport-cost fixture + frozen totals are regenerated in lockstep.
- 16ea45a: MCP `search` cursor pagination + compact projection (issue #49, layer 2 of 2): the tool registers the composed `searchQueryV3Schema` / `searchToolOutputV2Schema` and routes through the same frozen-ordering machinery the dashboard uses (core `searchDashboardPage` + the shared server cursor codec). Page 1 freezes the ranked candidate pool into an opaque `nextCursor`; a continuation pages by position within it, so a mid-walk write or archive can never duplicate or skip a hit. The tool description documents the cursor's real context cost (~4-6 KB token) and the pool-exhaustion cap (`hasMore: false` means refine the query, not page harder). `projection: "compact"` omits `content`/`contentLength`/`truncated` per hit (~5x fewer tokens) for broad scans, pairing with `get_memories` for follow-up reads. A garbled cursor is a typed client error, never a 500. Fusion weights and ranking are untouched (eval gate holds at floors); `docs/reference/tools.mdx` and the transport-cost fixture are regenerated in lockstep.
- 8598b09: Filters V2 parity on the REST memories list (issue #48, layer 2 of 2): `GET /api/v1/memories` accepts `memoryTypes` (repeatable query param — string once, array when repeated, the same handling as `project`; mutually exclusive with the scalar `type`) and `recordedAfter`/`recordedBefore` (inclusive ISO recorded_at range bounds). The db `listConditions` narrows via `eq`/`inArray` and `gte`/`lte` on top of the ever-present live gate — the range narrows the live view, never widens it. OpenAPI spec regenerated from the schema.
- 1471fcb: Search filters V2 (issue #48, layer 1 of 2): the MCP `search` tool accepts two new candidate-narrowing filter axes — `memoryTypes` (an OR-set of memory types, 1–8 entries, mutually exclusive with the scalar `memoryType`) and `recordedAfter`/`recordedBefore` (an inclusive transaction-time range on `recorded_at` that narrows the live view WITHOUT lifting the active-only default — unlike `asOf`, it is not time travel). New composed `searchFiltersV2Schema`/`searchQueryV2Schema` in `@3ngram/schema` (the shipped V1 schemas are untouched); the db `rowEligibility` predicate gains `memory_type = ANY(...)` and `recorded_at >=/<=` branches spliced identically into every fusion leg (leg parity preserved); core threads the filters through unchanged. Fusion weights and ranking are untouched — filters narrow candidates pre-fusion only.

### Patch Changes

- 351aee0: Search cursor pagination + compact projection contracts (issue #49, layer 1 of 2): new composed `searchQueryV3Schema` in `@3ngram/schema` (own bounded module `search-cursor.ts`) adds `cursor` (opaque frozen-ordering continuation token) and `projection` (`full` default / `compact`, which omits the per-hit `content`/`contentLength`/`truncated` triple) onto the shipped `searchQueryV2Schema`; new `searchToolOutputV2Schema` adds `hasMore` + `nextCursor` with enforced consistency (`count === hits.length`; `nextCursor` present iff `hasMore`). The shipped V1/V2 schemas are untouched. The base64url cursor codec moves from `apps/server/src/rest/cursor.ts` to the shared `apps/server/src/cursor.ts` so the MCP search tool (layer 2) can reuse it. No ranking changes; the frozen-ordering core path (`searchDashboardPage`) is reused as-is.

  Review hardening: `searchToolOutputV2Schema` additionally enforces one projection per page (a mixed full/compact `hits` array is rejected), and continuation cursors are now BOUND to the search that issued them — the cursor payload gains an optional `fp` fingerprint (truncated sha256 of the normalized query + filter set) that issuance populates and continuation verifies, rejecting a cursor replayed under a changed query/filters with a typed 400 (`CursorQueryMismatchError`) instead of silently re-paging the old frozen ordering. `fp` is optional with verify-when-present semantics: fingerprint-less cursors minted before this change stay valid.

- 1663683: Recorded-range hardening (issue #58): the recordedAfter/recordedBefore pair is now validated by one shared rule set (`recordedRangeIssues` in `packages/schema/src/recorded-range.ts`) applied by BOTH transports — the MCP search schema (searchQueryV2Schema, carried into V3) and the REST `GET /api/v1/memories` query schema. The REST list now rejects an inverted range as a 400 (parity with MCP — previously an empty 200), and both surfaces reject a bound with more than 3 fractional-second digits instead of silently truncating it to JS millisecond precision (Postgres stores `recorded_at` at microsecond precision, so a truncated bound could leak a boundary row past an inclusive bound). `searchFingerprint` now hashes the post-parse query text verbatim — both transport query schemas trim at parse, so the fingerprint hashes exactly the text core embeds (no behavior change for schema-parsed callers).
- Updated dependencies [ba229fa]
- Updated dependencies [cfb7d50]
- Updated dependencies [58e3f9d]
- Updated dependencies [b704728]
- Updated dependencies [11d1916]
- Updated dependencies [eb2ea4e]
- Updated dependencies [0790813]
- Updated dependencies [a364654]
- Updated dependencies [2ecf3ab]
- Updated dependencies [351aee0]
- Updated dependencies [8598b09]
- Updated dependencies [1471fcb]
- Updated dependencies [1663683]
- Updated dependencies [cf088c1]
  - @3ngram/core@0.7.0
  - @3ngram/schema@0.6.0

## 1.1.3

### Patch Changes

- @3ngram/core@0.6.3

## 1.1.2

### Patch Changes

- 310e515: Make the production `DATABASE_URL` role-name check honor the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`), matching the RLS readiness guard. A deployment whose runtime connects as a differently-named `NOBYPASSRLS` role now passes env validation instead of being rejected for not using `app_user`.
- Updated dependencies [310e515]
  - @3ngram/config@0.2.3
  - @3ngram/core@0.6.2

## 1.1.1

### Patch Changes

- cea2989: Make the runtime RLS guard's expected role name configurable via the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`). This lets a deployment whose runtime connects as a differently-named `NOBYPASSRLS` role pass the readiness check, instead of the role name being hardcoded.
- Updated dependencies [cea2989]
  - @3ngram/core@0.6.1

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
