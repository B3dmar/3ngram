---
'@3ngram/core': minor
'@3ngram/server': patch
---

Fix CIMD client resolution failing closed on IPv4-mapped DNS answers, and record why an `/oauth/authorize` request was rejected.

`resolvePublicTarget` compared the DNS-reported address family against `ipaddr.process()`, which UNMAPS `::ffff:a.b.c.d` to its IPv4 form. A resolver reports that answer as family 6, so the unmapped kind (`ipv4` → 4) disagreed with it and a perfectly self-consistent answer was treated as forged: every Client ID Metadata Document fetch on such a resolver failed closed with `unsafe_address` before a socket was opened, surfacing as a bare `400 { "error": "invalid_client" }`. The agreement check now uses `ipaddr.parse()`, which preserves the wire form. The security boundary is unchanged — `isPublicClientMetadataAddress()` still unmaps via `process()`, so a mapped loopback or private answer is still rejected.

`/oauth/authorize` now emits one structured, content-free line per REJECTED request (`oauth: authorize endpoint`) carrying a hashed `client_id_prefix` and a closed-set `reason` — `not_registered`, `metadata_*` for each CIMD failure class, `metadata_not_materialized`, `unsupported_grant_type`, or `redirect_uri_mismatch`. Previously every one of those returned an identical bare 400 with nothing written anywhere, so a stale registration and a metadata document that never loaded were indistinguishable in production logs. The response is unchanged (still a uniform `invalid_client`, no enumeration oracle); the reason is diagnostic only.

`resolveOAuthClient()` takes a new optional `options.onFailure` callback carrying the `ClientResolutionFailure` reason. Existing two-argument callers are unaffected.
