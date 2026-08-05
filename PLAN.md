# MCP 2026-07-28 compliance & follow-through plan

**Branch:** `chore/mcp-v2-compliance` · **Base:** `origin/staging` @ `c38a036` · **Worktree:** `.worktrees/mcp-v2-compliance`

Source of the findings: an audit of `apps/server/src/mcp/*`, `apps/server/src/routes/mcp.ts`, and
`apps/server/src/middleware/mcp-header-observability.ts` against the 2026-07-28 specification and the
pinned `@modelcontextprotocol/*@2.0.0` SDK. Spec citations and SDK evidence live in [RESEARCH.md](RESEARCH.md).

This branch carries **plans only** — no source changes. Each item below is sized to become its own PR
off `staging` so the 200-line guidance in `AGENTS.md` holds.

## What the migration already got right

Recorded here so a later reader does not "fix" something that is deliberate:

- The per-request `McpServer` factory (`apps/server/src/mcp/server.ts:36`, `apps/server/src/routes/mcp.ts:91`)
  satisfies the spec's statelessness requirements structurally rather than by convention.
- One factory serves both eras (`legacy: 'stateless'`), and `apps/server/test/mcp-protocol-versions.test.ts`
  drives legacy / pinned-2026 / auto-negotiation against the real client SDK.
- `cacheScope: 'public'` on the catalogs is correctly argued: the lists are tenant-independent and
  authorization runs at `tools/call`, which is exactly the reasoning the spec's cache security section demands.
- `Mcp-Method` / `Mcp-Name` are treated as untrusted and collapsed to closed allowlists before reaching
  metrics — stronger than the spec requires.
- No Roots / Sampling / Logging dependency, so the twelve-month deprecation window costs nothing.

## Items

### P0 — spec MUSTs

#### 1. `server/discover` returns no cache hints

**Problem.** `cacheHints` is configured for `tools/list` and `prompts/list` only
(`apps/server/src/mcp/server.ts:38-41`). The spec requires cache hints on every cacheable result, and
`server/discover` is on that list. The SDK applies **no default**: when a hint is absent it wraps the
handler in a passthrough that attaches nothing (see RESEARCH.md §SDK evidence). Clients therefore treat
discovery as immediately stale (`ttlMs` absent ⇒ assume `0`) and re-probe on every reconnect.

**Fix.** Add the third entry:

```ts
cacheHints: {
  'server/discover': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
  'tools/list': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
  'prompts/list': { ttlMs: MCP_CATALOG_CACHE_TTL_MS, cacheScope: 'public' },
}
```

`public` is right for the same reason it is right on the catalogs: `DiscoverResult` carries
`supportedVersions`, `capabilities`, and `serverInfo` — no tenant data. Reuse `MCP_CATALOG_CACHE_TTL_MS`;
discovery changes on exactly the same trigger as the catalog (a deployment).

**Files.** `apps/server/src/mcp/server.ts` (+ its doc comment, which currently explains the TTL in terms of
"tool and prompt definitions").

**Tests.** Extend `apps/server/test/mcp-protocol-versions.test.ts`: on the modern era, assert the
`server/discover` result carries `ttlMs` + `cacheScope`; on legacy, assert both are absent. The existing
client-SDK harness in that file already exposes what is needed — check whether `McpClient` surfaces the
discover result directly, otherwise drive `handler.fetch` with a hand-built `server/discover` POST.

**Size.** ~15 lines. **Changeset:** patch (`apps/server`).

#### 2. No `Origin` / `Host` validation on `/mcp`

**Problem.** The Streamable HTTP spec: servers **MUST** validate `Origin` on all incoming connections and
respond `403` when it is present and invalid. There is no CORS or Origin handling anywhere in
`apps/server/src`. The SDK is explicit that its HTTP entry point is "deliberately validation-free" and
expects the host application to mount the check in front.

**Real-world severity is low** — `/mcp` is bearer-only with no cookie or ambient credential, so a DNS
rebinding attacker gains nothing — but it is a MUST, and the fix is one middleware.

**Fix.** An Express middleware mounted on the `/mcp` router *before* `oauthBearerAuth`:

- No `Origin` header ⇒ **allow**. Non-browser clients (Claude Desktop, the CLI, agent runtimes) do not send
  one; rejecting on absence would break every real client.
- `Origin` present ⇒ allow only if it is in a configured allowlist; otherwise `403` with a JSON-RPC error
  body carrying no `id` (the spec permits this shape).
- Allowlist source: the existing `WEB_APP_URL` plus an optional comma-separated env var. Keep the parsing in
  `@3ngram/config` with the other env handling, not in the route.

The SDK ships `originValidationResponse` / `hostHeaderValidationResponse`, but they operate on web
`Request` objects and this deployment reaches the handler through `toNodeHandler` + Express. Decide during
implementation whether to adapt them or hand-roll the header comparison — hand-rolling is ~10 lines and
avoids constructing a throwaway `Request` per call. Consider `Host` validation at the same time; it matters
less behind Railway's proxy but is the same middleware.

**Files.** New `apps/server/src/middleware/mcp-origin.ts`, wired in `apps/server/src/routes/mcp.ts:134`.

**Tests.** New `apps/server/test/mcp-origin.test.ts`: absent Origin ⇒ passes through; allowlisted Origin ⇒
passes; foreign Origin ⇒ 403 and the handler is never invoked. Add one case to the integration test proving
a normal bearer request with no Origin still succeeds — that is the regression that would hurt.

**Size.** ~60 lines with tests. **Changeset:** patch (`apps/server`).

> Ship items 1 and 2 as **one PR** ("mcp: close 2026-07-28 spec gaps"). Both are MUSTs, both are small,
> and reviewing them together makes the compliance story legible.

### P1 — client experience, cheap

#### 3. No `instructions` on the server

**Problem.** `McpServer` accepts `instructions?: string`, and `DiscoverResult.instructions` is the spec's
designated slot for natural-language guidance to the model on how to use the server. `SERVER_INFO`
(`apps/server/src/mcp/server.ts:15`) carries name and version only, so the field is never populated. Today
the only place an agent learns *when* to call `remember` versus `search` versus `briefing` is 11 individual
tool descriptions, which it reads without any cross-tool framing.

For a memory server this is the single highest-leverage unused field in the protocol: the failure mode
"agent has the tools but never writes anything worth keeping" is a usage-policy problem, not a schema problem.

**Fix.** Add a `SERVER_INSTRUCTIONS` constant next to `SERVER_INFO` and pass it in the options object.
Content should cover, in a few sentences: memory is append-only (never edit, use `revise` to supersede);
start a session with `briefing`; search before asserting something is not known; write decisions and
commitments rather than transcript noise; scope/project selection matters for briefing filters.

Keep it short. It is prepended to model context on every client that surfaces it, so it competes with the
tool descriptions for attention. Treat it as a policy statement, not documentation.

**Cross-check.** `docs/concepts/mcp-design.mdx` already states the JTBD framing; the instructions string
should be a compression of that table, and the doc should link to the constant so the two do not drift.

**Files.** `apps/server/src/mcp/server.ts`, `docs/concepts/mcp-design.mdx`.

**Tests.** Assert `server/discover` returns non-empty `instructions` on the modern era. Do **not** assert the
exact text — that turns a copy edit into a failing test.

**Size.** ~30 lines. **Changeset:** patch.

#### 4. No tool `annotations`, no `icons`

**Problem.** `ToolDefinition.config` (`apps/server/src/mcp/tools.ts:84-89`) carries
`title` / `description` / `inputSchema` / `outputSchema`. The SDK's `registerTool` also accepts
`annotations?: ToolAnnotations` and `icons?: Icon[]`. Clients use `readOnlyHint` / `destructiveHint` /
`idempotentHint` / `openWorldHint` to decide whether a call can be auto-approved or needs a confirmation
prompt. Every 3ngram tool currently looks equally dangerous to a client, so read-only calls like `search`
and `get_facts` collect the same friction as `revise`.

**Fix.** The ground truth already exists: `requiredScope` (`apps/server/src/mcp/tools.ts:78`) separates
reads from writes. Add an optional `annotations` field to `ToolDefinition['config']` and populate it:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
|---|---|---|---|
| `search`, `get_facts`, `get_memories`, `briefing`, `handoff`, `describe_environment` | `true` | — | `true` |
| `remember` | `false` | `false` (append-only, never merges) | `false` |
| `revise` | `false` | `false` — see note | depends on action |
| `resolve` | `false` | `false` | `true` (FSM transition to a target state) |
| `configure_scope`, `review_proposals` | `false` | per action | per action |

Note on `revise`: hard rule 1 in `AGENTS.md` is that no write path destroys memory data — supersession is
append-only. `destructiveHint: false` is therefore *accurate*, and saying so is a genuine product claim
worth making visible to clients. Archive is the one path worth a second look during implementation.

`openWorldHint: false` across the board: every tool operates on the tenant's own corpus, not an open
external world. The embedding gateway is an implementation detail, not an open-world interaction.

Do not derive annotations automatically from `requiredScope` — the mapping is not total (per-action tools
span both), and an explicit table is easier to review than a clever inference.

**Icons** are a separate, lower-value follow-up: one server-level icon on `Implementation` for client UI.
Defer unless a client asks; note it in the issue rather than doing it here.

**Files.** `apps/server/src/mcp/tools.ts` (type + the write tools), `tools-search.ts`, `tools-orient.ts`,
`tools-inspect.ts`, `tools-admin.ts`.

**Tests.** Extend `apps/server/test/mcp-tools.test.ts`: every tool declares `annotations`, and every
read-scoped tool declares `readOnlyHint: true`. A registry-wide invariant test is worth more here than
per-tool assertions.

**Size.** ~90 lines. **Changeset:** patch.

> Items 3 and 4 make a natural second PR ("mcp: describe the server to clients").

### P2 — worth doing, needs a little design

#### 5. `completions` capability is not implemented

**Problem.** The prompts take scope/project arguments and the tools accept scope/project filters, but the
server declares no `completions` capability, so a client cannot offer the tenant's actual scope names.
Users type them from memory.

**Why it is cheap here.** `listMemoryFacets` already exists in `packages/core`
(`packages/core/src/read/list-memories.ts:58`, exposed over REST at
`apps/server/src/rest/router.ts:290`) and returns DISTINCT scope + project values for a tenant. The
completion handler is an adapter over a function that is already written, tested, and access-guarded.

**Design constraints, all real:**
- `ref/prompt` is the only reference type that applies today — `ref/resource` needs item 6 first.
- Results are **tenant-private**. The spec's completion security section explicitly calls out
  completion-based information disclosure. The handler must resolve the tenant from the same verified
  `authInfo` path the tools use, never from arguments.
- Completion results carry **no** cache hints in this revision. They must sit behind the existing per-user
  rate limiter, and the spec expects servers to rate-limit completion specifically.
- Cap at 100 values per the spec; `hasMore` when truncated.
- Note the REST route wraps facets in an access guard because scope/project labels are themselves tenant
  data. The MCP path must do the same, not just filter by tenant id.

**Open question for implementation.** Whether completion needs its own OAuth scope floor or inherits the
read scope. Reading facets is a read; `MEMORY_READ_SCOPE` is the defensible default, and it must be enforced
fail-closed like `runTool` does.

**Size.** ~120 lines. Its own PR.

#### 6. Observability allowlist and catalog-staleness note

Two small things that are cheap now and annoying later.

- `KNOWN_METHODS` (`apps/server/src/middleware/mcp-header-observability.ts:13-21`) omits `resources/*`,
  `completion/complete`, and `subscriptions/listen`. Harmless today; the moment item 5 or 6 ships, real
  traffic gets labelled `unknown_method` and the failure is a silently wrong metric rather than an error.
  Add the methods when the corresponding feature lands — but add a comment now saying the set must be
  extended alongside any new served method, because that is the coupling nobody will remember.
- **Catalog staleness has no push invalidation.** With a 1h TTL and no `subscriptions/listen`, a rolling
  deploy that changes a tool schema leaves clients on a stale catalog for up to an hour. This is bounded in
  practice: the spec lets clients re-fetch early when a call returns an unexpected `-32602` / `-32601`, which
  is exactly what a stale schema produces. Long-lived listen streams also fit poorly with the stateless
  deploy model that is the whole point of the current architecture. **Recommendation: do not implement
  subscriptions. Document the tradeoff** in `docs/concepts/mcp-design.mdx` next to the existing TTL rationale,
  so the next reader sees it was a decision rather than an oversight.

**Size.** ~20 lines, mostly prose. Fold into whichever PR lands first.

### P3 — real opportunities, separate design work

These need product decisions, not just protocol work. Open as issues; do not start them from this branch.

#### 7. Resources — the calculus changed with v2

`docs/concepts/mcp-design.mdx:45` defers resources until a client demonstrably uses them. That was correct
under v1. Under 2026-07-28, `resources/read` is **cacheable** with `ttlMs` + `cacheScope: "private"`, and
3ngram's memories are append-only and effectively immutable once written. That is close to an ideal
cacheable resource, and it is the strongest new capability the migration unlocked.

Sketch: a `3ngram://memory/{id}` resource template plus `resources/templates/list`, letting a client cache
full memory bodies with a long private TTL instead of re-calling `get_memories` for every `truncated: true`
search hit. `cacheScope: "private"` is mandatory — the content is tenant data, and `public` would let a
cache serve it across access tokens.

Two arguments in favour beyond caching: it does **not** consume a slot against the 12-tool ceiling
(`AGENTS.md` hard rule 8), and it gives `ref/resource` completion a target (item 5).

Open questions: immutability is not absolute — `revise` supersedes and archive changes status, so the TTL
must be short enough that a superseded memory does not stay "current" in a client cache, or the resource
must represent the *version* rather than the *id*. That is the design question worth writing up first.

#### 8. MRTR for confirmations

`review_proposals` (accept/reject) and `revise`'s archive path are textbook `input_required` elicitation
candidates: a human-in-the-loop confirmation carried by the protocol instead of by tool-description prose.
The SDK's legacy shim serves `input_required` on **both** eras, so this is a one-sided change — no client
matrix to manage. `docs/concepts/mcp-design.mdx:75` already flags it as deferred; the note there is accurate
and should stay until the product decision is made.

Caution: MRTR results are **not cacheable**, and the retry carries `requestState` that the server must verify
(the SDK exposes a `requestState.verify` hook). Treat `requestState` as attacker-controlled.

#### 9. Tasks extension for long-running work

Imports, consolidation, and repair jobs already run on BullMQ. In 2026-07-28 these map onto
`io.modelcontextprotocol/tasks`, which moved **out of experimental core into an extension** advertised via
`capabilities.extensions` with poll-based operations — a good fit for a stateless HTTP server, since polling
needs no held-open stream. The work is persistence and product design, not protocol plumbing.

## Sequencing

| PR | Items | Est. lines | Gate |
|---|---|---|---|
| 1 | 1 + 2 — spec MUSTs | ~75 | changeset (patch), protocol contract tests |
| 2 | 3 + 4 — instructions + annotations | ~120 | changeset (patch), registry invariant test |
| 3 | 6 — observability note + staleness doc | ~20 | empty changeset if docs-only |
| 4 | 5 — completions | ~120 | changeset, rate-limit + access-guard tests |
| — | 7, 8, 9 | — | issues; design docs before code |

Per `AGENTS.md`: branch `chore/*` → PR to `staging`; a PR touching `apps/*` needs a changeset; the blocking
golden-set eval must not regress (none of these items touch retrieval, so that gate should be a formality —
verify, do not assume).

## Working alongside the parallel session

A second session holds the primary checkout (`chore/enable-registry-cooldown`) and a separate worktree
(`.worktrees/mcp-2026-compat`, branch `docs/mcp-2026-rollout`). Neither was touched by this work. Any
implementation PR from this plan should be built in its own worktree off fresh `origin/staging` rather than
in the shared checkout.
