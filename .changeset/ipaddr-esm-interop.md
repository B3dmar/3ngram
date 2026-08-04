---
'@3ngram/core': patch
---

Fix every CIMD client resolution failing under a real ESM runtime.

`client-metadata.ts` imported `ipaddr.js` as a namespace (`import * as ipaddr`). That package is CommonJS with `module.exports = ipaddr` and no `exports` map, so Node's ESM interop — which relies on `cjs-module-lexer` finding statically scannable assignments — synthesizes no usable named exports. Every member of the namespace was `undefined` at runtime, so the first call, `ipaddr.isValid(...)` in `resolveHostnameDefault`, threw a `TypeError`. `resolvePublicTarget` catches any resolver throw and relabels it `dns_failure`, so **every** Client ID Metadata Document resolution failed — for hostnames and IP literals alike, with no network I/O — and surfaced to the client as a bare `400 invalid_client` attributed to DNS.

Vitest never saw this: Vite pre-bundles CJS dependencies through its own interop and synthesizes the named exports, so the module shape under test was not the shape the deployment got.

The import is now a default import. `scripts/check-cjs-namespace-imports.mjs` guards the class: it imports every namespace-imported bare specifier through real Node ESM resolution (a throwaway sibling module, not `createRequire().resolve()`, which would select the `require` export condition and check a different file than `import` loads for a dual package) and fails when a member the source uses is absent. Detection is by member use rather than export count, because `ipaddr.js`'s namespace is not empty — the lexer emits a literal key named `module.exports`, which makes "has some named export" a false pass — and covers destructuring (`const { isValid } = ipaddr`) as well as property access, since both yield `undefined` in production.

The script is **not yet wired into CI**: adding the `workspace-checks` step requires a token with `workflow` scope. Until that lands it runs manually via `node scripts/check-cjs-namespace-imports.mjs`.
