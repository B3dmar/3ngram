---
'@3ngram/core': patch
'@3ngram/schema': patch
'@3ngram/server': patch
---

Accept the ephemeral loopback port a native MCP client binds at `/oauth/authorize` (RFC 8252 §7.3), which unblocks Claude Code.

Claude Code authenticates through a Client ID Metadata Document whose `redirect_uris` carry no port — `http://localhost/callback` and `http://127.0.0.1/callback` — and then presents `redirect_uri=http://localhost:<ephemeral>/callback`, because a native client cannot know its loopback port until it binds one. `resolveRegisteredRedirectUri` required a byte-exact match, so every Claude Code authorization ended as `400 invalid_client` with `reason=redirect_uri_mismatch` in the audit line. RFC 8252 §7.3 says the authorization server MUST allow any port at request time for loopback redirect URIs; exact matching violated that.

A presented redirect URI now also matches when a registered URI is `http` on the same loopback host and the raw path and query are identical — the port alone may differ, on either side, so a registration that named a port no longer pins it. Hosts are compared as the URL parser normalizes them (`LOCALHOST` is `localhost`), but `localhost`, `127.0.0.1` and `[::1]` are three distinct hosts and never cross-match. Everything else is unchanged and still byte-exact: `https` URIs, non-loopback `http`, any difference in path or query, a fragment, and smuggled userinfo.

The path and query are compared as PRESENTED rather than as URL-normalized components, so `/x/../callback` never matches `/callback`. That only holds while the raw string delimits the authority the way the parser does, so a URI carrying a character the RFC 3986 grammar forbids — a backslash above all, which the WHATWG parser reads as `/` — is refused outright instead of matched, and the authority ends at the first `/` OR `?`. Without those two rules `http://localhost\@evil.com/callback` and `http://localhost:5000?evil=1` would have matched registrations that named neither path nor query.

`http://[::1]/callback` is now registrable: `redirectUriSchema` allowed http on `localhost` and `127.0.0.1` only, so an IPv6-only native client — which can bind no other loopback literal — was rejected at registration (DCR) or at its metadata document (CIMD) before port matching could ever run. RFC 8252 §7.3 names all three literals. The pattern is applied to WHATWG `URL.hostname`, which arrives bracketed and canonicalized, so matching `[::1]` admits every spelling of the IPv6 loopback and no other address; `[::2]`, `[fe80::1]` and `[::ffff:127.0.0.1]` are still rejected, and the presented string is still stored unmodified.

The REQUESTED URI (ephemeral port included) becomes the effective redirect URI: it is what the 302 targets, what the authorization code is bound to, and what `/oauth/token` compares its `redirect_uri` against — so the client's own value round-trips unchanged. Resolution is idempotent, which is what the consent POST relies on when it re-resolves the hidden `redirect_uri` field. The omitted-`redirect_uri` path (exactly one registered URI) is untouched.
