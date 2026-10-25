# @3ngram/sdk

## 1.9.1

### Patch Changes

- 48b8972: Security: zod 4.6.6 (CVE-2023-54404, denial of service via unbounded array validation) on every package that pins it, and body-parser 2.4.0 under express (CVE-2026-111181, denial of service via an unhandled decompression stream error) through the workspace advisory override. The v1.9.0 release image scan blocked publication on both. body-parser 2.4.0 is newer than the 7-day registry cooldown, so it is a reviewed exact-version `minimumReleaseAgeExclude` entry until it matures. No API or behaviour change.
- Updated dependencies [48b8972]
  - @3ngram/schema@0.12.1

## 1.9.0

### Minor Changes

- 3222da4: Native `remember` can now record a commitment's deadline and owner (issue #165). A `commitment` write over MCP, REST (`POST /api/v1/memories`), the SDK or the CLI (`--due`, `--owner`) accepts an optional explicit `dueAt` (ISO-8601 instant, at most millisecond precision) and `owner`. Both are written onto the auto-created commitment row in the same transaction, so briefing reports the commitment overdue once the deadline passes and the surfacing sweep expires it after the grace window, exactly as for imported commitments. Either field on a non-commitment is rejected rather than dropped, and nothing is inferred from the content: an undated commitment stays undated. A `revise` keeps the deadline, owner and commitment identity with the successor. No migration; the columns already existed.
- de8ad09: `resolve` accepts an optional `reason` (issue #234) on MCP, `POST /api/v1/memories/:id/resolve` and the SDK (`client.resolve(id, status, { reason })`), so whoever settles a commitment can say what settled it — a PR number, "superseded by X" — in the same call. The reason is trimmed and must be 1–500 characters; an empty or longer one is rejected as invalid input before anything is written. It is stored on the commitment row (new nullable column `commitments.last_resolution_reason`, migration 0040, with a length CHECK generated from the schema bound) in the same transaction as the status change, never in the append-only audit event payload, which keeps carrying only `sessionRunId`. A reason explains one transition: any later status change without one clears it (including the surfacing sweep's expiry and a revise that demotes the commitment), a same-state no-op stores nothing, and a revise that keeps the commitment carries it with the row. A blocker has no commitment row, so a blocker resolve with a `reason` is rejected as invalid input (MCP error, REST 400 with a recovery detail) instead of being dropped. The reason is memory content: it is returned only by the authenticated, tenant-scoped `GET /api/v1/memories/:id/history` (new top-level `lastResolutionReason: string | null`) and by the owner's account export, never by briefing or search, never logged (its stored and core spellings join the log redaction list), and account erasure nulls it in place alongside `owner`. The tool description is unchanged.
- a550395: `revise` gains an archive disposition (issue #217): `{ kind: "archive", memoryIds }` takes 1-50 unique memories out of the active set (`status` `active → archived`) with no successor and no edge. Content, topic, tags, `valid_from`, `valid_to` and `recorded_at` are untouched, so an archived memory stays recoverable with `status: "archived"` and through `asOf`; it leaves default ranked search, briefing and the stale-candidate queue. Each id reports its own outcome — `archived`, `already_archived` (the idempotent repeat), or `rejected` with a reason code (`not_found` for unknown and other-tenant ids, `superseded`, `open_commitment` for an open or waiting commitment, `blocker`, which leaves through `resolve`) — and runs in its own transaction, so one bad id never fails the batch. Every archived row gets an `archive` memory event with the strict payload `{ disposition: "archive", sessionRunId? }`, attributed to the transport's actor and the session run; the REST archive route now writes the same payload. Over REST the revise route's URL id is the one-element batch; the SDK's `revise()` returns the outcome list for a disposition body (overloaded, so existing callers keep their types). The tool's registered output is the new `reviseToolOutputV2Schema` union; `reviseToolOutputSchema` keeps its shape. Hard rule 1 now names the audited `active → archived` transition as its second carve-out. The tool description is unchanged (no embeddings regen).
- 38b83c9: `revise` gains a reaffirm disposition (issue #218): `{ kind: "reaffirm", memoryIds }` (the same bounded 1-50 unique batch as archive) records "reviewed, still valid". It stamps the new nullable `memories.last_reviewed_at` column (migration 0041) and writes a `reaffirm` memory event with the strict payload `{ disposition: "reaffirm", sessionRunId? }` — a new `reaffirm` event kind, with the generated `memory_events` CHECK regenerated. Nothing else changes: no new row, no edge, no status change, and content, topic, `recorded_at`, valid time and `updated_at` are untouched, so a review never poses as a revision. Briefing stale candidates now key on `GREATEST(updated_at, last_reviewed_at)`, so a reaffirmed memory leaves that section for one full stale window (30 days) and returns after it; a never-reviewed memory is judged exactly as before. Each id reports `reaffirmed` or `rejected` (`not_found`, `superseded`, `archived`). Ranked search is unchanged. The data export carries `lastReviewedAt` on every memory; account erasure leaves it (it is not content). The tool description is unchanged (no embeddings regen).
- 959ce85: Search hits now carry their filing (`scope`, nullable `project`) and, for commitments only, the lifecycle `commitmentStatus` (#319). The fields ride both MCP `search` projections (`full` and `compact`) in relevance and chronological order, the public REST `POST /api/v1/search` response, and the SDK types; the CLI labels each hit with `scope/project` and `commitment:<status>`. Memory status and commitment lifecycle are separate axes, so a resolved commitment stays a valid historical hit, now labelled instead of reading as an active instruction. Ordering, candidate sets, supersession demotion and cursors are unchanged.
- 9e3bd98: A `remember` without `scope` now lands where the account's write-scope policy says (issue #235), instead of always landing in `personal`. `configure_scope` gains a `set_write_default` action with the same shape as `set_retrieval_default`: `mode: "off"` (the default, so nothing changes until an account opts in) keeps writing `personal`, `mode: "default"` fills an omitted scope with a registered scope, and `mode: "require"` rejects an unscoped `remember` as invalid input (MCP error, REST 400 with a recovery detail) before anything is written, access- or budget-checked, or embedded. An explicit `scope` always wins. The `remember` response over MCP and REST now echoes the scope the memory was actually written to. `describe_environment` reports the effective policy as `writeScopePolicy` next to `retrievalScopePolicy`. Renaming a registry scope carries the write default along; deleting it moves the policy to `require`. Aliases are not resolved, so an alias passed to `set_write_default` is rejected as not found. New table `user_write_scope_policy` (migration 0039, RLS + FORCE RLS), included in the account export and reset by account erasure. On the native remember schema `scope` no longer carries a `personal` default, so an omitted scope survives the parse; the base remember schema used by import keeps it.

### Patch Changes

- Updated dependencies [545fb26]
- Updated dependencies [2fc6fbf]
- Updated dependencies [eef068b]
- Updated dependencies [96c5e01]
- Updated dependencies [b3d705d]
- Updated dependencies [3222da4]
- Updated dependencies [0d70e7c]
- Updated dependencies [de8ad09]
- Updated dependencies [a550395]
- Updated dependencies [38b83c9]
- Updated dependencies [959ce85]
- Updated dependencies [9e3bd98]
  - @3ngram/schema@0.12.0

## 1.8.7

No changes in this release.

## 1.8.6

### Patch Changes

- 34f1985: Bump `zod` from 4.4.3 to 4.6.5, the newest release past the 7-day release-age cooldown. Datetimes keep the zod 4.4.3 grammar: zod 4.5 began requiring seconds on any time with `Z` or an offset, so every datetime field now goes through the new `isoDateTime()` helper in `@3ngram/schema`, which supplies the 4.4.3 pattern. Minute precision such as `2026-01-01T06:15Z` still parses, the `invalid_format` issue is unchanged, and the emitted `date-time` pattern is byte-identical. `@3ngram/schema` gains two exports for this, `isoDateTime` and `IsoDateTimeOptions`. Remaining upstream changes: the email pattern is rewritten without lookaheads but accepts the same addresses (checked against 4.4.3 on edge cases such as `a..b@x.com` and `.a@x.com`); string length bounds count Unicode code points instead of UTF-16 code units, matching Postgres; a strict object with an unknown key and a bad value now reports both issues; and emitted JSON Schema (MCP `tools/list`, OpenAPI) writes a nullable primitive as `type: [T, "null"]` instead of a two-branch `anyOf`. Consumers that compose `@3ngram/schema` schemas or types with their own `zod` must move `zod` to 4.6.5 in lockstep: zod's declarations carry the minor version as a literal type, so passing a schema from one copy into another copy's `ZodType`, `z.array()` or `z.union()` fails to typecheck.
- Updated dependencies [34f1985]
  - @3ngram/schema@0.11.2

## 1.8.5

## 1.8.4

## 1.8.3

### Patch Changes

- Updated dependencies [063e312]
  - @3ngram/schema@0.11.1

## 1.8.2

## 1.8.1

## 1.8.0

### Minor Changes

- f04e568: `get_memories` items carry `supersededBy`: the direct successor (`{ id, edgeType }`, edge type `supersedes` or `updates`) when the row is superseded, `null` otherwise (current, archived, or historical without a revision edge). Superseded means not archived, closed validity and a revision edge, the precedence REST history's `lifecycleState` applies; for active rows it matches `search`'s `superseded` flag, and an imported `updates` edge on a live row still reads `null`. One hop only; lineage remains on REST `GET /api/v1/memories/:id/history` (issue #223).
- 35bff20: `revise` gains a move disposition: `{ kind: "move", predecessorId, scope?, project?, tags? }` changes a memory's filing in place. No successor and no edge are written; content, topic, status, `valid_from`, `valid_to` and `recorded_at` are untouched, so a refile neither floods the target project's recent section nor breaks `asOf` reads. The change is audited by a `revise` memory event whose payload records scope, project and tag count before and after (tags themselves stay out of the INSERT-only event table because account erasure cannot reach it). AGENTS.md hard rule 1 gains this single carve-out. Superseded and archived rows can be moved too. A move that changes nothing writes nothing. The successor kind keeps its exact shape; the input schema is now a two-branch union, and the response's `memoryType`/`topic` come from the written or moved row (issue #233). The tool's one-line description still reads "never edits in place" until the tool-selection embeddings are regenerated; the field descriptions and the concept docs carry the move semantics.

### Patch Changes

- fd10617: `revise` inherits `scope`, `project` and `tags` from the predecessor when they are omitted, instead of defaulting to `personal`, no project and no tags. A revise that left out `scope` used to move a `work` memory out of its scope and drop it from its project briefing while closing the original. Explicit values still override. The MCP and REST responses now echo the filing the successor was written with (issue #222).
- Updated dependencies [f04e568]
- Updated dependencies [fd10617]
- Updated dependencies [35bff20]
  - @3ngram/schema@0.11.0

## 1.7.0

### Patch Changes

- Updated dependencies [062c2ba]
  - @3ngram/schema@0.10.0

## 1.6.3

## 1.6.2

### Patch Changes

- Updated dependencies [a96fb41]
  - @3ngram/schema@0.9.1

## 1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [6421161]
- Updated dependencies [67b0c02]
  - @3ngram/schema@0.9.0

## 1.5.0

### Minor Changes

- 5af5010: Native writes accept optional `sessionRunId` and stamp `{ sessionRunId }` on audit events. Import still rejects the key. Unknown run ids fail the write; an explicitly closed row succeeds unattributed and is never resurrected; a stale lease resurrects then attaches, and a successful attach refreshes the lease. Concurrent writes carrying the same stale run id resurrect it exactly once — `activationEpoch` advances one step per resurrection, never one per writer, so a claim fenced at the new epoch stays valid. Omitted id uses the single leased-open session for the project. `POST /api/v1/memories/:id/archive` gains an optional body carrying the same field, and the SDK's `resolve()` takes an optional `{ sessionRunId }`. The SDK's `remember()` now takes/returns the facts-capable `RememberToolArgsV2`/`RememberToolOutputV2` types instead of the V1 pair. Resolving a commitment to the status it already holds stays idempotent but now validates a supplied `sessionRunId` too: such a request previously succeeded with an unowned or nonexistent id and is now rejected as invalid input, the same as every other native write. Lease refreshes are monotonic — a heartbeat or resurrect can only move `lastSeenAt` forward, so a slow writer cannot shorten a lease a later one already extended.

### Patch Changes

- Updated dependencies [1160f1a]
- Updated dependencies [5af5010]
- Updated dependencies [809ae0e]
- Updated dependencies [62317d9]
- Updated dependencies [1f4c763]
- Updated dependencies [54a7993]
  - @3ngram/schema@0.8.0

## 1.4.4

### Patch Changes

- Updated dependencies [33d1a7f]
  - @3ngram/schema@0.7.3

## 1.4.3

## 1.4.2

### Patch Changes

- Updated dependencies [851fa53]
  - @3ngram/schema@0.7.2

## 1.4.1

### Patch Changes

- Updated dependencies [483c658]
  - @3ngram/schema@0.7.1

## 1.4.0

### Patch Changes

- Updated dependencies [c6a819c]
- Updated dependencies [88ee7d4]
- Updated dependencies [4ed7e25]
- Updated dependencies [4cd03d4]
- Updated dependencies [1d9a420]
- Updated dependencies [318025a]
  - @3ngram/schema@0.7.0

## 1.3.0

### Patch Changes

- Updated dependencies [43a200c]
  - @3ngram/schema@0.6.4

## 1.2.7

## 1.2.6

### Patch Changes

- Updated dependencies
  - @3ngram/schema@0.6.3

## 1.2.5

### Patch Changes

- Updated dependencies [6e06cd6]
  - @3ngram/schema@0.6.2

## 1.2.4

### Patch Changes

- Updated dependencies [75ff6f4]
  - @3ngram/schema@0.6.1

## 1.2.3

## 1.2.2

## 1.2.1

## 1.2.0

### Minor Changes

- 0790813: Retrieval-scope policy wiring (issue #47, layer 3 of 3 — closes the stack). The MCP transport resolves the user's policy at most once per request (a memoized thunk over core `resolveRetrievalPolicy`, paid only by the read tools) and injects it into search/briefing/handoff; `configure_scope` gains the `set_retrieval_default` action (write-scoped; a `default` scope must exist in the registry — typed not_found otherwise) and `describe_environment` reports `retrievalScopePolicy`. Results echo `appliedScope` exactly when the policy narrowed an unscoped call (schema successors: `searchToolOutputV3Schema`, `briefingToolOutputV4Schema`, `handoffToolOutputV4Schema`, `searchRestResponseV2Schema`, `dashboardSearchResponseV2Schema` — shipped schemas byte-identical); an unscoped read under mode `require` maps to a typed invalid_input naming the registered scopes (MCP isError; REST 400 with the recovery in `detail`). REST parity: `/api/v1/search`, `/api/v1/dashboard/search`, and `/api/v1/briefing` ride the same injected policy. The SDK and CLI preserve recovery detail, and human CLI search output reports a policy-applied scope. Docs, OpenAPI, the MCP reference, and the transport-cost fixture are regenerated in lockstep (frozen totals updated); the golden-set eval gate holds at floors.

### Patch Changes

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

## 1.1.3

## 1.1.2

## 1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies [d5080cd]
- Updated dependencies [b88a6fa]
  - @3ngram/schema@0.5.0

## 1.0.2

### Patch Changes

- e18e4a2: Bound every non-health HTTP surface with a coarse per-IP rate limit and replace trailing-slash regular expressions with linear-time normalization.

## 1.0.1

## 1.0.0

### Major Changes

- b956a15: Release the stable 3ngram v1 product line: MCP and REST server, worker,
  TypeScript SDK, and bare `3ngram` CLI.

### Patch Changes

- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
  - @3ngram/schema@0.4.1

## 0.8.0

### Minor Changes

- ec1b0b4: Publish the CLI (as the bare `3ngram` package) and `@3ngram/sdk` to public npm. The CLI package is renamed from `@3ngram/cli` to `3ngram` so `npx 3ngram` works directly; both packages join the fixed release group with server/worker.

## 0.0.4

### Patch Changes

- Updated dependencies [fb2487a]
  - @3ngram/schema@0.4.0

## 0.0.3

Initial public release.
