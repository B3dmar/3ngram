# Research backing the MCP 2026-07-28 compliance plan

Companion to [PLAN.md](PLAN.md). Everything here was verified against the published spec and the pinned SDK
on 2026-08-05; nothing is quoted from memory.

## Spec sources

| Topic | URL |
|---|---|
| Release announcement | https://blog.modelcontextprotocol.io/posts/2026-07-28/ |
| Caching | https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching |
| Tools | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| Streamable HTTP | https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http |
| Base protocol / `_meta` | https://modelcontextprotocol.io/specification/2026-07-28/basic/index |
| Versioning & compatibility | https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning |
| Discovery | https://modelcontextprotocol.io/specification/2026-07-28/server/discover |
| Completion | https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/completion |

## The caching model, in the form the plan relies on

Servers **MUST** include caching hints on `resultType: "complete"` results of exactly six operations:
`server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`,
`resources/read`. Interim `input_required` results are not cacheable and carry no hints.

Two fields, both on the result body (not HTTP headers):

- **`ttlMs`** — integer milliseconds, semantics of `Cache-Control: max-age`. `0` ⇒ immediately stale.
  **Absent ⇒ clients assume `0`.** Negative ⇒ treat as `0`. Servers MUST provide `>= 0`.
  It is a freshness hint, not a guarantee: the server may change the data before it expires.
- **`cacheScope`** — `"public"` or `"private"`.
  - `public`: no user-specific data; any client, shared gateway, or caching proxy may serve it to **any**
    user. The spec spells out that a `public` result from an *authenticated* endpoint may cross
    authorization contexts — different access tokens can hit the same cache entry.
  - `private`: reusable only within the same authorization context; caches MUST NOT be shared across tokens.

Points that shape the plan:

1. **Cache key** = method + result-affecting params, *including* `cursor`. Each page of a paginated list is
   independently cacheable with its own TTL clock, but `cacheScope` MUST be identical across all pages of one
   list request.
2. **MRTR results are never cacheable** — anything carrying `inputResponses` or `requestState` depends on
   inputs outside the cache key. (Constrains item 8.)
3. **TTL is not a poll interval.** Clients check freshness on access; if they poll anyway they MUST jitter
   and back off. Clients MAY re-fetch early when a call fails in a way that suggests staleness
   (method-not-found, invalid params) — this is what bounds the catalog-staleness risk in item 6.
4. **Notifications complement TTL.** A relevant `*_list_changed` notification invalidates a still-fresh
   cache entry immediately. A server MAY provide `ttlMs` with no `listChanged` at all — which is exactly
   3ngram's current posture, and it is legal.
5. **`cacheScope` is not access control.** The spec requires per-primitive authorization regardless, and
   3ngram already satisfies this by gating at `tools/call` rather than at `tools/list`.

Deterministic ordering of list results is a **SHOULD**, justified in the spec by upstream *LLM prompt cache*
hit rates, not just MCP round-trips. 3ngram's catalogs are built from a static registry array, so ordering is
already deterministic; `apps/server/src/mcp/tools.ts:377` shows the ordering is treated as deliberate.

## SDK evidence

Pinned versions (`apps/server/package.json`): `@modelcontextprotocol/node`, `@modelcontextprotocol/server`,
`@modelcontextprotocol/server-legacy`, `@modelcontextprotocol/client` — all `2.0.0`.

Paths below are inside
`node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist/`.
**The bundle filenames carry content hashes and will change on any SDK upgrade** — re-grep by symbol name,
not by path, when revisiting.

### `server/discover` gets no default cache hint (item 1)

`createMcpHandler-CLhGwQTn.d.mts:2656`:

```ts
declare const CACHEABLE_RESULT_METHODS: readonly [
  "tools/list", "prompts/list", "resources/list",
  "resources/templates/list", "resources/read", "server/discover"
];
```

The accompanying comment states the list is closed: "no other operation's result ever receives cache fields
from the SDK." So `server/discover` *can* take a hint.

`mcp-DXXb3Vv3.mjs:727-729` — hints are stored only when supplied, with no fallback:

```js
if (options?.cacheHints !== void 0) { … this._cacheHints = options.cacheHints; }
```

`mcp-DXXb3Vv3.mjs:818-824` — when the hint is absent the handler is wrapped in a passthrough that attaches
nothing:

```js
const cacheHint = this._cacheHints?.[method];
if (cacheHint === void 0 && !isInputRequiredCapable) return async (request, ctx) => { … return result; };
```

`mcp-DXXb3Vv3.mjs:733` confirms the discover handler is registered whenever any modern protocol version is
supported, so the endpoint is live and answering — just without hints.

**Conclusion:** the omission is ours, not the SDK's, and the fix is purely additive.

### `instructions` is a supported option (item 3)

`createMcpHandler-CLhGwQTn.d.mts:2777` declares `instructions?: string` on the server options;
`mcp-DXXb3Vv3.mjs:694` shows `_instructions` on the class. `apps/server/src/mcp/server.ts:37` passes an
options object already, so this is a one-key addition.

Spec side: `DiscoverResult.instructions` is "optional natural-language guidance for LLMs on how to use this
server effectively."

### Origin validation is deliberately absent from the SDK (item 2)

`createMcpHandler-CLhGwQTn.d.mts` (~:4006), in the `createMcpHandler` doc comment:

> When mounting bare on a fetch-native runtime, put Origin/Host validation in front of the handler — the
> entry itself is deliberately validation-free

It names the exported helpers `hostHeaderValidationResponse`, `originValidationResponse`,
`localhostAllowedHostnames`, `localhostAllowedOrigins`. They take a web `Request`; this deployment reaches
the handler via `toNodeHandler` + Express, hence the adapt-or-hand-roll question in the plan.

Spec side: "Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS
rebinding attacks. If the `Origin` header is present and invalid, servers **MUST** respond with HTTP 403
Forbidden." Note the conditional — **present** and invalid. Absence is not a violation, which is what makes
the allow-on-absent rule in the plan safe for non-browser clients.

Verified absent in this repo:

```sh
rg -n "cors|Origin|helmet" apps/server/src --glob '*.ts' -i   # only unrelated URL-origin string handling
```

### Tool annotations and icons are supported (item 4)

`createMcpHandler-CLhGwQTn.d.mts:3305-3316`, `:3475-3476`, `:3491-3492` — `registerTool` config accepts
`annotations?: ToolAnnotations` and `icons?: Icon[]`; `ToolAnnotations` is declared at `:2589`.

Spec side: clients **MUST** treat tool annotations as untrusted unless the server is trusted — which is a
statement about *client* obligations, not a reason for a server to omit them.

### Completion still exists in this revision (item 5)

The 2026-07-28 completion page is live and not deprecated. Capability declaration is
`"capabilities": { "completions": {} }`; the method is `completion/complete` with `ref/prompt` or
`ref/resource`; results cap at 100 values with optional `total` and `hasMore`. The security section requires
input validation, rate limiting, and explicitly warns against completion-based information disclosure.

## Repo facts the plan depends on

| Claim | Evidence |
|---|---|
| Cache hints cover only two methods | `apps/server/src/mcp/server.ts:38-41` |
| Server info carries no instructions | `apps/server/src/mcp/server.ts:15` |
| Tool config has no annotations slot | `apps/server/src/mcp/tools.ts:84-89` |
| Read/write split already modelled | `RequiredScope`, `apps/server/src/mcp/tools.ts:78` |
| Header allowlist is incomplete for future methods | `apps/server/src/middleware/mcp-header-observability.ts:13-21` |
| Facets already exist in core, not just REST | `packages/core/src/read/list-memories.ts:58`; route at `apps/server/src/rest/router.ts:290` with an access guard |
| Facets are treated as tenant-sensitive | `apps/server/src/rest/router.ts:292` comment |
| Dual-era behaviour is contract-tested | `apps/server/test/mcp-protocol-versions.test.ts:52-97` |
| `-32020` header/body mismatch is tested adversarially | `apps/server/test/mcp-protocol-versions.test.ts:99-113` |
| Resources deliberately deferred (pre-v2 reasoning) | `docs/concepts/mcp-design.mdx:45` |
| MRTR / Tasks deferred, deprecations cost nothing | `docs/concepts/mcp-design.mdx:75` |

## How to re-verify after an SDK upgrade

```sh
# cacheable methods and whether a default appeared
rg -n 'CACHEABLE_RESULT_METHODS' node_modules/.pnpm/@modelcontextprotocol+server@*/node_modules/@modelcontextprotocol/server/dist
rg -n '_cacheHints' node_modules/.pnpm/@modelcontextprotocol+server@*/node_modules/@modelcontextprotocol/server/dist --glob '*.mjs'

# options surface (instructions, cacheHints, annotations, icons)
rg -n 'instructions\?|cacheHints\?|annotations\?|icons\?' node_modules/.pnpm/@modelcontextprotocol+server@*/node_modules/@modelcontextprotocol/server/dist --glob '*.d.mts'

# whether the handler entry started validating Origin itself
rg -n 'originValidation|hostHeaderValidation' node_modules/.pnpm/@modelcontextprotocol+server@*/node_modules/@modelcontextprotocol/server/dist
```

## Open questions

1. Does `McpClient` in `@modelcontextprotocol/client@2.0.0` expose the raw `DiscoverResult` (needed to assert
   discover cache hints in the existing test harness), or must the test drive `handler.fetch` directly?
2. Is there a deployment reason to keep `MCP_CATALOG_CACHE_TTL_MS` at one hour for discovery specifically?
   Discovery is smaller and changes on the same trigger, so sharing the constant looks right — but if
   `supportedVersions` ever changes independently of the catalog, that assumption breaks.
3. For item 7, does a memory resource address an **id** or a **version**? Supersession and archive both mutate
   what "the current memory" means, which is the difference between a long private TTL and a short one.
4. Should `completion/complete` enforce `MEMORY_READ_SCOPE` as its own floor? `runTool` is the existing
   fail-closed pattern, but completion does not route through it.
