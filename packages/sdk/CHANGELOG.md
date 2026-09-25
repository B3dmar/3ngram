# @3ngram/sdk

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
