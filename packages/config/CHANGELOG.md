# @3ngram/config

## 0.2.6

### Patch Changes

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

## 0.2.5

### Patch Changes

- Keep `engines.node` at `>=22`. The Node 24 work should only have moved what we build, test and ship on — CI and the container base — not what consumers must run. Nothing in this closure uses a Node 24 feature, and Node 22 is supported upstream until 2027-04-30, so raising the published floor would have hard-failed Node 22 consumers on a patch release. Raising it becomes a deliberate major when there is a reason.

## 0.2.4

### Patch Changes

- 6e06cd6: Build, test and ship on Node 24 (Active LTS). CI, the release workflow and the server image base move to Node 24 — `node:24-bookworm-slim`, digest-pinned. `engines.node` deliberately stays `>=22`: nothing here requires a Node 24 feature, so consumers on Node 22 (supported until 2027-04-30) remain supported.

## 0.2.3

### Patch Changes

- 310e515: Make the production `DATABASE_URL` role-name check honor the `RUNTIME_DB_ROLE` environment variable (defaulting to `app_user`), matching the RLS readiness guard. A deployment whose runtime connects as a differently-named `NOBYPASSRLS` role now passes env validation instead of being rejected for not using `app_user`.

## 0.2.2

### Patch Changes

- 69a66b3: Add RFC 9207 issuer identification to OAuth authorization responses and metadata.
- dcc98b7: Add modern MCP catalog cache hints and bounded pre-parser header observability.

## 0.2.1

### Patch Changes

- b956a15: Reject the public self-host `LOG_HASH_SALT` placeholder when production configuration is parsed.
- b956a15: Ship complete public package metadata, package-level license and notice files,
  and focused package READMEs. Add a working `3ngram --version` command.

## 0.2.0

### Minor Changes

- fb2487a: Reshape into a clean, self-hostable OSS core. Remove the billing/subscription surface and replace the `CloudExtension` seam with a neutral `Extension` seam (`resolveLimits` / `AccessGate` / `onAccountDeletion` / export enricher), all with no-op self-host defaults. Keep the budget cost-cap as a self-host feature. Consolidate docs into a single Mintlify tree and make CI fork-friendly (pgvector service container instead of hosted branches).

## 0.1.1

Initial public release.
