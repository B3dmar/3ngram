---
"@3ngram/server": patch
"@3ngram/config": patch
"@3ngram/core": patch
---

Bump runtime dependencies to the newest releases past the 7-day release-age cooldown: `nodemailer` 10.0.12 -> 10.0.16 and `rate-limiter-flexible` 11.2.0 -> 11.2.1 in `@3ngram/server`, `pino` 10.3.1 -> 10.4.0 in `@3ngram/config`, and `@node-rs/argon2` 2.0.2 -> 2.2.2, `ipaddr.js` 2.4.0 -> 2.5.0 and `jose` 6.2.3 -> 6.2.12 in `@3ngram/core`. `@node-rs/argon2` 2.1.0 swapped its Rust backend from RustCrypto to argon2-rust; password hashes keep the same PHC format and parameters, and a unit test now verifies a hash minted by 2.0.2. 2.2.2 also drops the `wasm32-wasi` fallback package, so a platform without a prebuilt native binding (all linux gnu/musl x64/arm64, darwin and win32 targets still have one) no longer falls back to WASM. `ipaddr.js` 2.5.0 rejects malformed IPv6 literals it used to accept (a `::` that compresses no group, a group longer than four hex digits), which only narrows what the client-metadata fetch treats as an IP literal. `jose` 6.2.5-6.2.10 tighten JWS/JWT input validation; the RS256 access tokens this package signs and verifies are unaffected.
