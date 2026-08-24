# @3ngram/sdk

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
