---
"@3ngram/server": patch
---

Pick up the patched `@hono/node-server` (1.19.14 → 1.19.17) for GHSA-frvp-7c67-39w9.

The advisory is a `serve-static` path traversal reachable on Windows through an encoded backslash. `@hono/node-server` is not a declared dependency of this package — it arrives transitively as a regular dependency of `@modelcontextprotocol/node`, which the MCP HTTP transport relies on — so the fix lands as a scoped root override (`@hono/node-server@<1.19.15: ^1.19.15`) rather than a manifest bump. The workspace lockfile is what pins it, and the published `ghcr.io/b3dmar/3ngram` image builds from that lockfile, so the image carries the patched version from this release forward. The resolution is 1.19.17 rather than the advisory's 1.19.15 because 1.19.16 was never published.

No source in this package changed, and no runtime behaviour moves with it. Consumers who resolve their own dependency graph rather than running the published image should confirm their own `@hono/node-server` resolves to >= 1.19.15 — an override or a lockfile refresh, since the vulnerable version is reached transitively there too.
