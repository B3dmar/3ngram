# @3ngram/core

## 0.9.0

### Minor Changes

- 4ed7e25: core: accept structured facts on remember

  A write can now carry the facts it asserts. `remember` takes an optional
  `facts` list of `{subject, predicate, value}` triples with an optional
  confidence and valid-time window, and returns their ids alongside the memory's.
  The facts are persisted in the same transaction as the memory, so a claim and
  its source can never be half-written.

  `rememberWithFactsInputSchema` is composed BESIDE the shipped
  `rememberInputSchema` rather than replacing it. That separation is what keeps
  `revise` rejecting a `facts` key: facts belong to the assertion that introduced
  them, and a revision appends a new memory, so silently carrying facts across
  would attribute them to the wrong row.

  The per-fact contract mirrors the import path minus the fields a fresh write
  already knows — no `memoryId` (the memory is being written in the same call) and
  no `recordedAt` (knowledge time is now, by definition). Validity is stricter
  than the `facts` table alone requires: a `validTo` demands a `validFrom`, so a
  window that ends but never begins is a field-level error rather than a
  constraint violation later. At most 16 facts per write; an empty list is
  equivalent to omitting the key, and both return no fact ids.

  Transports are unchanged in this release and still reject a `facts` key at
  their own boundary — core accepts it ahead of the MCP and REST surface.

- 4cd03d4: mcp: review extracted fact proposals alongside edge proposals

  `review_proposals` now covers both kinds of proposal. Listing returns extracted
  fact proposals next to consolidation ones, and accepting a fact proposal writes
  the structured fact so `get_facts` can read it — nothing an extractor produced
  becomes queryable truth without a person accepting it.

  The input is unchanged: accept and reject still take just the proposal id.
  Proposal ids are disjoint across the two tables, so the id alone identifies
  which kind it is, and core probes the edge table first and the fact table only
  when that reports not-found — a not-found reaches the caller only after both
  miss. Any other failure propagates instead of being retried against the wrong
  table.

  Existing responses are untouched. The list result only grows a `factProposals`
  key when there are some, so a tenant with only edge proposals sees the response
  it always saw; decisions on a fact proposal answer with their own
  `applied_fact` / `rejected_fact` variants rather than changing the payload under
  the shipped `applied` / `rejected` literals. Accepting a fact proposal also
  returns the id of the fact it wrote, so a reviewer does not need a second call
  to find out what landed.

  Listing bounds each kind by the same limit rather than splitting one budget, so
  a burst of extracted facts cannot push edge proposals out of the review window.

- 1d9a420: Add an exhaustive chronological list mode to `search`.

  Retrieving everything of a given shape (every decision from a project, every commitment recorded last week) previously meant issuing a ranked search and hoping the relevance ordering happened to surface it all within the result window — there was no way to ask for a complete, chronological listing.

  `search` now accepts `order: "chronological"` alongside the default `"relevance"`. Chronological mode returns a most-recent-first, unranked enumeration of live memories narrowed by the same candidate filters ranked search already supports (memoryType, scope, project, status, asOf, recordedAfter/recordedBefore). It never calls the embedding gateway — no query is required as long as at least one filter narrows the set — and pages through a small, drift-free keyset cursor instead of the ranked path's larger frozen-ordering token.

  Superseded predecessors are excluded from chronological listings by default (an exhaustive list has no ranking to demote a superseded row with, so it drops instead — the same live-only default the dashboard memory list already uses), unless an `asOf` coordinate explicitly asks for a historical view.

- 318025a: Fix `search` to demote every superseded predecessor, and label demoted hits.

  The supersession tier-penalty in `search` only fired for a `supersedes` edge — a revision recorded with the `updates` edge kind closed its predecessor's validity exactly the same way, but escaped the ranking demotion entirely, so a superseded row could still outrank its live successor. The penalty now applies whenever a row has an incoming `supersedes` or `updates` edge, matching the existing `CLOSES_PREDECESSOR` convention used elsewhere for the same two edge kinds.

  Search hits (both MCP and REST, full and compact projections) now also carry a `superseded: boolean` flag, so a caller can tell a demoted result from a current one instead of inferring it from score alone. Ranking stays supersession-_aware_, never supersession-_filtered_: a demoted row is still returned, just ranked below its successor and now labeled as such.

### Patch Changes

- Updated dependencies [eb68c04]
- Updated dependencies [d18e749]
- Updated dependencies [c6a819c]
- Updated dependencies [91f1d39]
- Updated dependencies [88ee7d4]
- Updated dependencies [4ed7e25]
- Updated dependencies [4cd03d4]
- Updated dependencies [1d9a420]
- Updated dependencies [318025a]
  - @3ngram/db@0.8.0
  - @3ngram/schema@0.7.0

## 0.8.6

### Patch Changes

- Updated dependencies [43a200c]
  - @3ngram/schema@0.6.4
  - @3ngram/db@0.7.5

## 0.8.5

### Patch Changes

- 1263111: Stop issuing refresh tokens to OAuth clients that never advertised the `refresh_token` grant (issue #86).

  The authorization-code exchange minted a refresh token unconditionally, but the token route gates the refresh grant on the client's advertised `grant_types`. A client registered for `authorization_code` alone — which is also the schema default when a CIMD document omits `grant_types` entirely — therefore received a refresh token that the very next request rejected as `invalid_client`. Nothing in the token response signalled that, so the client had no way to know the credential was inert until it tried to use it and lost its session.

  Issuance now matches what the authorization server will actually honour: the refresh token is omitted from the response and its hash is not persisted, since a hash for a token no client was ever handed can never be presented or rotated. `refresh_token` on the token response is now optional, which is what RFC 6749 §5.1 always specified.

  Rotation additionally fails closed if a client's advertised grants are narrowed between issuance and rotation, rather than revoking the predecessor and minting no successor.

  This predates the CIMD grant-type narrowing in #85 — `grant_types: ['authorization_code']` has always been accepted.

- Updated dependencies [1263111]
  - @3ngram/db@0.7.4

## 0.8.4

### Patch Changes

- Keep `engines.node` at `>=22`. The Node 24 work should only have moved what we build, test and ship on — CI and the container base — not what consumers must run. Nothing in this closure uses a Node 24 feature, and Node 22 is supported upstream until 2027-04-30, so raising the published floor would have hard-failed Node 22 consumers on a patch release. Raising it becomes a deliberate major when there is a reason.
- Updated dependencies
  - @3ngram/db@0.7.3
  - @3ngram/schema@0.6.3
  - @3ngram/llm@0.2.4

## 0.8.3

### Patch Changes

- 6e06cd6: Build, test and ship on Node 24 (Active LTS). CI, the release workflow and the server image base move to Node 24 — `node:24-bookworm-slim`, digest-pinned. `engines.node` deliberately stays `>=22`: nothing here requires a Node 24 feature, so consumers on Node 22 (supported until 2027-04-30) remain supported.
- Updated dependencies [6e06cd6]
  - @3ngram/db@0.7.2
  - @3ngram/schema@0.6.2
  - @3ngram/llm@0.2.3

## 0.8.2

### Patch Changes

- Updated dependencies [75ff6f4]
  - @3ngram/schema@0.6.1
  - @3ngram/db@0.7.1

## 0.8.1

### Patch Changes

- 4d0d05d: Fix every CIMD client resolution failing under a real ESM runtime.

  `client-metadata.ts` imported `ipaddr.js` as a namespace (`import * as ipaddr`). That package is CommonJS with `module.exports = ipaddr` and no `exports` map, so Node's ESM interop — which relies on `cjs-module-lexer` finding statically scannable assignments — synthesizes no usable named exports. Every member of the namespace was `undefined` at runtime, so the first call, `ipaddr.isValid(...)` in `resolveHostnameDefault`, threw a `TypeError`. `resolvePublicTarget` catches any resolver throw and relabels it `dns_failure`, so **every** Client ID Metadata Document resolution failed — for hostnames and IP literals alike, with no network I/O — and surfaced to the client as a bare `400 invalid_client` attributed to DNS.

  Vitest never saw this: Vite pre-bundles CJS dependencies through its own interop and synthesizes the named exports, so the module shape under test was not the shape the deployment got.

  The import is now a default import. `scripts/check-cjs-namespace-imports.mjs` guards the class: it imports every namespace-imported bare specifier through real Node ESM resolution (a throwaway sibling module, not `createRequire().resolve()`, which would select the `require` export condition and check a different file than `import` loads for a dual package) and fails when a member the source uses is absent. Detection is by member use rather than export count, because `ipaddr.js`'s namespace is not empty — the lexer emits a literal key named `module.exports`, which makes "has some named export" a false pass — and covers destructuring (`const { isValid } = ipaddr`) as well as property access, since both yield `undefined` in production.

  The script is **not yet wired into CI**: adding the `workspace-checks` step requires a token with `workflow` scope. Until that lands it runs manually via `node scripts/check-cjs-namespace-imports.mjs`.

## 0.8.0

### Minor Changes

- 7af346c: Fix CIMD client resolution failing closed on IPv4-mapped DNS answers, and record why an `/oauth/authorize` request was rejected.

  `resolvePublicTarget` compared the DNS-reported address family against `ipaddr.process()`, which UNMAPS `::ffff:a.b.c.d` to its IPv4 form. A resolver reports that answer as family 6, so the unmapped kind (`ipv4` → 4) disagreed with it and a perfectly self-consistent answer was treated as forged: every Client ID Metadata Document fetch on such a resolver failed closed with `unsafe_address` before a socket was opened, surfacing as a bare `400 { "error": "invalid_client" }`. The agreement check now uses `ipaddr.parse()`, which preserves the wire form. The security boundary is unchanged — `isPublicClientMetadataAddress()` still unmaps via `process()`, so a mapped loopback or private answer is still rejected.

  `/oauth/authorize` now emits one structured, content-free line per REJECTED request (`oauth: authorize endpoint`) carrying a hashed `client_id_prefix` and a closed-set `reason` — `not_registered`, `metadata_*` for each CIMD failure class, `metadata_not_materialized`, `unsupported_grant_type`, or `redirect_uri_mismatch`. Previously every one of those returned an identical bare 400 with nothing written anywhere, so a stale registration and a metadata document that never loaded were indistinguishable in production logs. The response is unchanged (still a uniform `invalid_client`, no enumeration oracle); the reason is diagnostic only.

  `resolveOAuthClient()` takes a new optional `options.onFailure` callback carrying the `ClientResolutionFailure` reason. Existing two-argument callers are unaffected.

## 0.7.0

### Minor Changes

- ba229fa: Briefing bounds V2 (issue #45): core `briefing()` honours the caller-tunable `sectionLimit` (clamped to the server-side ceiling of 100) and a `sections` subset — un-requested sections are skipped entirely (fewer queries) and omitted from the result; every returned section now carries `hasMore` (`count > items.length`). Brief mode fetches only its top slice since exact counts ride the `count(*) OVER()` window. The MCP `briefing` tool registers the composed V2 input/output schemas; a legacy `{selector, mode}` call returns the same sections as before plus `hasMore`.
- cfb7d50: Handoff bounds V2 (issue #45): core `handoff()` honours the caller-tunable `sectionLimit` (default 25, clamped to the server-side ceiling of 100) and stops discarding the exact window totals the briefing-read queries already compute — the envelope now carries `counts: {decisions, commitments, preferences}` plus per-section `truncated` flags (`counts.X > X.length`). The MCP `handoff` tool registers the composed V2 input/output schemas; a legacy `{selector, generatedFor?}` call returns the same lists as before plus the additive totals.
- b704728: Add the batched bounded-content read that backs the upcoming `get_memories` MCP tool: `getMemoriesInputSchema`/`getMemoriesOutputSchema` (own bounded module `get-memories.ts`; ids 1–20, `maxContentChars` 600–65,536 with default 10,000, aggregate `ids × maxContentChars` capped at 262,144, `count` enforced to equal `memories.length`) at the one validation boundary, a single-query `getMemoriesByIds` db read (`id = ANY` under one `withTenant`, RLS-safe), and core `getMemoriesByIds(userId, ids, { maxContentChars })` returning `{ memories, notFound }` — a missing or cross-tenant id is data (`notFound`), never an error. `excerptContent` now accepts an optional max-chars argument; existing call sites keep the shipped 600-char excerpt behavior.
- 11d1916: Retrieval-scope policy enforcement in core (issue #47, layer 2 of 3). Read surfaces accept an injected `retrievalPolicy` (a strict discriminated union: `off` / `default`+scope / `require`+registered scopes), resolved once per request by the transport — core stays env-free (one core, N transports). Mode `default` fills a missing scope axis (search `scope` filter; briefing/handoff selector `kind: 'all'`) and the result ECHOES `appliedScope` — never silent; `require` throws the typed `UnscopedRetrievalError` (a `MissingSelectorError` sibling) naming the registered scopes, before any metered work; `off` is byte-identical to shipped behavior, and policy-less callers keep the exact shipped return types (`search()` returns the `ScopedSearchResult` envelope only via the policy overload — the briefing() overload precedent). `searchDashboardPage` enforces on every page of a walk. New services: `resolveRetrievalPolicy` (row → enforcement union; `require` pre-reads the registry so the error can name scopes) and `setRetrievalDefault` (asserts a `default` scope is registered — typed `ScopeNotFoundError` otherwise). `describeEnvironment` now reports `retrievalScopePolicy` (off default when unset). Stated decision: `getFacts` is NOT policy-enforced — the facts surface has no scope axis (no scope column/filter), so `default` has nothing to apply and `require` would brick the tool.

  Scope renames now carry an active retrieval default to the new name atomically. Deleting the active default switches the policy to fail-closed `require`; per-user transaction locks serialize both mutations with the policy setter.

- eb2ea4e: Per-user retrieval-scope policy store (issue #47, layer 1 of 3): a new `user_retrieval_policy` table (one optional row per user; RLS + FORCE, tenant-isolation policy, Zod-derived mode and consistency CHECKs) with `getRetrievalPolicy`/`upsertRetrievalPolicy` accessors under `withTenant()`. The policy is included in account portability exports and reset to the inert `off` state during tombstone-style account erasure. The schema contract lands in a bounded `retrieval-scope` module: the `set_retrieval_default` `configure_scope` action variant composed onto the shipped action union, the `retrieval_default_set` output variant, and the additive `describe_environment` `retrievalScopePolicy` report field. Storage + contracts only; read-path enforcement remains in the stacked core layer.
- a364654: Add the `scope_project` orientation selector variant (issue #46): `{kind:'scope_project', scope, project, includeUnscoped}` selects the scope AND project intersection the shipped union could not express, with `includeUnscoped` (default false) as the opt-in NULL-project mitigation — `scope = $s AND (project = $p OR ($includeUnscoped AND project IS NULL))` in the single `memoryScopePredicate` all six briefing sections and handoff inherit. The V2 selector union (`briefingSelectorV2Schema`, packages/schema/src/briefing-bounds.ts) is composed from the shipped variant objects, so the three shipped variants stay byte-identical and the bare `project` variant is NOT widened. Core `requireSelector` validates the new variant; the published `BriefingSelector` type carries it with a required `includeUnscoped`.
- 1471fcb: Search filters V2 (issue #48, layer 1 of 2): the MCP `search` tool accepts two new candidate-narrowing filter axes — `memoryTypes` (an OR-set of memory types, 1–8 entries, mutually exclusive with the scalar `memoryType`) and `recordedAfter`/`recordedBefore` (an inclusive transaction-time range on `recorded_at` that narrows the live view WITHOUT lifting the active-only default — unlike `asOf`, it is not time travel). New composed `searchFiltersV2Schema`/`searchQueryV2Schema` in `@3ngram/schema` (the shipped V1 schemas are untouched); the db `rowEligibility` predicate gains `memory_type = ANY(...)` and `recorded_at >=/<=` branches spliced identically into every fusion leg (leg parity preserved); core threads the filters through unchanged. Fusion weights and ranking are untouched — filters narrow candidates pre-fusion only.

### Patch Changes

- cf088c1: Restrict the briefing's `staleCandidates` section to a reviewable memory-type allowlist: `memory_type IN ('decision', 'preference', 'blocker', 'fact')`. The previous predicate excluded only `commitment`, so every other live memory older than the 30-day stale window qualified — in production that matched ~74% of active memories (dominated by bulk-imported `event`/`note` rows) and made the section unusable noise. The allowlist is core policy (`STALE_CANDIDATE_TYPES`, exported beside `STALE_WINDOW_DAYS`) and fails closed: future or imported memory types are excluded by default. `packages/db`'s `staleCandidates` now accepts the allowlist as an OPTIONAL trailing parameter (after `limit`); when omitted, the legacy NOT-`commitment` filter applies, so existing five-argument callers keep both their signature and their prior behavior. The briefing output shape is unchanged.
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
  - @3ngram/schema@0.6.0
  - @3ngram/db@0.7.0

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
