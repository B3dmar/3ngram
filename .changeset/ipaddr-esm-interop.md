---
'@3ngram/core': patch
---

Fix every CIMD client resolution failing under a real ESM runtime.

`client-metadata.ts` imported `ipaddr.js` as a namespace (`import * as ipaddr`). That package is CommonJS with `module.exports = ipaddr` and no `exports` map, so Node's ESM interop — which relies on `cjs-module-lexer` finding statically scannable assignments — synthesizes no usable named exports. Every member of the namespace was `undefined` at runtime, so the first call, `ipaddr.isValid(...)` in `resolveHostnameDefault`, threw a `TypeError`. `resolvePublicTarget` catches any resolver throw and relabels it `dns_failure`, so **every** Client ID Metadata Document resolution failed — for hostnames and IP literals alike, with no network I/O — and surfaced to the client as a bare `400 invalid_client` attributed to DNS.

Vitest never saw this: Vite pre-bundles CJS dependencies through its own interop and synthesizes the named exports, so the module shape under test was not the shape the deployment got. The import is now a default import, and `scripts/check-cjs-namespace-imports.mjs` (wired into the `workspace-checks` CI lane) imports every namespace-imported bare specifier under real Node ESM resolution and fails when a member the source uses is missing from the namespace. Detection is by member use rather than export count, because `ipaddr.js`'s namespace is not empty — the lexer emits a literal key named `module.exports`, which makes "has some named export" a false pass.
