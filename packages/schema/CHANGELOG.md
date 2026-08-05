# @3ngram/schema

## 0.6.3

### Patch Changes

- Keep `engines.node` at `>=22`. The Node 24 work should only have moved what we build, test and ship on — CI and the container base — not what consumers must run. Nothing in this closure uses a Node 24 feature, and Node 22 is supported upstream until 2027-04-30, so raising the published floor would have hard-failed Node 22 consumers on a patch release. Raising it becomes a deliberate major when there is a reason.

## 0.6.2

### Patch Changes

- 6e06cd6: Build, test and ship on Node 24 (Active LTS). CI, the release workflow and the server image base move to Node 24 — `node:24-bookworm-slim`, digest-pinned. `engines.node` deliberately stays `>=22`: nothing here requires a Node 24 feature, so consumers on Node 22 (supported until 2027-04-30) remain supported.

## 0.6.1

### Patch Changes

- 75ff6f4: Stop rejecting a Client ID Metadata Document because it advertises a grant type this server does not implement.

  `clientIdMetadataDocumentSchema` validated `grant_types` as `z.array(z.enum(['authorization_code','refresh_token'])).max(2)`, so any document listing a third grant failed structurally and the client could not authorize at all. That locked out real MCP clients: claude.ai's document advertises `urn:ietf:params:oauth:grant-type:jwt-bearer` alongside the two grants we support, failing both the enum and the `max(2)` cap and producing a bare `400 invalid_client`.

  `grant_types` and `response_types` advertise what a client MAY use (RFC 7591 §2). MCP's CIMD requirements for an authorization server are to validate that `client_id` matches the document URL, to validate `redirect_uris`, and to validate that the structure is valid JSON containing the required fields — `client_id`, `client_name`, `redirect_uris`. `grant_types` is not among them, and nothing licenses condemning a whole document over one unsupported entry.

  Both fields are now parsed permissively and narrowed to what this server issues. The bound stays on the raw array, since unbounded input is the actual risk; the narrowed result is by construction no larger than the supported set. Structurally malformed advertisements (a non-array, or an empty array) are still rejected, and the absent-field default is unchanged.

  `grant_types` may narrow to an empty list: usability is a policy question the `/authorize` path already answers with a precise `unsupported_grant_type`, rather than a blanket `invalid_document` from the structural boundary. `response_types` may not — it tolerates extra advertised values but still requires `code` to survive. The asymmetry is deliberate: nothing downstream consults the client's advertised `response_types`, so allowing it to empty would admit a document advertising only `token` and still issue it an authorization code, silently dropping a constraint the previous `z.literal('code')` array enforced.

## 0.6.0

### Minor Changes

- 58e3f9d: Add the briefing/handoff bounds V2 contracts (`packages/schema/src/briefing-bounds.ts`): composed successor input schemas with a caller-tunable `sectionLimit` (bounded by the new server-side ceilings `MAX_BRIEFING_SECTION_CEILING`/`MAX_HANDOFF_SECTION_CEILING`, both 100) and an optional briefing `sections` subset selector, plus successor output schemas where briefing sections gain a `hasMore` flag and the handoff envelope gains exact per-section `counts` + `truncated` flags. Shipped V1 schemas stay byte-identical; a legacy input parses identically through V1 and V2.
- b704728: Add the batched bounded-content read that backs the upcoming `get_memories` MCP tool: `getMemoriesInputSchema`/`getMemoriesOutputSchema` (own bounded module `get-memories.ts`; ids 1–20, `maxContentChars` 600–65,536 with default 10,000, aggregate `ids × maxContentChars` capped at 262,144, `count` enforced to equal `memories.length`) at the one validation boundary, a single-query `getMemoriesByIds` db read (`id = ANY` under one `withTenant`, RLS-safe), and core `getMemoriesByIds(userId, ids, { maxContentChars })` returning `{ memories, notFound }` — a missing or cross-tenant id is data (`notFound`), never an error. `excerptContent` now accepts an optional max-chars argument; existing call sites keep the shipped 600-char excerpt behavior.
- eb2ea4e: Per-user retrieval-scope policy store (issue #47, layer 1 of 3): a new `user_retrieval_policy` table (one optional row per user; RLS + FORCE, tenant-isolation policy, Zod-derived mode and consistency CHECKs) with `getRetrievalPolicy`/`upsertRetrievalPolicy` accessors under `withTenant()`. The policy is included in account portability exports and reset to the inert `off` state during tombstone-style account erasure. The schema contract lands in a bounded `retrieval-scope` module: the `set_retrieval_default` `configure_scope` action variant composed onto the shipped action union, the `retrieval_default_set` output variant, and the additive `describe_environment` `retrievalScopePolicy` report field. Storage + contracts only; read-path enforcement remains in the stacked core layer.
- 0790813: Retrieval-scope policy wiring (issue #47, layer 3 of 3 — closes the stack). The MCP transport resolves the user's policy at most once per request (a memoized thunk over core `resolveRetrievalPolicy`, paid only by the read tools) and injects it into search/briefing/handoff; `configure_scope` gains the `set_retrieval_default` action (write-scoped; a `default` scope must exist in the registry — typed not_found otherwise) and `describe_environment` reports `retrievalScopePolicy`. Results echo `appliedScope` exactly when the policy narrowed an unscoped call (schema successors: `searchToolOutputV3Schema`, `briefingToolOutputV4Schema`, `handoffToolOutputV4Schema`, `searchRestResponseV2Schema`, `dashboardSearchResponseV2Schema` — shipped schemas byte-identical); an unscoped read under mode `require` maps to a typed invalid_input naming the registered scopes (MCP isError; REST 400 with the recovery in `detail`). REST parity: `/api/v1/search`, `/api/v1/dashboard/search`, and `/api/v1/briefing` ride the same injected policy. The SDK and CLI preserve recovery detail, and human CLI search output reports a policy-applied scope. Docs, OpenAPI, the MCP reference, and the transport-cost fixture are regenerated in lockstep (frozen totals updated); the golden-set eval gate holds at floors.
- a364654: Add the `scope_project` orientation selector variant (issue #46): `{kind:'scope_project', scope, project, includeUnscoped}` selects the scope AND project intersection the shipped union could not express, with `includeUnscoped` (default false) as the opt-in NULL-project mitigation — `scope = $s AND (project = $p OR ($includeUnscoped AND project IS NULL))` in the single `memoryScopePredicate` all six briefing sections and handoff inherit. The V2 selector union (`briefingSelectorV2Schema`, packages/schema/src/briefing-bounds.ts) is composed from the shipped variant objects, so the three shipped variants stay byte-identical and the bare `project` variant is NOT widened. Core `requireSelector` validates the new variant; the published `BriefingSelector` type carries it with a required `includeUnscoped`.
- 2ecf3ab: Wire the `scope_project` selector onto the orientation transports (issue #46, layer 2 of 2): `briefing` and `handoff` register the V3 tool IO (`briefingToolInputV3Schema`/`handoffToolInputV3Schema` + matching outputs). Each V3 schema is rebuilt from its shipped base with `.extend(...)`, widening only the selector while reapplying the shared V2 fields and refinements (duplicate-section rejection and hasMore/counts identities), so every V2-valid payload parses identically. The REST `GET /api/v1/briefing` route accepts `kind=scope_project&scope=…&project=…&includeUnscoped=true|false` (only the literal strings coerce; anything else is a schema 400). Tool descriptions document the NULL-project semantics: a memory written without a project never appears through the bare `project` lens — `scope_project` with `includeUnscoped: true` is the explicit opt-in, and the bare variant is never widened. `docs/reference/tools.mdx`, the OpenAPI spec, and the transport-cost fixture + frozen totals are regenerated in lockstep.
- 351aee0: Search cursor pagination + compact projection contracts (issue #49, layer 1 of 2): new composed `searchQueryV3Schema` in `@3ngram/schema` (own bounded module `search-cursor.ts`) adds `cursor` (opaque frozen-ordering continuation token) and `projection` (`full` default / `compact`, which omits the per-hit `content`/`contentLength`/`truncated` triple) onto the shipped `searchQueryV2Schema`; new `searchToolOutputV2Schema` adds `hasMore` + `nextCursor` with enforced consistency (`count === hits.length`; `nextCursor` present iff `hasMore`). The shipped V1/V2 schemas are untouched. The base64url cursor codec moves from `apps/server/src/rest/cursor.ts` to the shared `apps/server/src/cursor.ts` so the MCP search tool (layer 2) can reuse it. No ranking changes; the frozen-ordering core path (`searchDashboardPage`) is reused as-is.

  Review hardening: `searchToolOutputV2Schema` additionally enforces one projection per page (a mixed full/compact `hits` array is rejected), and continuation cursors are now BOUND to the search that issued them — the cursor payload gains an optional `fp` fingerprint (truncated sha256 of the normalized query + filter set) that issuance populates and continuation verifies, rejecting a cursor replayed under a changed query/filters with a typed 400 (`CursorQueryMismatchError`) instead of silently re-paging the old frozen ordering. `fp` is optional with verify-when-present semantics: fingerprint-less cursors minted before this change stay valid.

- 8598b09: Filters V2 parity on the REST memories list (issue #48, layer 2 of 2): `GET /api/v1/memories` accepts `memoryTypes` (repeatable query param — string once, array when repeated, the same handling as `project`; mutually exclusive with the scalar `type`) and `recordedAfter`/`recordedBefore` (inclusive ISO recorded_at range bounds). The db `listConditions` narrows via `eq`/`inArray` and `gte`/`lte` on top of the ever-present live gate — the range narrows the live view, never widens it. OpenAPI spec regenerated from the schema.
- 1471fcb: Search filters V2 (issue #48, layer 1 of 2): the MCP `search` tool accepts two new candidate-narrowing filter axes — `memoryTypes` (an OR-set of memory types, 1–8 entries, mutually exclusive with the scalar `memoryType`) and `recordedAfter`/`recordedBefore` (an inclusive transaction-time range on `recorded_at` that narrows the live view WITHOUT lifting the active-only default — unlike `asOf`, it is not time travel). New composed `searchFiltersV2Schema`/`searchQueryV2Schema` in `@3ngram/schema` (the shipped V1 schemas are untouched); the db `rowEligibility` predicate gains `memory_type = ANY(...)` and `recorded_at >=/<=` branches spliced identically into every fusion leg (leg parity preserved); core threads the filters through unchanged. Fusion weights and ranking are untouched — filters narrow candidates pre-fusion only.

### Patch Changes

- 1663683: Recorded-range hardening (issue #58): the recordedAfter/recordedBefore pair is now validated by one shared rule set (`recordedRangeIssues` in `packages/schema/src/recorded-range.ts`) applied by BOTH transports — the MCP search schema (searchQueryV2Schema, carried into V3) and the REST `GET /api/v1/memories` query schema. The REST list now rejects an inverted range as a 400 (parity with MCP — previously an empty 200), and both surfaces reject a bound with more than 3 fractional-second digits instead of silently truncating it to JS millisecond precision (Postgres stores `recorded_at` at microsecond precision, so a truncated bound could leak a boundary row past an inclusive bound). `searchFingerprint` now hashes the post-parse query text verbatim — both transport query schemas trim at parse, so the fingerprint hashes exactly the text core embeds (no behavior change for schema-parsed callers).

## 0.5.0

### Minor Changes

- d5080cd: Add validated, SSRF-safe OAuth Client ID Metadata Document resolution and bounded HTTP caching.
- b88a6fa: Support Client ID Metadata Documents across OAuth discovery, authorization, token exchange, and grant management while retaining dynamic registration fallback.

## 0.4.1

### Patch Changes

- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.
- b956a15: Add billing-neutral, optional live-memory and active-MCP-client limit primitives
  with exact transactional enforcement, explicit transport errors, and an exported
  server compatibility sentinel. Omitted limits remain unlimited for self-hosting.

## 0.4.0

### Minor Changes

- fb2487a: Reshape into a clean, self-hostable OSS core. Remove the billing/subscription surface and replace the `CloudExtension` seam with a neutral `Extension` seam (`resolveLimits` / `AccessGate` / `onAccountDeletion` / export enricher), all with no-op self-host defaults. Keep the budget cost-cap as a self-host feature. Consolidate docs into a single Mintlify tree and make CI fork-friendly (pgvector service container instead of hosted branches).

## 0.3.0

Initial public release.
