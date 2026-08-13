# @3ngram/server

## 1.4.3

### Patch Changes

- 8d36bfe: Pick up the patched `@hono/node-server` (1.19.14 → 1.19.17) for GHSA-frvp-7c67-39w9.

  The advisory is a `serve-static` path traversal reachable on Windows through an encoded backslash. `@hono/node-server` is not a declared dependency of this package — it arrives transitively as a regular dependency of `@modelcontextprotocol/node`, which the MCP HTTP transport relies on — so the fix lands as a scoped root override (`@hono/node-server@<1.19.15: ^1.19.15`) rather than a manifest bump. The workspace lockfile is what pins it, and the published `ghcr.io/b3dmar/3ngram` image builds from that lockfile, so the image carries the patched version from this release forward. The resolution is 1.19.17 rather than the advisory's 1.19.15 because 1.19.16 was never published.

  No source in this package changed, and no runtime behaviour moves with it. Consumers who resolve their own dependency graph rather than running the published image should confirm their own `@hono/node-server` resolves to >= 1.19.15 — an override or a lockfile refresh, since the vulnerable version is reached transitively there too.

## 1.4.2

### Patch Changes

- 851fa53: Tool output schemas now advertise open (`additionalProperties: true`) while the server keeps parsing them strict.

  **A cached catalog no longer breaks on an additive response field.** Every tool output object was `.strict()`, which Zod 4 emits as `additionalProperties: false` in the JSON Schema `tools/list` advertises. Clients cache that catalog for an hour, so ANY release that added a response field hard-failed every validating client for the whole TTL window — and nothing prompted an early re-fetch, because the failure is client-side _output_ validation rather than a `-32601`/`-32602` the client reads as staleness. That is the observed v1.4.1 incident: a session holding the v1.3.0 catalog called `get_facts` and died on `data/facts/0 must NOT have additional properties`, on a nested item object, from a purely additive field. Every object node reachable in all eleven tool output trees now carries `.meta({ additionalProperties: true })` — root envelopes, array item objects, union members, and section wrappers alike, since the incident failed at depth.

  **The runtime contract is unchanged.** `.meta()` moves metadata only: the objects stay `.strict()`, so the server still rejects an unknown key in a result it produced itself, and the search envelope's projection-homogeneity refinement still relies on its hit members being strict. `.loose()`/`.passthrough()` would have moved the runtime contract and were deliberately not used. The strictness suites in `packages/schema` pass unchanged.

  **Inputs stay closed, and the asymmetry is now locked by a test.** An unknown argument key remains a loud rejection — a silently dropped `scope` filter reads as a scope leak — so no input schema's advertisement moved a byte. The briefing/handoff `selector` union is the one object reachable from BOTH an input and an output tree (it is an argument AND an echo); the openness rides an output-side derivation, leaving the input union untouched. A registry invariant test walks every tool's emitted output schema asserting no `additionalProperties: false` at any depth, and asserts every input root still carries it.

  **The OpenAPI response schemas open up too — deliberately.** The generator reuses the same output schemas for REST responses, so `POST /api/v1/memories`, `POST /api/v1/search`, `GET /api/v1/facts`, `GET /api/v1/briefing`, and the revise/resolve responses now publish `additionalProperties: true`. The rationale is the same one: a REST reader compiled against an older spec should not break on a field that was only added. Request bodies and query schemas are untouched.

- 1ebd82c: Remove the self-imposed MCP surface caps; a gated eval replaces them.

  **`MAX_TOOLS = 12` and `MAX_PROMPTS = 2` are gone.** Both were 3ngram's own discipline, entered at the `v1.0.0` launch commit and sourced to nothing upstream — the specification defines no maximum tool count and paginates `tools/list`, and the pinned SDK enforces no limit. Neither constant was ever exported past its module and neither appears in the public API report, so there is no runtime or API change for any client: the server still registers exactly 11 tools and 2 prompts, with the same names, schemas, and annotations.

  **What replaced them is a measurement of the thing they proxied for.** The `tool-selection` eval slice moved from report-only to gated: `selection_accuracy_at_1` (0.8545) and `selection_margin` (0.1097) are recorded as floors, and `max_description_overlap` (0.6737, `briefing` ~ `handoff`) as a ceiling — a metric where lower is better, so `eval/fixtures/floors.json` gained a `ceilings` block with its own comparison rather than storing an inverted floor. A twelfth tool is no longer blocked; a twelfth tool whose description reads like an existing one now fails a required check, and the failure names the offending pair. This is the sequencing `docs/concepts/mcp-surface.mdx` prescribed — re-set the cap last, and record the reasoning as description overlap and selection accuracy rather than a number inherited from launch day — except that nothing was re-set to a new number, because a fresh figure with no measurement under it would have reproduced the original mistake higher up.

  `@3ngram/core` is included for a comment-only change: `write/archive.ts` justified its REST-only surface by citing hard rule 8 without its reason, which no longer reads correctly now that the rule is an evidence test rather than a count. No behavior changed in core.

  **The docs generator no longer arbitrates the surface.** `generate-mcp-reference.ts` threw above both ceilings, which put the argument in the one place that cannot measure either metric; the generated `docs/reference/tools.mdx` and `prompts.mdx` now cite the eval instead. `AGENTS.md` hard rule 8 became an evidence test (JTBD, regenerated surface snapshot, eval scenarios) with its enforcement named, alongside every other hard rule.

- Updated dependencies [851fa53]
- Updated dependencies [1ebd82c]
  - @3ngram/schema@0.7.2
  - @3ngram/core@0.9.2

## 1.4.1

### Patch Changes

- 483c658: Five correctness fixes to the facts, portability, and retrieval surfaces.

  **`fact_proposals` is now erased on account deletion.** Account deletion tombstones the `users` row rather than deleting it, so the FK's `ON DELETE CASCADE` never fires — a staged fact proposal kept its `subject`, `predicate`, `value`, and `rationale` through an Article 17 erasure. It is now redacted in place in the same transaction as `facts` and `consolidation_proposals` (redact-in-place, not DELETE: the runtime role has no DELETE grant on memory-domain tables). The erasure receipt gains a `factProposals` count on `DELETE /api/v1/account` and in the audit tombstone.

  **`fact_proposals` is now included in the portability export.** `GET /api/v1/export` carried `facts` and `consolidation_proposals` but not the staged proposals, which are user content that is not yet a `facts` row. The archive gains a `factProposals` section (and a matching `counts.factProposals`), read under the same repeatable-read snapshot as every other section.

  **Chronological search now rejects a `query` instead of silently ignoring it.** `order: 'chronological'` is an unranked enumeration and the core path takes no query argument, so a caller passing `{order: 'chronological', query}` was returned the whole live corpus as though it had been searched. A present `query` is now a validation error naming `order: 'relevance'` as the ranked alternative. Because `query` no longer bounds the scan, chronological order now REQUIRES at least one filter (previously "query or >=1 filter").

  **Fact write timestamps no longer truncate to milliseconds.** `validFrom`/`validTo` on a written fact accepted arbitrary fractional-second precision, but core converts them with `new Date()` (millisecond) on the way to microsecond-precision Postgres columns — a finer instant silently moved the boundary of a bi-temporal window. Both bounds are now capped at 3 fractional-second digits and REJECTED beyond it, matching the facts-range read bounds, with the limit advertised in the field descriptions.

  **Imported `updates` edges no longer mark live memories superseded.** The `superseded` flag and its ranking tier-penalty counted any incoming `supersedes`/`updates` edge, but the import contract forbids `closePredecessorAt` on an `updates` edge — so every imported `updates`-edge target stayed live (`valid_to IS NULL`) yet read `superseded: true` and was demoted in ranking. The predicate now requires BOTH a revision edge AND closed validity, the same definition `memory_history`'s `lifecycleState` applies, so search and history can no longer disagree about the same row. Genuine revisions are unaffected: the revise path closes `valid_to` for both edge kinds.

- Updated dependencies [483c658]
  - @3ngram/core@0.9.1
  - @3ngram/schema@0.7.1

## 1.4.0

### Minor Changes

- c6a819c: `get_facts` gains a `range: {from?, to?}` window for chronological time-series reads over the bi-temporal facts table, on both the MCP tool and REST `GET /api/v1/facts`.

  `range` replaces (never appends to) the default live-only predicate with a half-open `[from, to)` valid-time overlap: a fact whose validity window overlaps the requested range is returned, including generations superseded inside it — the point of a time-series read over "what's currently true." Ordering flips to `valid_from ASC` (chronological) instead of the default `recorded_at DESC` (recency); `range` and `asOf` are mutually exclusive point-in-time vs. window modes, enforced at the schema boundary (empty range object rejected, mirroring `asOfSchema`; an inverted `from`/`to` range rejected rather than silently returning empty, per issue #58's REST/MCP parity precedent). Each bound is also capped at millisecond precision (issue #58 item 2's fix, applied here too): `valid_from`/`valid_to` are microsecond-precise in Postgres, so a sub-millisecond bound would silently truncate up to the next whole millisecond and let an already-ended generation leak into the window. The existing `DEFAULT_FACTS_LIMIT`/`MAX_FACTS_LIMIT` bounds still apply in range mode.

  Every returned fact now also carries `recordedAt` (transaction time) — an additive, output-only widening useful for telling apart same-window generations recorded at different instants.

  Deliberately out of scope: a `valid_from` index (the sort is accepted at current volumes) and a scope axis on `get_facts` (the facts table has no scope column — continuing issue #47's open item). The SDK `getFacts` client and the CLI `facts` command do not yet expose the `from`/`to` range axis (REST/MCP only for now); follow-up planned.

- 88ee7d4: mcp/rest: expose structured facts on remember

  `remember` now accepts the measurable claims a memory states, on both
  transports. Pass `facts` as subject/predicate/value triples and the response
  returns a `factIds` array; `get_facts` can then read those claims back directly
  instead of re-parsing prose.

  Fact values are text, so the unit belongs in the predicate and each fact holds
  one measure — subject `lift.back_squat`, predicate `top_set.weight_kg`, value
  `98`, not a predicate `top_set` carrying `98kg x 3`. A later range read is only
  comparable across entries if every writer follows that convention, so it is
  stated in the tool description, the server instructions, and the data model doc.

  Validity instants are ISO-8601 strings: an MCP server publishes its input schema
  as JSON Schema, which has no date type. A `validTo` requires a `validFrom`, and
  at most 16 facts ride one write.

  `factIds` is present only when facts were written, so every existing response is
  byte-identical and the V1 output schema still parses it. The V2 contracts are
  composed beside the shipped ones rather than replacing them.

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

- Updated dependencies [c6a819c]
- Updated dependencies [88ee7d4]
- Updated dependencies [4ed7e25]
- Updated dependencies [4cd03d4]
- Updated dependencies [1d9a420]
- Updated dependencies [318025a]
  - @3ngram/schema@0.7.0
  - @3ngram/core@0.9.0

## 1.3.0

### Minor Changes

- 0484afe: mcp: complete scope names from the tenant's own facets

  The server now declares the `completions` capability and answers
  `completion/complete` for the `debrief` prompt's `scope` argument, offering the
  tenant's real scope names filtered by what has been typed. Previously a client
  had no way to discover them, so users typed scopes from memory and a typo
  silently matched nothing.

  It is an adapter over the existing `listMemoryFacets`, with the same guards the
  REST facets route carries: the tenant comes from verified auth rather than the
  request, `memory:read` is enforced fail-closed, and the access gate runs before
  the read. A caller that may not read completes to an empty list rather than an
  error.

- a8408b8: mcp: serve memory bodies as a cacheable resource

  Adds `threengram://memory/{id}` — `resources/templates/list` plus
  `resources/read` — so a client that pulled a `truncated: true` search hit can
  cache the full body instead of re-calling `get_memories` every session.
  `resources/read` is cacheable on protocol revision 2026-07-28, which is what
  makes this worth serving; resources also consume no slot against the 12-tool cap.

  The body carries only fields that never change after write (content, topic,
  type, scope, project, recordedAt) and deliberately omits lifecycle state
  (status, validity, commitment status, tags), which is what allows a 24-hour
  `cacheScope: private` TTL without ever serving a stale answer. Reads enforce the
  same tenant, read-scope, and access guards as the read tools, and an id
  belonging to another tenant is indistinguishable from one that does not exist.

  `resources/list` returns nothing by design — enumerating a tenant's corpus is
  the firehose the no-firehose rule exists to prevent.

### Patch Changes

- fd79244: mcp: describe the server to clients

  The server now advertises `instructions` on `server/discover` — a short usage
  policy telling the model to open with `briefing`, to search before asserting
  something is unknown, that memory is append-only (use `revise`, never rewrite),
  and that scope/project decide what later reads return. Previously the only
  guidance an agent received was 11 individual tool descriptions with no
  cross-tool framing.

  Every tool now declares annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`), so a client can auto-approve a read like
  `search` instead of prompting for it the same way it prompts for a write.
  `destructiveHint` is `false` on every memory write, which is accurate:
  supersession is append-only and never destroys memory data.

- 139473c: mcp: close two 2026-07-28 specification MUSTs

  `server/discover` now advertises the same one-hour `cacheScope: 'public'` hint the
  tool and prompt catalogs carry. It previously fell through to the SDK's defaults
  (`ttlMs: 0`, `cacheScope: 'private'`), so clients treated discovery as immediately
  stale and re-probed on every reconnect.

  `/mcp` now validates the `Origin` header. A request with no `Origin` is allowed —
  non-browser clients do not send one — and a present `Origin` must appear in the
  allowlist (`WEB_APP_URL` plus the new optional `MCP_ALLOWED_ORIGINS`) or the request
  is refused with `403` before authentication runs. With neither variable configured
  the allowlist is empty, so any browser origin is rejected; non-browser clients are
  unaffected.

- 43a200c: Add `GET /api/v1/version`, returning the running server's package version, so deploy tooling can tell a finished rollout from one still in flight.

  Nothing previously exposed build identity over HTTP: `/health` reports liveness and `/ready` reports readiness, but neither says _which build_ answered. A post-deploy probe therefore could not distinguish a completed rollout from an in-flight one, and would happily verify the **previous** build while reporting success — a green light for code that was never exercised.

  **Authenticated, like every `/api/v1` route.** It sits behind `apiOrSessionAuth`, so the exact version is never disclosed on an unauthenticated surface; this matches `/ready`, which logs RLS violations server-side but deliberately keeps catalog and role detail out of its HTTP response. Deploy tooling authenticates anyway.

  **Deliberately ungated.** The response is the server's own build identity — not memory, not memory-derived, not tenant data — so no access gate applies. Staying ungated also keeps it orthogonal to the `AccessGate`: a deploy probe must remain answerable when the gate itself is broken, which is exactly the incident in which an operator most needs to know what is running.

  The value comes from the existing `SERVER_VERSION` (read from `apps/server/package.json` at runtime), so it cannot skew from the published package version at a release; a test asserts that against `package.json` directly rather than against the constant.

  Adds `versionResponseSchema` / `VersionResponse` to `@3ngram/schema` and the corresponding `getVersion` operation to the generated OpenAPI document.

- Updated dependencies [139473c]
- Updated dependencies [43a200c]
  - @3ngram/config@0.2.6
  - @3ngram/schema@0.6.4
  - @3ngram/core@0.8.6

## 1.2.7

### Patch Changes

- 61d9394: Correct the `remember` tool description, which had gone stale after the combined selector shipped (issue #71). It asserted flatly that "a memory written with a NULL project never matches a project filter", which stopped being true once the `scope_project` selector gained `includeUnscoped: true` — `briefing` and `handoff` were updated at the time; `remember` was missed, so the write surface was telling agents the opposite of what the read surface does.

  The description now distinguishes the two cases precisely: the bare `project` selector is still never widened, and only `scope_project` with `includeUnscoped: true` opts NULL-project memories back in. It also drops a dangling `(issue #244)` citation, which referenced an internal tracker item that means nothing to a reader of the public tool surface.

  Tool descriptions are standing context on every MCP connection, so the regenerated surfaces (`docs/reference/tools.mdx`, `eval/fixtures/transport-surfaces.json`) and the recorded transport-cost floors move with it: +13 surface tokens, +104 per-task uncached, +26 per-task cache-effective.

- Updated dependencies [1263111]
  - @3ngram/core@0.8.5

## 1.2.6

### Patch Changes

- Keep `engines.node` at `>=22`. The Node 24 work should only have moved what we build, test and ship on — CI and the container base — not what consumers must run. Nothing in this closure uses a Node 24 feature, and Node 22 is supported upstream until 2027-04-30, so raising the published floor would have hard-failed Node 22 consumers on a patch release. Raising it becomes a deliberate major when there is a reason.
- Updated dependencies
  - @3ngram/core@0.8.4
  - @3ngram/schema@0.6.3
  - @3ngram/config@0.2.5
  - @3ngram/llm@0.2.4

## 1.2.5

### Patch Changes

- a3ac379: Declare `hono` explicitly at 4.12.34 and raise the `hono`/`postcss` advisory overrides. `hono` reaches this package as an optional peer of `@modelcontextprotocol/node`, which pnpm auto-installs and which pnpm overrides cannot reach — the server genuinely needs it at runtime for the MCP HTTP transport, so it is now a declared dependency rather than an implicit one.
- 6e06cd6: Build, test and ship on Node 24 (Active LTS). CI, the release workflow and the server image base move to Node 24 — `node:24-bookworm-slim`, digest-pinned. `engines.node` deliberately stays `>=22`: nothing here requires a Node 24 feature, so consumers on Node 22 (supported until 2027-04-30) remain supported.
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
