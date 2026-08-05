# @3ngram/db

## 0.7.1

### Patch Changes

- Updated dependencies [75ff6f4]
  - @3ngram/schema@0.6.1

## 0.7.0

### Minor Changes

- b704728: Add the batched bounded-content read that backs the upcoming `get_memories` MCP tool: `getMemoriesInputSchema`/`getMemoriesOutputSchema` (own bounded module `get-memories.ts`; ids 1–20, `maxContentChars` 600–65,536 with default 10,000, aggregate `ids × maxContentChars` capped at 262,144, `count` enforced to equal `memories.length`) at the one validation boundary, a single-query `getMemoriesByIds` db read (`id = ANY` under one `withTenant`, RLS-safe), and core `getMemoriesByIds(userId, ids, { maxContentChars })` returning `{ memories, notFound }` — a missing or cross-tenant id is data (`notFound`), never an error. `excerptContent` now accepts an optional max-chars argument; existing call sites keep the shipped 600-char excerpt behavior.
- eb2ea4e: Per-user retrieval-scope policy store (issue #47, layer 1 of 3): a new `user_retrieval_policy` table (one optional row per user; RLS + FORCE, tenant-isolation policy, Zod-derived mode and consistency CHECKs) with `getRetrievalPolicy`/`upsertRetrievalPolicy` accessors under `withTenant()`. The policy is included in account portability exports and reset to the inert `off` state during tombstone-style account erasure. The schema contract lands in a bounded `retrieval-scope` module: the `set_retrieval_default` `configure_scope` action variant composed onto the shipped action union, the `retrieval_default_set` output variant, and the additive `describe_environment` `retrievalScopePolicy` report field. Storage + contracts only; read-path enforcement remains in the stacked core layer.
- a364654: Add the `scope_project` orientation selector variant (issue #46): `{kind:'scope_project', scope, project, includeUnscoped}` selects the scope AND project intersection the shipped union could not express, with `includeUnscoped` (default false) as the opt-in NULL-project mitigation — `scope = $s AND (project = $p OR ($includeUnscoped AND project IS NULL))` in the single `memoryScopePredicate` all six briefing sections and handoff inherit. The V2 selector union (`briefingSelectorV2Schema`, packages/schema/src/briefing-bounds.ts) is composed from the shipped variant objects, so the three shipped variants stay byte-identical and the bare `project` variant is NOT widened. Core `requireSelector` validates the new variant; the published `BriefingSelector` type carries it with a required `includeUnscoped`.
- 8598b09: Filters V2 parity on the REST memories list (issue #48, layer 2 of 2): `GET /api/v1/memories` accepts `memoryTypes` (repeatable query param — string once, array when repeated, the same handling as `project`; mutually exclusive with the scalar `type`) and `recordedAfter`/`recordedBefore` (inclusive ISO recorded_at range bounds). The db `listConditions` narrows via `eq`/`inArray` and `gte`/`lte` on top of the ever-present live gate — the range narrows the live view, never widens it. OpenAPI spec regenerated from the schema.
- 1471fcb: Search filters V2 (issue #48, layer 1 of 2): the MCP `search` tool accepts two new candidate-narrowing filter axes — `memoryTypes` (an OR-set of memory types, 1–8 entries, mutually exclusive with the scalar `memoryType`) and `recordedAfter`/`recordedBefore` (an inclusive transaction-time range on `recorded_at` that narrows the live view WITHOUT lifting the active-only default — unlike `asOf`, it is not time travel). New composed `searchFiltersV2Schema`/`searchQueryV2Schema` in `@3ngram/schema` (the shipped V1 schemas are untouched); the db `rowEligibility` predicate gains `memory_type = ANY(...)` and `recorded_at >=/<=` branches spliced identically into every fusion leg (leg parity preserved); core threads the filters through unchanged. Fusion weights and ranking are untouched — filters narrow candidates pre-fusion only.

### Patch Changes

- 11d1916: Retrieval-scope policy enforcement in core (issue #47, layer 2 of 3). Read surfaces accept an injected `retrievalPolicy` (a strict discriminated union: `off` / `default`+scope / `require`+registered scopes), resolved once per request by the transport — core stays env-free (one core, N transports). Mode `default` fills a missing scope axis (search `scope` filter; briefing/handoff selector `kind: 'all'`) and the result ECHOES `appliedScope` — never silent; `require` throws the typed `UnscopedRetrievalError` (a `MissingSelectorError` sibling) naming the registered scopes, before any metered work; `off` is byte-identical to shipped behavior, and policy-less callers keep the exact shipped return types (`search()` returns the `ScopedSearchResult` envelope only via the policy overload — the briefing() overload precedent). `searchDashboardPage` enforces on every page of a walk. New services: `resolveRetrievalPolicy` (row → enforcement union; `require` pre-reads the registry so the error can name scopes) and `setRetrievalDefault` (asserts a `default` scope is registered — typed `ScopeNotFoundError` otherwise). `describeEnvironment` now reports `retrievalScopePolicy` (off default when unset). Stated decision: `getFacts` is NOT policy-enforced — the facts surface has no scope axis (no scope column/filter), so `default` has nothing to apply and `require` would brick the tool.

  Scope renames now carry an active retrieval default to the new name atomically. Deleting the active default switches the policy to fail-closed `require`; per-user transaction locks serialize both mutations with the policy setter.

- cf088c1: Restrict the briefing's `staleCandidates` section to a reviewable memory-type allowlist: `memory_type IN ('decision', 'preference', 'blocker', 'fact')`. The previous predicate excluded only `commitment`, so every other live memory older than the 30-day stale window qualified — in production that matched ~74% of active memories (dominated by bulk-imported `event`/`note` rows) and made the section unusable noise. The allowlist is core policy (`STALE_CANDIDATE_TYPES`, exported beside `STALE_WINDOW_DAYS`) and fails closed: future or imported memory types are excluded by default. `packages/db`'s `staleCandidates` now accepts the allowlist as an OPTIONAL trailing parameter (after `limit`); when omitted, the legacy NOT-`commitment` filter applies, so existing five-argument callers keep both their signature and their prior behavior. The briefing output shape is unchanged.
- Updated dependencies [58e3f9d]
- Updated dependencies [b704728]
- Updated dependencies [eb2ea4e]
- Updated dependencies [0790813]
- Updated dependencies [a364654]
- Updated dependencies [2ecf3ab]
- Updated dependencies [351aee0]
- Updated dependencies [8598b09]
- Updated dependencies [1471fcb]
- Updated dependencies [1663683]
  - @3ngram/schema@0.6.0

## 0.6.2

### Patch Changes

- 78c062c: Fix the migrator's `provision-roles.sql` execution: run it over the pg simple query protocol (a plain-string `client.query`) instead of `db.execute(sql.raw(...))`, which uses the extended protocol and rejects the file's `DO $$…$$` block and multi-statement body. The migrator now also substitutes the runtime role from `RUNTIME_DB_ROLE` (default `app_user`) so a re-provisioned NOBYPASSRLS role is granted correctly, and the `ALTER ROLE … NOBYPASSRLS` re-assertion is tolerant of managed Postgres (Neon) where the provisioning role lacks privilege to change BYPASSRLS.

## 0.6.1

### Patch Changes

- cea2989: Make the runtime RLS guard's expected role name configurable via the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`). This lets a deployment whose runtime connects as a differently-named `NOBYPASSRLS` role pass the readiness check, instead of the role name being hardcoded.

## 0.6.0

### Minor Changes

- b88a6fa: Support Client ID Metadata Documents across OAuth discovery, authorization, token exchange, and grant management while retaining dynamic registration fallback.

### Patch Changes

- 63ebb77: Tenant-isolation hardening (fail-closed runtime guard): add a runtime RLS guard that asks the live database whether isolation is provably in force — the connected role is the expected NOBYPASSRLS/non-superuser runtime role and FORCE ROW LEVEL SECURITY is set on the tenant-data tables (forced-table set derived from the migrations). Wire it into a new `/ready` readiness endpoint (503 when it fails, keeping a misconfigured instance out of rotation) and as a boot-time fail-fast so a broken DB config can never begin serving traffic. Replace the string-match proof with a behavioral integration test and make the migration-drift RLS/policy checks enumerate migrations dynamically so a new tenant table that enables RLS without a tenant_isolation policy fails automatically.
- 2eb1ca8: Tenant-isolation hardening for the scopes registry: every scope query and mutation (list, rename, set-aliases, delete) and the environment-stats counts now carry an explicit caller-bound `user_id` predicate in SQL, in addition to RLS. Defense in depth — behavior is unchanged when RLS is active, since `(user_id, name)` is the natural key.
- 7c0c627: Add caller-bound `user_id` predicates to the briefing, facts, and dashboard memory reads (open/overdue commitments, live-memory and stale-candidate sections, getFacts, count/list/facets, getMemoryById) as a second tenant-isolation layer alongside RLS (defense in depth). Result sets are unchanged while RLS functions.
- 2c1fede: Add caller-bound `user_id` predicates to all ten tenant-table reads in the account data export (memories, facts, commitments, scopes, memory_edges, memory_events, consolidation_proposals, user_budgets, llm_usage, user_profile_attributes) as a second tenant-isolation layer alongside RLS (defense in depth). The user-profile read is now keyed on `user_id` instead of a bare limit. Result sets are unchanged while RLS functions.
- e5c1a2e: Add caller-bound `user_id` predicates to every search read (FTS, recency, vector, fused legs, id fetch, and the similar-pairs self-join) as a second tenant-isolation layer alongside RLS (defense in depth). Result sets are unchanged while RLS functions.
- 535db7c: Tenant-isolation hardening (defense in depth): FORCE row-level security on the twelve withTenant()-only tenant-data tables so policies also bind the table owner, re-assert NOBYPASSRLS on the runtime role on every provisioning run, and add a tenant-isolation policy to audit_log that pins tenant-bound transactions to their own rows while keeping the tenant-less system insert path open.
- Updated dependencies [d5080cd]
- Updated dependencies [b88a6fa]
  - @3ngram/schema@0.5.0

## 0.5.0

### Minor Changes

- 3d1f0ec: Add the REST-only ARCHIVE lifecycle operation: `POST /api/v1/memories/:id/archive` flips an active memory of any type to `status='archived'` (leaving `valid_to` NULL, so the row lands in the archived bucket that `GET /api/v1/memories?status=archived` and `GET /api/v1/stats` read) and records an `archive` audit event in the same transaction. Adoption-gate Decision D: no MCP tool mirrors this surface.

### Patch Changes

- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.
- b956a15: Add billing-neutral, optional live-memory and active-MCP-client limit primitives
  with exact transactional enforcement, explicit transport errors, and an exported
  server compatibility sentinel. Omitted limits remain unlimited for self-hosting.
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
  - @3ngram/schema@0.4.1

## 0.4.0

### Minor Changes

- fb2487a: Reshape into a clean, self-hostable OSS core. Remove the billing/subscription surface and replace the `CloudExtension` seam with a neutral `Extension` seam (`resolveLimits` / `AccessGate` / `onAccountDeletion` / export enricher), all with no-op self-host defaults. Keep the budget cost-cap as a self-host feature. Consolidate docs into a single Mintlify tree and make CI fork-friendly (pgvector service container instead of hosted branches).

### Patch Changes

- Updated dependencies [fb2487a]
  - @3ngram/schema@0.4.0

## 0.3.1

Initial public release.
