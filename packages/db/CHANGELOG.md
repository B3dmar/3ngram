# @3ngram/db

## 0.8.2

### Patch Changes

- Updated dependencies [851fa53]
  - @3ngram/schema@0.7.2

## 0.8.1

### Patch Changes

- 483c658: Five correctness fixes to the facts, portability, and retrieval surfaces.

  **`fact_proposals` is now erased on account deletion.** Account deletion tombstones the `users` row rather than deleting it, so the FK's `ON DELETE CASCADE` never fires — a staged fact proposal kept its `subject`, `predicate`, `value`, and `rationale` through an Article 17 erasure. It is now redacted in place in the same transaction as `facts` and `consolidation_proposals` (redact-in-place, not DELETE: the runtime role has no DELETE grant on memory-domain tables). The erasure receipt gains a `factProposals` count on `DELETE /api/v1/account` and in the audit tombstone.

  **`fact_proposals` is now included in the portability export.** `GET /api/v1/export` carried `facts` and `consolidation_proposals` but not the staged proposals, which are user content that is not yet a `facts` row. The archive gains a `factProposals` section (and a matching `counts.factProposals`), read under the same repeatable-read snapshot as every other section.

  **Chronological search now rejects a `query` instead of silently ignoring it.** `order: 'chronological'` is an unranked enumeration and the core path takes no query argument, so a caller passing `{order: 'chronological', query}` was returned the whole live corpus as though it had been searched. A present `query` is now a validation error naming `order: 'relevance'` as the ranked alternative. Because `query` no longer bounds the scan, chronological order now REQUIRES at least one filter (previously "query or >=1 filter").

  **Fact write timestamps no longer truncate to milliseconds.** `validFrom`/`validTo` on a written fact accepted arbitrary fractional-second precision, but core converts them with `new Date()` (millisecond) on the way to microsecond-precision Postgres columns — a finer instant silently moved the boundary of a bi-temporal window. Both bounds are now capped at 3 fractional-second digits and REJECTED beyond it, matching the facts-range read bounds, with the limit advertised in the field descriptions.

  **Imported `updates` edges no longer mark live memories superseded.** The `superseded` flag and its ranking tier-penalty counted any incoming `supersedes`/`updates` edge, but the import contract forbids `closePredecessorAt` on an `updates` edge — so every imported `updates`-edge target stayed live (`valid_to IS NULL`) yet read `superseded: true` and was demoted in ranking. The predicate now requires BOTH a revision edge AND closed validity, the same definition `memory_history`'s `lifecycleState` applies, so search and history can no longer disagree about the same row. Genuine revisions are unaffected: the revise path closes `valid_to` for both edge kinds.

- Updated dependencies [483c658]
  - @3ngram/schema@0.7.1

## 0.8.0

### Minor Changes

- eb68c04: db: review operations for staged fact proposals

  Adds the insert, list, reject and apply steps for `fact_proposals`, so an
  extracted candidate can be staged, reviewed, and either turned into a real fact
  or turned down — with the row surviving either way as its own audit trail.

  Re-running an extractor over the same memory is a no-op: the insert skips a
  triple that already has an open proposal, and repeated extractions collapse to
  the first one, since the idempotency key deliberately ignores confidence,
  memory type and the validity window. A rejected proposal does not block
  re-proposing the same claim later.

  Applying flips the status first, with the transition guarded on the row still
  being open, so a concurrent double-apply loses the race rather than writing the
  fact twice; the flip and the fact insert share one transaction. A proposal
  carrying no `valid_from` — an extractor often cannot date a claim — lets the
  fact take its own default, so it becomes true when it was accepted. Applying
  against a source memory that has since been superseded is allowed: a fact
  carries its own validity and stands on its own once asserted, and the reviewer
  accepted the claim rather than the prose version.

- d18e749: db: add the `fact_proposals` staging table (migration 0031)

  A staging area so extracted facts are human-reviewed before becoming queryable
  truth. Candidates land in `fact_proposals` with a `proposed` status and only
  reach `facts` once accepted, which keeps the structured projection something a
  reader can trust without re-checking its source.

  Shape follows the shipped memory tables: explicit `user_id`, a tenant-qualified
  composite FK `(user_id, memory_id)` → `memories`, `user_id`-leading indexes, a
  `tenant_isolation` policy with the NULLIF guard, and FORCE row level security so
  a wrong-role connection fails closed. A partial unique index allows one open
  proposal per `(memory, subject, predicate, value)` while still permitting
  re-proposal after a rejection, and the status/memory-type CHECKs are generated
  from the `@3ngram/schema` enums rather than restated in SQL.

  `fact_proposals` is a sibling of `consolidation_proposals`, not a new mode on
  it: every shipped database object is left byte-identical. Grants are
  SELECT/INSERT/UPDATE only — a decision flips a status, it never deletes a row.

  Deploy note: creating the composite foreign key takes a brief lock on
  `memories`, so on a busy database the migration can queue behind a long-running
  transaction. Run it with a `lock_timeout` and retry rather than letting it
  block writes.

- c6a819c: `get_facts` gains a `range: {from?, to?}` window for chronological time-series reads over the bi-temporal facts table, on both the MCP tool and REST `GET /api/v1/facts`.

  `range` replaces (never appends to) the default live-only predicate with a half-open `[from, to)` valid-time overlap: a fact whose validity window overlaps the requested range is returned, including generations superseded inside it — the point of a time-series read over "what's currently true." Ordering flips to `valid_from ASC` (chronological) instead of the default `recorded_at DESC` (recency); `range` and `asOf` are mutually exclusive point-in-time vs. window modes, enforced at the schema boundary (empty range object rejected, mirroring `asOfSchema`; an inverted `from`/`to` range rejected rather than silently returning empty, per issue #58's REST/MCP parity precedent). Each bound is also capped at millisecond precision (issue #58 item 2's fix, applied here too): `valid_from`/`valid_to` are microsecond-precise in Postgres, so a sub-millisecond bound would silently truncate up to the next whole millisecond and let an already-ended generation leak into the window. The existing `DEFAULT_FACTS_LIMIT`/`MAX_FACTS_LIMIT` bounds still apply in range mode.

  Every returned fact now also carries `recordedAt` (transaction time) — an additive, output-only widening useful for telling apart same-window generations recorded at different instants.

  Deliberately out of scope: a `valid_from` index (the sort is accepted at current volumes) and a scope axis on `get_facts` (the facts table has no scope column — continuing issue #47's open item). The SDK `getFacts` client and the CLI `facts` command do not yet expose the `from`/`to` range axis (REST/MCP only for now); follow-up planned.

- 91f1d39: db: write structured facts atomically with the memory that asserts them

  `writeMemory` takes an optional list of facts and inserts them in the SAME
  transaction as the memory and its audit event, returning their ids on
  `WrittenMemory.factIds`. A fact whose source memory rolled back would be an
  unsourced claim in the structured projection, and a memory whose facts silently
  vanished would be a claim nobody can query — neither is now representable.

  Facts are written for every memory type. The commitment auto-create is an early
  return in `writeMemory`, so the insert deliberately sits before it: a commitment
  memory comes back with both its `commitmentId` and its `factIds`.

  The column-level inserts move to a new tx-taking `insertFact`/`insertFacts` pair
  that composes inside a caller's transaction, following the existing
  `insertEdge` split. The import path keeps its own wrapper — the tenant
  transaction and the typed not-found probe are what make it import-specific — and
  now delegates the columns, so both write paths cannot drift apart. A write that
  supplies no facts is unchanged down to the returned object, which omits
  `factIds` entirely rather than returning an empty array.

- 1d9a420: Add an exhaustive chronological list mode to `search`.

  Retrieving everything of a given shape (every decision from a project, every commitment recorded last week) previously meant issuing a ranked search and hoping the relevance ordering happened to surface it all within the result window — there was no way to ask for a complete, chronological listing.

  `search` now accepts `order: "chronological"` alongside the default `"relevance"`. Chronological mode returns a most-recent-first, unranked enumeration of live memories narrowed by the same candidate filters ranked search already supports (memoryType, scope, project, status, asOf, recordedAfter/recordedBefore). It never calls the embedding gateway — no query is required as long as at least one filter narrows the set — and pages through a small, drift-free keyset cursor instead of the ranked path's larger frozen-ordering token.

  Superseded predecessors are excluded from chronological listings by default (an exhaustive list has no ranking to demote a superseded row with, so it drops instead — the same live-only default the dashboard memory list already uses), unless an `asOf` coordinate explicitly asks for a historical view.

- 318025a: Fix `search` to demote every superseded predecessor, and label demoted hits.

  The supersession tier-penalty in `search` only fired for a `supersedes` edge — a revision recorded with the `updates` edge kind closed its predecessor's validity exactly the same way, but escaped the ranking demotion entirely, so a superseded row could still outrank its live successor. The penalty now applies whenever a row has an incoming `supersedes` or `updates` edge, matching the existing `CLOSES_PREDECESSOR` convention used elsewhere for the same two edge kinds.

  Search hits (both MCP and REST, full and compact projections) now also carry a `superseded: boolean` flag, so a caller can tell a demoted result from a current one instead of inferring it from score alone. Ranking stays supersession-_aware_, never supersession-_filtered_: a demoted row is still returned, just ranked below its successor and now labeled as such.

### Patch Changes

- Updated dependencies [c6a819c]
- Updated dependencies [88ee7d4]
- Updated dependencies [4ed7e25]
- Updated dependencies [4cd03d4]
- Updated dependencies [1d9a420]
- Updated dependencies [318025a]
  - @3ngram/schema@0.7.0

## 0.7.5

### Patch Changes

- Updated dependencies [43a200c]
  - @3ngram/schema@0.6.4

## 0.7.4

### Patch Changes

- 1263111: Stop issuing refresh tokens to OAuth clients that never advertised the `refresh_token` grant (issue #86).

  The authorization-code exchange minted a refresh token unconditionally, but the token route gates the refresh grant on the client's advertised `grant_types`. A client registered for `authorization_code` alone — which is also the schema default when a CIMD document omits `grant_types` entirely — therefore received a refresh token that the very next request rejected as `invalid_client`. Nothing in the token response signalled that, so the client had no way to know the credential was inert until it tried to use it and lost its session.

  Issuance now matches what the authorization server will actually honour: the refresh token is omitted from the response and its hash is not persisted, since a hash for a token no client was ever handed can never be presented or rotated. `refresh_token` on the token response is now optional, which is what RFC 6749 §5.1 always specified.

  Rotation additionally fails closed if a client's advertised grants are narrowed between issuance and rotation, rather than revoking the predecessor and minting no successor.

  This predates the CIMD grant-type narrowing in #85 — `grant_types: ['authorization_code']` has always been accepted.

## 0.7.3

### Patch Changes

- Keep `engines.node` at `>=22`. The Node 24 work should only have moved what we build, test and ship on — CI and the container base — not what consumers must run. Nothing in this closure uses a Node 24 feature, and Node 22 is supported upstream until 2027-04-30, so raising the published floor would have hard-failed Node 22 consumers on a patch release. Raising it becomes a deliberate major when there is a reason.
- Updated dependencies
  - @3ngram/schema@0.6.3

## 0.7.2

### Patch Changes

- 6e06cd6: Build, test and ship on Node 24 (Active LTS). CI, the release workflow and the server image base move to Node 24 — `node:24-bookworm-slim`, digest-pinned. `engines.node` deliberately stays `>=22`: nothing here requires a Node 24 feature, so consumers on Node 22 (supported until 2027-04-30) remain supported.
- Updated dependencies [6e06cd6]
  - @3ngram/schema@0.6.2

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
