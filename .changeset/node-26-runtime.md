---
"@3ngram/server": patch
"@3ngram/worker": patch
---

Build and run the server and worker images on Node 26 Active LTS (`node:26.13.1-bookworm-slim`, digest-pinned), up from Node 24. Node 26 no longer ships corepack, so the images install the pinned pnpm with npm. `engines.node` is unchanged: the published packages still support Node 22, 24 and 26.
