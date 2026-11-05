---
"@3ngram/server": patch
"@3ngram/worker": patch
---

Clear the release image scan that blocked the 2026-11-05 promotion: apt and libapt-pkg6.0 2.6.1 in the pinned base carry CVE-2026-109518 (high). Both images move to the current `node:24-bookworm-slim` digest, which ships apt 2.6.2 and perl-base 5.36.0-7+deb12u4 on Node 24.22.2, so the pinned perl-base upgrade step is dropped.
