---
"@3ngram/server": patch
"@3ngram/worker": patch
---

Clear the release image scan that blocked v1.8.3. New advisories landed after v1.8.2: perl-base CVE-2026-13221 (critical), libpcre2-8-0 CVE-2026-103111 (high), proxy-addr CVE-2026-90711 (critical) and two nodemailer advisories (CVE-2026-90776, GHSA-v53p-9fqp-m79j). Both images move to the current `node:24-bookworm-slim` digest (libpcre2 10.42-1+deb12u2) and upgrade perl-base to 5.36.0-7+deb12u4 from Debian security until the base image catches up; proxy-addr is overridden to 2.0.8; nodemailer moves to 10.0.12, which keeps the transport API, requires Node 20+, and ships its own types, so `@types/nodemailer` is dropped.
