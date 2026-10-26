# @3ngram/cli

## 1.10.1

### Patch Changes

- @3ngram/sdk@1.10.1

## 1.10.0

### Patch Changes

- Updated dependencies [48dcb4a]
- Updated dependencies [7dec400]
  - @3ngram/schema@0.13.0
  - @3ngram/sdk@1.10.0

## 1.9.1

### Patch Changes

- 48b8972: Security: zod 4.6.6 (CVE-2023-54404, denial of service via unbounded array validation) on every package that pins it, and body-parser 2.4.0 under express (CVE-2026-111181, denial of service via an unhandled decompression stream error) through the workspace advisory override. The v1.9.0 release image scan blocked publication on both. body-parser 2.4.0 is newer than the 7-day registry cooldown, so it is a reviewed exact-version `minimumReleaseAgeExclude` entry until it matures. No API or behaviour change.
- Updated dependencies [48b8972]
  - @3ngram/schema@0.12.1
  - @3ngram/sdk@1.9.1

## 1.9.0

### Minor Changes

- 3222da4: Native `remember` can now record a commitment's deadline and owner (issue #165). A `commitment` write over MCP, REST (`POST /api/v1/memories`), the SDK or the CLI (`--due`, `--owner`) accepts an optional explicit `dueAt` (ISO-8601 instant, at most millisecond precision) and `owner`. Both are written onto the auto-created commitment row in the same transaction, so briefing reports the commitment overdue once the deadline passes and the surfacing sweep expires it after the grace window, exactly as for imported commitments. Either field on a non-commitment is rejected rather than dropped, and nothing is inferred from the content: an undated commitment stays undated. A `revise` keeps the deadline, owner and commitment identity with the successor. No migration; the columns already existed.
- de8ad09: `resolve` accepts an optional `reason` (issue #234) on MCP, `POST /api/v1/memories/:id/resolve` and the SDK (`client.resolve(id, status, { reason })`), so whoever settles a commitment can say what settled it — a PR number, "superseded by X" — in the same call. The reason is trimmed and must be 1–500 characters; an empty or longer one is rejected as invalid input before anything is written. It is stored on the commitment row (new nullable column `commitments.last_resolution_reason`, migration 0040, with a length CHECK generated from the schema bound) in the same transaction as the status change, never in the append-only audit event payload, which keeps carrying only `sessionRunId`. A reason explains one transition: any later status change without one clears it (including the surfacing sweep's expiry and a revise that demotes the commitment), a same-state no-op stores nothing, and a revise that keeps the commitment carries it with the row. A blocker has no commitment row, so a blocker resolve with a `reason` is rejected as invalid input (MCP error, REST 400 with a recovery detail) instead of being dropped. The reason is memory content: it is returned only by the authenticated, tenant-scoped `GET /api/v1/memories/:id/history` (new top-level `lastResolutionReason: string | null`) and by the owner's account export, never by briefing or search, never logged (its stored and core spellings join the log redaction list), and account erasure nulls it in place alongside `owner`. The tool description is unchanged.
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
  - @3ngram/sdk@1.9.0

## 1.8.7

### Patch Changes

- @3ngram/sdk@1.8.7

## 1.8.6

### Patch Changes

- Updated dependencies [34f1985]
  - @3ngram/schema@0.11.2
  - @3ngram/sdk@1.8.6

## 1.8.5

### Patch Changes

- @3ngram/sdk@1.8.5

## 1.8.4

### Patch Changes

- @3ngram/sdk@1.8.4

## 1.8.3

### Patch Changes

- Updated dependencies [063e312]
  - @3ngram/schema@0.11.1
  - @3ngram/sdk@1.8.3

## 1.8.2

### Patch Changes

- @3ngram/sdk@1.8.2

## 1.8.1

### Patch Changes

- @3ngram/sdk@1.8.1

## 1.8.0

### Patch Changes

- Updated dependencies [f04e568]
- Updated dependencies [fd10617]
- Updated dependencies [35bff20]
  - @3ngram/schema@0.11.0
  - @3ngram/sdk@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [062c2ba]
  - @3ngram/schema@0.10.0
  - @3ngram/sdk@1.7.0

## 1.6.3

### Patch Changes

- @3ngram/sdk@1.6.3

## 1.6.2

### Patch Changes

- Updated dependencies [a96fb41]
  - @3ngram/schema@0.9.1
  - @3ngram/sdk@1.6.2

## 1.6.1

### Patch Changes

- @3ngram/sdk@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [6421161]
- Updated dependencies [67b0c02]
  - @3ngram/schema@0.9.0
  - @3ngram/sdk@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [1160f1a]
- Updated dependencies [5af5010]
- Updated dependencies [809ae0e]
- Updated dependencies [62317d9]
- Updated dependencies [1f4c763]
- Updated dependencies [54a7993]
  - @3ngram/schema@0.8.0
  - @3ngram/sdk@1.5.0

## 1.4.4

### Patch Changes

- Updated dependencies [33d1a7f]
  - @3ngram/schema@0.7.3
  - @3ngram/sdk@1.4.4

## 1.4.3

### Patch Changes

- @3ngram/sdk@1.4.3

## 1.4.2

### Patch Changes

- Updated dependencies [851fa53]
  - @3ngram/schema@0.7.2
  - @3ngram/sdk@1.4.2

## 1.4.1

### Patch Changes

- Updated dependencies [483c658]
  - @3ngram/schema@0.7.1
  - @3ngram/sdk@1.4.1

## 1.4.0

### Patch Changes

- Updated dependencies [c6a819c]
- Updated dependencies [88ee7d4]
- Updated dependencies [4ed7e25]
- Updated dependencies [4cd03d4]
- Updated dependencies [1d9a420]
- Updated dependencies [318025a]
  - @3ngram/schema@0.7.0
  - @3ngram/sdk@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [43a200c]
  - @3ngram/schema@0.6.4
  - @3ngram/sdk@1.3.0

## 1.2.7

### Patch Changes

- @3ngram/sdk@1.2.7

## 1.2.6

### Patch Changes

- Updated dependencies
  - @3ngram/schema@0.6.3
  - @3ngram/sdk@1.2.6

## 1.2.5

### Patch Changes

- Updated dependencies [6e06cd6]
  - @3ngram/schema@0.6.2
  - @3ngram/sdk@1.2.5

## 1.2.4

### Patch Changes

- Updated dependencies [75ff6f4]
  - @3ngram/schema@0.6.1
  - @3ngram/sdk@1.2.4

## 1.2.3

### Patch Changes

- @3ngram/sdk@1.2.3

## 1.2.2

### Patch Changes

- @3ngram/sdk@1.2.2

## 1.2.1

### Patch Changes

- @3ngram/sdk@1.2.1

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
  - @3ngram/sdk@1.2.0

## 1.1.3

### Patch Changes

- @3ngram/sdk@1.1.3

## 1.1.2

### Patch Changes

- @3ngram/sdk@1.1.2

## 1.1.1

### Patch Changes

- @3ngram/sdk@1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies [d5080cd]
- Updated dependencies [b88a6fa]
  - @3ngram/schema@0.5.0
  - @3ngram/sdk@1.1.0

## 1.0.2

### Patch Changes

- e18e4a2: Bound every non-health HTTP surface with a coarse per-IP rate limit and replace trailing-slash regular expressions with linear-time normalization.
- Updated dependencies [e18e4a2]
  - @3ngram/sdk@1.0.2

## 1.0.1

### Patch Changes

- @3ngram/sdk@1.0.1

## 1.0.0

### Major Changes

- b956a15: Release the stable 3ngram v1 product line: MCP and REST server, worker,
  TypeScript SDK, and bare `3ngram` CLI.

### Patch Changes

- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
- Updated dependencies [b956a15]
  - @3ngram/sdk@1.0.0
  - @3ngram/schema@0.4.1

## 0.8.0

### Minor Changes

- ec1b0b4: Publish the CLI (as the bare `3ngram` package) and `@3ngram/sdk` to public npm. The CLI package is renamed from `@3ngram/cli` to `3ngram` so `npx 3ngram` works directly; both packages join the fixed release group with server/worker.

### Patch Changes

- Updated dependencies [ec1b0b4]
  - @3ngram/sdk@0.8.0

## 0.0.4

### Patch Changes

- Updated dependencies [fb2487a]
  - @3ngram/schema@0.4.0
  - @3ngram/sdk@0.0.4

## 0.0.3

Initial public release.
