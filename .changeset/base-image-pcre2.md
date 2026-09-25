---
"@3ngram/server": patch
"@3ngram/worker": patch
---

Release images move to the current `node:24-bookworm-slim` digest, which carries libpcre2 10.42-1+deb12u1. The v1.8.0 release scan rejected the previous pinned digest on CVE-2026-86145 (libpcre2-8-0, high), so that tag is burned and v1.8.1 carries its content.
